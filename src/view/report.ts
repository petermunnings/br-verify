// Turns a reading and the expected fields into the verdict, the decoded view and the result record.
// Shared by the web page and the CLI. Presentation only: every decision is made in src/core.
import { formatEther, formatGwei, isHex, keccak256, type Hex } from 'viem';
import type { Notes } from '../adapters/index.js';
import { compare, type Expected, type Result, type Verdict } from '../core/compare.js';
import { decode, type Decoded } from '../core/decode.js';
import { parsePayload, type Parsed, type Reading, type Tx } from '../core/payload.js';

declare const __BR_VERSION__: string | undefined;
declare const __BR_COMMIT__: string | undefined;
export const VERSION = typeof __BR_VERSION__ === 'string' ? __BR_VERSION__ : 'dev';
export const COMMIT = typeof __BR_COMMIT__ === 'string' ? __BR_COMMIT__ : 'dev';

export const FROM_NOTE = 'as entered, not part of the payload: check that the key named in DETAILS (signKeyName) has this address';
export const FOOTER = 'br-verify checks that the payload matches what you entered. It does not judge whether the transaction is a good idea. If anything differs from the Linear ticket, reject.';

export interface Report { reading: Reading; parsed: Parsed; decoded: Decoded | null; result: Result; expected: Expected; notes: Notes }

export function verify(reading: Reading, expected: Expected = {}, notes: Notes = {}): Report {
  const parsed = parsePayload(reading.bytes);
  const decoded = parsed.ok ? decode(parsed.tx, parsed.payload, expected.call?.signature) : null;
  return { reading, parsed, decoded, result: compare(parsed, expected), expected, notes };
}

export const LABELS: Record<string, string> = {
  chainId: 'chain ID', nonce: 'nonce', maxPriorityFeePerGas: 'max priority fee', maxFeePerGas: 'max fee', gas: 'gas limit',
  to: 'to', value: 'value', data: 'data', accessList: 'access list', expectedAddress: 'expected (CREATE) address', function: 'function',
};
export const label = (f: string) => LABELS[f] ?? f;

export type Tone = 'green' | 'red' | 'amber' | 'grey';
export function verdictText(r: Result): { tone: Tone; headline: string; detail: string } {
  const how = r.dataComparedBy === 'keccak256' ? 'data compared by keccak256 (init-code hash)' : 'data compared as bytes';
  const table: Record<Verdict, [Tone, string, string]> = {
    'MATCH': ['green', 'MATCH: the payload is the transaction you entered', `Every transaction field was compared; ${how}.`],
    'MISMATCH': ['red', 'MISMATCH: reject the request', r.differences.map((d) => `${label(d.field)}: expected ${d.expected}, payload has ${d.actual}`).join('\n')],
    'PARTIAL': ['amber', 'PARTIAL: the fields you entered match', `Not compared: ${r.notCompared.map(label).join(', ')}. Check those against the ticket.`],
    'NOT COMPARED': ['grey', 'NOT COMPARED: decoded only', 'Nothing was compared. Check every field against the Linear ticket.'],
    'CANNOT VERIFY': ['red', "CANNOT VERIFY: br-verify can't verify this payload", `${r.reason}. Reject unless the ticket explains why.`],
    'BARE HASH': ['red', 'BARE HASH: reject', 'This is a bare hash. Reject (key policy).'],
  };
  const [tone, headline, detail] = table[r.verdict];
  return { tone, headline, detail };
}

export const grp = (n: number | bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const eth = (wei: bigint) => `${grp(wei)} wei (${formatEther(wei)} ETH)`;
const gwei = (wei: bigint) => `${grp(wei)} wei (${formatGwei(wei)} gwei)`;
const size = (h: Hex) => (h.length - 2) / 2;
export const preview = (h: Hex) => (size(h) <= 32 ? h : `${h.slice(0, 34)}…${h.slice(-32)}`);

/** An argument for display: integers in full decimal, long bytes as length and keccak256. */
export function arg(v: unknown): string {
  if (typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return isHex(v) && size(v as Hex) > 64 ? `${grp(size(v as Hex))} bytes, keccak256 ${keccak256(v as Hex)}` : JSON.stringify(v).slice(1, -1) === v ? v : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(arg).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${k}: ${arg(x)}`).join(', ')}}`;
  return String(v);
}

export type Row = [label: string, value: string];

/** The decoded view, in the order the approver checks it. */
export function decodedRows(rep: Report): Row[] {
  if (!rep.parsed.ok || !rep.decoded) return [];
  const tx: Tx = rep.parsed.tx;
  const d = rep.decoded;
  const rows: Row[] = [
    ['Chain', tx.chainId === 1 ? d.chain.name : `${tx.chainId}: ${d.chain.name}`],
    ['Kind', d.kind],
    ['To', tx.to === null ? 'none (contract creation)' : rep.notes.toName ? `${tx.to} (${rep.notes.toName}: name as entered, not verified)` : tx.to],
  ];
  if (d.kind === 'contract creation') {
    rows.push(['Init code', `${grp(d.dataBytes)} bytes`], ['Init-code hash', d.dataHash]);
    if (rep.result.createAddress) rows.push(['CREATE address', `${rep.result.createAddress} (from ${rep.expected.from}, ${FROM_NOTE})`]);
  } else if (d.call?.decoded) {
    rows.push(['Function', `${d.call.signature} (${d.call.selector})`]);
    d.call.args.forEach((a, i) => rows.push([`  ${i + 1}. ${a.name || 'argument'} (${a.type})`, arg(a.value)]));
  } else if (d.call) {
    rows.push(['Function', `${d.call.selector}: ${d.call.note}`]);
  }
  rows.push(
    ['Value', eth(tx.value)], ['Nonce', String(tx.nonce)], ['Gas limit', grp(tx.gas)],
    ['Max fee', gwei(tx.maxFeePerGas)], ['Max priority fee', gwei(tx.maxPriorityFeePerGas)],
    ['Most it can cost', `${formatEther(d.maxCost)} ETH (gas limit × max fee)`],
    ['Access list', tx.accessList.length === 0 ? 'empty' : tx.accessList.map((e) => `${e.address} [${e.storageKeys.join(', ')}]`).join('; ')],
    ['Data', `${grp(d.dataBytes)} bytes, keccak256 ${d.dataHash}`],
    ['Data preview', d.dataBytes === 0 ? 'none' : preview(tx.data)],
    ['Payload', `${grp(d.payloadBytes)} bytes, read as ${rep.reading.encoding}`],
    ['Digest the HSM signs', `keccak256(payload) ${d.payloadHash}`],
  );
  return rows;
}

/** The short text block an approver pastes into the Linear ticket. */
export function record(rep: Report, now: Date): string {
  const r = rep.result;
  const how = r.verdict === 'MATCH' ? ` (data compared ${r.dataComparedBy === 'keccak256' ? 'by keccak256' : 'as bytes'})` : '';
  const lines = [`br-verify ${VERSION} (commit ${COMMIT}), ${now.toISOString().replace(/\.\d+Z$/, 'Z')}`, `Verdict: ${r.verdict}${how}`];
  if (!rep.parsed.ok || !rep.decoded) return [...lines, `Reason: ${r.reason}`, `Payload: ${grp(rep.reading.bytes.length)} bytes, read as ${rep.reading.encoding}`].join('\n');
  const tx = rep.parsed.tx;
  const d = rep.decoded;
  lines.push(`Payload: ${grp(d.payloadBytes)} bytes, keccak256 ${d.payloadHash}`);
  const what = d.kind === 'contract creation' ? `contract creation · init-code hash ${d.dataHash} · ${grp(d.dataBytes)} bytes`
    : `${d.kind} to ${tx.to} · ${d.call?.decoded ? d.call.signature : `selector ${d.call?.selector ?? 'none'}`} · data keccak256 ${d.dataHash} · ${grp(d.dataBytes)} bytes`;
  lines.push(`Chain ${tx.chainId} · nonce ${tx.nonce} · ${what}`);
  if (r.createAddress) lines.push(`CREATE address ${r.createAddress} (from ${rep.expected.from}, as entered)`);
  lines.push(`Gas limit ${grp(tx.gas)} · max fee ${grp(tx.maxFeePerGas)} wei · max priority fee ${grp(tx.maxPriorityFeePerGas)} wei · value ${grp(tx.value)} wei`);
  const want = rep.expected.accessList;
  const wanted = want === undefined ? 'not entered' : want.length > 0 ? `${want.length} entries` : rep.notes.accessListDefault ? "empty (the form's default)" : 'empty';
  lines.push(`Access list: payload ${tx.accessList.length === 0 ? 'empty' : `${tx.accessList.length} entries`}; expected ${wanted}`);
  for (const x of r.differences) lines.push(`Differs: ${label(x.field)} (expected ${x.expected}; payload ${x.actual})`);
  if (r.verdict === 'CANNOT VERIFY') lines.push(`Reason: ${r.reason}`);
  lines.push(`Not compared: ${r.notCompared.length ? r.notCompared.map(label).join(', ') : 'none'}`);
  for (const w of d.warnings) lines.push(`Warning: ${w}`);
  return lines.join('\n');
}

/** JSON text, or base64 of JSON text (how the Authorization App shows `metaData`). */
export function parseJsonText(text: string): unknown {
  const t = text.trim();
  if (t.startsWith('{')) return JSON.parse(t);
  const bin = atob(t.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}
