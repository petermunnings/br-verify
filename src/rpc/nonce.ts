// The optional nonce check. It runs only when the approver types an RPC URL and asks for it.
// Plain fetch JSON-RPC, three read-only calls. It never changes MATCH or MISMATCH.
export type NonceStatus = 'in order' | 'already used' | 'ahead' | 'chain mismatch' | 'error';
export interface NonceResult { status: NonceStatus; text: string; latest?: number; pending?: number }

export const CHAIN_1_RPC_NOTE = "This result comes from the RPC you entered. br-verify can't confirm that it is the fork. " +
  'A nonce from real Ethereum mainnet says nothing about the fork.';

type Fetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

async function call(f: Fetch, url: string, method: string, params: unknown[]): Promise<string> {
  const res = await f(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', cache: 'no-store',
    referrerPolicy: 'no-referrer', redirect: 'error', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? 'RPC error'}`);
  if (typeof body.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body.result)) throw new Error(`${method}: not a hex quantity`);
  return body.result;
}

export async function checkNonce(url: string, from: string, chainId: number, nonce: number, f: Fetch = fetch as Fetch): Promise<NonceResult> {
  const note = chainId === 1 ? ` ${CHAIN_1_RPC_NOTE}` : '';
  if (!/^https?:\/\/[^\s]+$/i.test(url.trim())) return { status: 'error', text: 'Type an http or https RPC URL.' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(from.trim())) return { status: 'error', text: 'Enter "from" (the sending key\'s address) to check its nonce.' };
  try {
    const rpcChain = Number(BigInt(await call(f, url.trim(), 'eth_chainId', [])));
    if (rpcChain !== chainId) return { status: 'chain mismatch', text: `The RPC is on chain ${rpcChain}, but the payload is for chain ${chainId}. Nonce not checked.` };
    const latest = Number(BigInt(await call(f, url.trim(), 'eth_getTransactionCount', [from.trim(), 'latest'])));
    const pending = Number(BigInt(await call(f, url.trim(), 'eth_getTransactionCount', [from.trim(), 'pending'])));
    const base = `Next nonce on chain: ${latest}${pending !== latest ? ` (${pending} counting pending transactions)` : ''}; this request: ${nonce}.`;
    const status: NonceStatus = nonce === latest ? 'in order' : nonce < latest ? 'already used' : 'ahead';
    const what = { 'in order': 'In order.', 'already used': 'Already used: this request can never be mined. Reject.', 'ahead': 'Ahead: earlier transactions from this key are not mined yet.' }[status];
    return { status, text: `${base} ${what}${note}`, latest, pending };
  } catch (e) {
    return { status: 'error', text: `The RPC check failed: ${e instanceof Error ? e.message : String(e)}.${note}` };
  }
}
