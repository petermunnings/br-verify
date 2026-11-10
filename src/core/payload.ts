// Reads the payload text an approver pasted, and parses it as an unsigned EIP-1559 transaction.
// Fails closed: anything that isn't exactly a canonical unsigned EIP-1559 transaction is refused.
import { bytesToHex, getAddress, hexToBytes, parseTransaction, serializeTransaction, type Address, type Hex } from 'viem';

export type Encoding = 'hex' | 'base64' | 'base64 of hex';
export interface Reading { encoding: Encoding; bytes: Uint8Array }

/** The transaction fields, normalised: every field present, amounts as bigint. */
export interface Tx {
  chainId: number; nonce: number; maxPriorityFeePerGas: bigint; maxFeePerGas: bigint; gas: bigint;
  to: Address | null; value: bigint; data: Hex; accessList: { address: Address; storageKeys: Hex[] }[];
}

export type Parsed =
  | { ok: true; tx: Tx; payload: Hex }
  | { ok: false; verdict: 'CANNOT VERIFY' | 'BARE HASH'; reason: string };

const HEX = /^[0-9a-fA-F]*$/;
const B64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

function fromBase64(text: string): Uint8Array | null {
  if (!B64.test(text)) return null;
  const body = text.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (body.length % 4 === 1) return null;
  try {
    return Uint8Array.from(atob(body + '='.repeat((4 - (body.length % 4)) % 4)), (c) => c.charCodeAt(0));
  } catch { return null; }
}

function asHexText(bytes: Uint8Array): Uint8Array | null {
  const text = new TextDecoder().decode(bytes).replace(/^0x/i, '');
  return text.length > 0 && text.length % 2 === 0 && HEX.test(text) ? hexToBytes(`0x${text}`) : null;
}

function base64Reading(text: string): Reading | null {
  const bytes = fromBase64(text);
  if (bytes === null || bytes.length === 0) return null;
  const inner = asHexText(bytes);
  return inner ? { encoding: 'base64 of hex', bytes: inner } : { encoding: 'base64', bytes };
}

/**
 * Every plausible reading of the pasted text. One reading: use it. Two: both parse as an
 * EIP-1559 transaction and the approver must choose. Empty: the text is neither hex nor base64.
 */
export function readPayloadText(raw: string): Reading[] {
  const text = raw.replace(/\s+/g, '').replace(/^0x/i, '');
  const hex = text.length % 2 === 0 && HEX.test(text) ? { encoding: 'hex' as const, bytes: hexToBytes(`0x${text}`) } : null;
  if (hex && (hex.bytes.length === 0 || hex.bytes[0] === 0x02)) return [hex];
  const b64 = base64Reading(text);
  if (!hex) return b64 ? [b64] : [];
  if (!b64) return [hex];
  const parsing = [hex, b64].filter((r) => parsePayload(r.bytes).ok);
  return parsing.length > 0 ? parsing : [hex];
}

const PREFIX_191 = new TextEncoder().encode('\x19Ethereum Signed Message:\n');
const startsWith = (b: Uint8Array, p: Uint8Array) => b.length >= p.length && p.every((x, i) => b[i] === x);
const no = (reason: string): Parsed => ({ ok: false, verdict: 'CANNOT VERIFY', reason });

/** Parses the payload bytes. Only a canonical unsigned EIP-1559 transaction is `ok`. */
export function parsePayload(bytes: Uint8Array): Parsed {
  if (bytes.length === 0) return no('the payload is empty');
  if (bytes.length === 32) return { ok: false, verdict: 'BARE HASH', reason: 'a 32-byte payload is a bare hash' };
  if (bytes.length === 66 && bytes[0] === 0x19 && bytes[1] === 0x01) {
    return no('typed-data (EIP-712) payload; not supported in this version');
  }
  if (startsWith(bytes, PREFIX_191)) return no('signed-message (EIP-191) payload; not supported in this version');
  if (bytes[0] !== 0x02) return no(`not an EIP-1559 transaction (first byte 0x${bytes[0]!.toString(16).padStart(2, '0')})`);
  const payload = bytesToHex(bytes);
  let p: ReturnType<typeof parseTransaction>;
  try { p = parseTransaction(payload); } catch (e) {
    return no(`the payload doesn't parse: ${(e as { shortMessage?: string }).shortMessage ?? String(e)}`);
  }
  if (p.type !== 'eip1559') return no('not an EIP-1559 transaction');
  if (p.r !== undefined || p.s !== undefined || p.yParity !== undefined || p.v !== undefined) {
    return no('this is a signed transaction, not the payload from DETAILS');
  }
  const tx: Tx = {
    chainId: p.chainId, nonce: p.nonce ?? 0, maxPriorityFeePerGas: p.maxPriorityFeePerGas ?? 0n,
    maxFeePerGas: p.maxFeePerGas ?? 0n, gas: p.gas ?? 0n, to: p.to ? getAddress(p.to) : null, value: p.value ?? 0n,
    data: p.data ?? '0x', accessList: (p.accessList ?? []).map((e) => ({ address: getAddress(e.address), storageKeys: [...e.storageKeys] })),
  };
  if (serializeTx(tx) !== payload) return no('the payload is not canonically encoded (it does not re-serialise to the same bytes)');
  return { ok: true, tx, payload };
}

/** The unsigned EIP-1559 serialisation of `tx`: what the HSM signs. */
export const serializeTx = (tx: Tx): Hex =>
  serializeTransaction({ type: 'eip1559', ...tx, to: tx.to ?? undefined });
