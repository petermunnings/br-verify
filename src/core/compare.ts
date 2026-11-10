// Compares a parsed payload with the transaction the approver expects, and gives the verdict.
import {
  encodeAbiParameters, encodeFunctionData, getAddress, getContractAddress, isAddress, isHex, keccak256,
  type AbiParameter, type Address, type Hex,
} from 'viem';
import { decodeCall, parseSignature } from './decode.js';
import { serializeTx, type Parsed, type Tx } from './payload.js';

/** What the approver believes they're approving. Every field is optional. Amounts are decimal strings in wei. */
export interface Expected {
  chainId?: number | string; nonce?: number | string; maxPriorityFeePerGas?: string; maxFeePerGas?: string;
  gas?: string; to?: string | null; value?: string; data?: string; dataHash?: string;
  call?: { signature: string; args: unknown[] }; accessList?: { address: string; storageKeys: string[] }[];
  /** Not part of the payload: used only for the CREATE address. */
  from?: string; expectedAddress?: string;
}

export type Verdict = 'MATCH' | 'MISMATCH' | 'PARTIAL' | 'NOT COMPARED' | 'CANNOT VERIFY' | 'BARE HASH';
export interface Difference { field: string; expected: string; actual: string }
export interface Result {
  verdict: Verdict; reason: string; differences: Difference[]; notCompared: string[];
  dataComparedBy: 'bytes' | 'keccak256' | null; createAddress: Address | null;
}

export const TX_FIELDS = ['chainId', 'nonce', 'maxPriorityFeePerGas', 'maxFeePerGas', 'gas', 'to', 'value', 'data', 'accessList'] as const;

export class ExpectedError extends Error {}
const bad = (field: string, why: string): never => { throw new ExpectedError(`${field}: ${why}`); };

/** A whole number from a decimal string or a safe JSON integer. Never floating point. */
function int(v: unknown, field: string, signed = false): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && (signed || v >= 0)) return BigInt(v);
  if (typeof v === 'string' && (signed ? /^-?\d+$/ : /^\d+$/).test(v.trim())) return BigInt(v.trim());
  return bad(field, 'must be a whole number written in decimal');
}
const addr = (v: unknown, field: string): Address =>
  typeof v === 'string' && isAddress(v.trim()) ? getAddress(v.trim()) : bad(field, 'must be an address (checksum or lower case)');
const hex = (v: unknown, field: string, bytes?: number): Hex =>
  typeof v === 'string' && isHex(v.trim()) && v.trim().length % 2 === 0 && (bytes === undefined || v.trim().length === 2 + 2 * bytes)
    ? (v.trim().toLowerCase() as Hex) : bad(field, bytes ? `must be ${bytes} bytes of 0x hex` : 'must be 0x hex');

/** JSON argument values to what viem encodes: integers to bigint, "true"/"false" to booleans, arrays and tuples walked. */
function coerce(p: AbiParameter, v: unknown, field: string): unknown {
  const arr = /^(.*)\[\d*\]$/.exec(p.type);
  if (arr) return Array.isArray(v) ? v.map((x, i) => coerce({ ...p, type: arr[1]! }, x, `${field}[${i}]`)) : bad(field, 'must be an array');
  if (p.type === 'tuple' && 'components' in p) {
    const parts = p.components.map((c, i) => coerce(c, Array.isArray(v) ? v[i] : (v as Record<string, unknown>)?.[c.name ?? ''], `${field}.${c.name ?? i}`));
    return Array.isArray(v) ? parts : Object.fromEntries(p.components.map((c, i) => [c.name, parts[i]]));
  }
  if (/^u?int\d*$/.test(p.type)) return int(v, field, p.type.startsWith('int'));
  if (p.type === 'bool') return v === true || v === 'true' ? true : v === false || v === 'false' ? false : bad(field, 'must be true or false');
  return typeof v === 'string' ? v.trim() : v;
}

export const show = (v: unknown): string =>
  typeof v === 'string' ? v : JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
const summary = (d: Hex) => `${(d.length - 2) / 2} bytes, keccak256 ${keccak256(d)}`;
const lists = (l: { address: string; storageKeys: string[] }[]) => show(l.map((e) => ({ address: e.address.toLowerCase(), storageKeys: e.storageKeys.map((k) => k.toLowerCase()) })));

/** Builds the calldata from the approver's signature and arguments, and names each difference from `data`. */
function compareCall(call: NonNullable<Expected['call']>, data: Hex, diffs: Difference[]): Hex {
  let item; try { item = parseSignature(call.signature); } catch { return bad('call.signature', 'is not a valid function signature'); }
  if (!Array.isArray(call.args) || call.args.length !== item.inputs.length) bad('call.args', `needs ${item.inputs.length} arguments`);
  const args = item.inputs.map((p, i) => coerce(p, call.args[i], `call.args[${i}]`));
  let built: Hex; try { built = encodeFunctionData({ abi: [item], args }); } catch (e) { return bad('call.args', (e as { shortMessage?: string }).shortMessage ?? 'do not encode'); }
  const actual = decodeCall(data, call.signature);
  if (!actual.decoded) diffs.push({ field: 'function', expected: `${call.signature} (${built.slice(0, 10)})`, actual: `${actual.selector}: ${actual.note}` });
  else {
    item.inputs.forEach((p, i) => {
      if (encodeAbiParameters([p], [args[i]]) !== encodeAbiParameters([p], [actual.args[i]!.value])) {
        diffs.push({ field: `argument ${i + 1}${p.name ? ` (${p.name})` : ''}, ${p.type}`, expected: show(args[i]), actual: show(actual.args[i]!.value) });
      }
    });
    if (built !== data && !diffs.some((d) => d.field.startsWith('argument'))) diffs.push({ field: 'data', expected: summary(built), actual: `${summary(data)} (extra or non-canonical bytes after the arguments)` });
  }
  return built;
}

export function compare(parsed: Parsed, e: Expected): Result {
  const r: Result = { verdict: 'CANNOT VERIFY', reason: '', differences: [], notCompared: [], dataComparedBy: null, createAddress: null };
  if (!parsed.ok) return { ...r, verdict: parsed.verdict, reason: parsed.reason };
  const tx = parsed.tx;
  const supplied = new Set<string>();
  const eq = (field: string, expected: string, actual: string) => {
    supplied.add(field);
    if (expected !== actual) r.differences.push({ field, expected, actual });
  };
  try {
    const want: Partial<Tx> = {};
    // Compared as exact decimal text, so a huge expected value can't round to the payload's.
    for (const f of ['chainId', 'nonce'] as const) {
      if (e[f] !== undefined) { const v = int(e[f], f); want[f] = Number(v); eq(f, v.toString(), String(tx[f])); }
    }
    for (const f of ['maxPriorityFeePerGas', 'maxFeePerGas', 'gas', 'value'] as const) {
      if (e[f] !== undefined) eq(f, String((want[f] = int(e[f], f))), String(tx[f]));
    }
    if (e.to !== undefined) eq('to', (want.to = e.to === null ? null : addr(e.to, 'to')) ?? 'contract creation', tx.to ?? 'contract creation');
    if (e.accessList !== undefined) {
      if (!Array.isArray(e.accessList)) bad('accessList', 'must be a list');
      want.accessList = e.accessList.map((x, i) => ({ address: addr(x?.address, `accessList[${i}].address`), storageKeys: (Array.isArray(x?.storageKeys) ? x.storageKeys : bad(`accessList[${i}].storageKeys`, 'must be a list')).map((k, j) => hex(k, `accessList[${i}].storageKeys[${j}]`, 32)) }));
      eq('accessList', lists(want.accessList), lists(tx.accessList));
    }
    if (e.data !== undefined) { want.data = hex(e.data, 'data'); eq('data', summary(want.data), summary(tx.data)); }
    if (e.call !== undefined) {
      const before = r.differences.length;
      const built = compareCall(e.call, tx.data, r.differences);
      want.data ??= built;
      supplied.add('data');
      if (r.differences.length === before && built !== tx.data) eq('data', summary(built), summary(tx.data));
    }
    if (e.dataHash !== undefined) eq('data', `keccak256 ${hex(e.dataHash, 'dataHash', 32)}`, `keccak256 ${keccak256(tx.data)}`);
    r.dataComparedBy = want.data !== undefined ? 'bytes' : e.dataHash !== undefined ? 'keccak256' : null;
    if (e.from !== undefined && tx.to === null) r.createAddress = getContractAddress({ from: addr(e.from, 'from'), nonce: BigInt(tx.nonce) });
    if (e.expectedAddress !== undefined) {
      const x = addr(e.expectedAddress, 'expectedAddress');
      if (tx.to !== null) eq('expectedAddress', x, 'none: the payload is not a contract creation');
      else if (r.createAddress === null) r.notCompared.push('expectedAddress (no "from" entered)');
      else eq('expectedAddress', x, r.createAddress);
    }
    r.notCompared.unshift(...TX_FIELDS.filter((f) => !supplied.has(f)));
    if (r.differences.length > 0) return { ...r, verdict: 'MISMATCH', reason: 'Reject the request' };
    if (supplied.size === 0) return { ...r, verdict: 'NOT COMPARED', reason: 'Decoded only. Nothing was compared' };
    if (r.notCompared.length > 0) return { ...r, verdict: 'PARTIAL', reason: 'The fields you entered match. Some were not compared' };
    // Every field was supplied and equal. When the data bytes are known, the rebuilt transaction must be the payload too.
    if (want.data !== undefined && serializeTx(want as Tx) !== parsed.payload) {
      return { ...r, verdict: 'CANNOT VERIFY', reason: 'internal check failed: the field comparison and the byte comparison disagree' };
    }
    return { ...r, verdict: 'MATCH', reason: 'the payload is the transaction you entered' };
  } catch (err) {
    const why = err instanceof ExpectedError ? `what you entered is not valid: ${err.message}` : `internal error: ${String(err)}`;
    return { ...r, differences: [], notCompared: [], verdict: 'CANNOT VERIFY', reason: why };
  }
}
