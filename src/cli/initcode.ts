// `br-verify initcode`: the init-code hash, size and CREATE address of a contract creation's data, with
// the approver's pins checked. With a forge artifact, also the creation code and the constructor arguments.
import { decodeAbiParameters, encodeAbiParameters, getContractAddress, keccak256, type AbiParameter, type Hex } from 'viem';
import { INITCODE_MAX } from '../core/decode.js';
import { arg, grp } from '../view/report.js';

export interface Check { name: string; expected: string; actual: string; ok: boolean; source: 'you' | 'bundle' | 'artifact' }
export interface ArtifactView { contract: string; creationBytes: number; creationHash: Hex; args: { name: string; type: string; value: string; raw: unknown }[] }
export interface InitcodeResult {
  verdict: 'MATCH' | 'MISMATCH' | 'PARTIAL' | 'NOT COMPARED' | 'CANNOT VERIFY'; reason: string;
  bytes: number; hash: Hex; createAddress: string | null; from: string | null; nonce: number | null;
  checks: Check[]; notCompared: string[]; warnings: string[]; artifact: ArtifactView | null;
}
export interface InitcodeInput {
  data: Hex; from?: string; nonce?: number; expectHash?: string; expectAddress?: string;
  bundle?: { initCodeHash?: string; expectedAddress?: string; payloadBytes?: number; creationCodeHash?: string };
  artifact?: { json: unknown; name: string };
}

interface ForgeArtifact { abi?: { type: string; inputs?: AbiParameter[] }[]; bytecode?: { object?: string } | string }

/** Checks `data` = the artifact's creation code ‖ ABI-encoded constructor arguments that re-encode exactly. */
export function checkArtifact(data: Hex, json: unknown, name: string): { view: ArtifactView; checks: Check[] } {
  const a = json as ForgeArtifact;
  const raw = typeof a?.bytecode === 'string' ? a.bytecode : a?.bytecode?.object;
  if (typeof raw !== 'string' || raw.replace(/^0x/, '') === '') throw new Error('the artifact has no bytecode.object');
  if (raw.includes('__')) throw new Error('the artifact has unlinked library placeholders; refusing it');
  const creation = `0x${raw.replace(/^0x/, '').toLowerCase()}` as Hex;
  const prefix = data.toLowerCase().startsWith(creation);
  const checks: Check[] = [{ name: 'data starts with the artifact creation code', expected: 'yes', actual: prefix ? 'yes' : 'no', ok: prefix, source: 'artifact' }];
  const view: ArtifactView = { contract: name, creationBytes: (creation.length - 2) / 2, creationHash: keccak256(creation), args: [] };
  if (!prefix) return { view, checks };
  const rest = `0x${data.slice(creation.length)}` as Hex;
  const inputs = a.abi?.find((x) => x.type === 'constructor')?.inputs ?? [];
  let decoded: readonly unknown[];
  try { decoded = decodeAbiParameters(inputs, rest); } catch {
    checks.push({ name: 'constructor arguments decode', expected: 'yes', actual: 'no', ok: false, source: 'artifact' });
    return { view, checks };
  }
  const again = encodeAbiParameters(inputs, decoded as unknown[]);
  checks.push({ name: 'constructor arguments re-encode to the same bytes', expected: `${grp((rest.length - 2) / 2)} bytes`, actual: again === rest ? 'same' : `${grp((again.length - 2) / 2)} bytes, different`, ok: again === rest, source: 'artifact' });
  // One row per argument; a tuple's fields get a row each, so every role address is on its own line.
  view.args = inputs.flatMap((p, i) => {
    const row = { name: p.name || `arg${i}`, type: p.type, value: arg(decoded[i]), raw: decoded[i] };
    if (p.type !== 'tuple' || !('components' in p) || typeof decoded[i] !== 'object' || decoded[i] === null) return [row];
    const t = decoded[i] as Record<string, unknown>;
    return [{ ...row, value: '' }, ...p.components.map((c, j) => ({ name: `${row.name}.${c.name || j}`, type: c.type, value: arg(t[c.name || j]), raw: t[c.name || j] }))];
  });
  return { view, checks };
}

export function initcode(i: InitcodeInput): InitcodeResult {
  const bytes = (i.data.length - 2) / 2;
  const hash = keccak256(i.data);
  const createAddress = i.from !== undefined && i.nonce !== undefined ? getContractAddress({ from: i.from as Hex, nonce: BigInt(i.nonce) }) : null;
  const r: InitcodeResult = {
    verdict: 'NOT COMPARED', reason: '', bytes, hash, createAddress, from: i.from ?? null, nonce: i.nonce ?? null,
    checks: [], notCompared: [], warnings: bytes > INITCODE_MAX ? [`The init code is longer than ${INITCODE_MAX} bytes (EIP-3860). It can't deploy.`] : [], artifact: null,
  };
  const check = (name: string, expected: string | undefined, actual: string | null, source: Check['source']) => {
    if (expected === undefined) return;
    if (actual === null) { r.notCompared.push(`${name} (needs from and nonce)`); return; }
    r.checks.push({ name, expected, actual, ok: expected.toLowerCase() === actual.toLowerCase(), source });
  };
  check('init-code hash', i.expectHash, hash, 'you');
  check('CREATE address', i.expectAddress, createAddress, 'you');
  if (i.bundle) {
    check("bundle's initCodeHash", i.bundle.initCodeHash, hash, 'bundle');
    check("bundle's expectedAddress", i.bundle.expectedAddress, createAddress, 'bundle');
    check("bundle's payloadBytes (init-code length)", i.bundle.payloadBytes?.toString(), String(bytes), 'bundle');
  }
  if (i.artifact) {
    try {
      const { view, checks } = checkArtifact(i.data, i.artifact.json, i.artifact.name);
      r.artifact = view;
      r.checks.push(...checks);
      check("bundle's artifact.creationCodeHash", i.bundle?.creationCodeHash, view.creationHash, 'bundle');
    } catch (e) {
      return { ...r, verdict: 'CANNOT VERIFY', reason: e instanceof Error ? e.message : String(e) };
    }
  }
  if (i.expectHash === undefined) r.notCompared.unshift('init-code hash (no --expect-hash)');
  if (r.checks.some((c) => !c.ok)) return { ...r, verdict: 'MISMATCH', reason: 'Reject the request' };
  if (i.expectHash === undefined) return { ...r, verdict: 'NOT COMPARED', reason: 'No init-code hash pin was given. The bundle\'s own values are not an independent check' };
  if (r.notCompared.length > 0) return { ...r, verdict: 'PARTIAL', reason: 'The pins you entered match. Some were not compared' };
  return { ...r, verdict: 'MATCH', reason: 'the init code has the hash you entered' };
}
