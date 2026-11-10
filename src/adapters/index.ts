// Optional readers for Braided Rivers data formats. They only map field names onto `Expected`:
// no hashing, no encoding. Anything they don't recognise is refused rather than guessed.
import type { Expected } from '../core/compare.js';

export type Format = 'expected' | 'metaData' | 'bundle';
export interface Notes { accessListDefault?: boolean; toName?: string; ticket?: string; keyLabel?: string; artifact?: BundleArtifact; constructorArgs?: unknown }
export interface BundleArtifact { contract?: string; path?: string; creationCodeHash?: string; repoCommit?: string }
export interface Read { format: Format; expected: Expected; notes: Notes }

type Obj = Record<string, unknown>;
const EXPECTED_KEYS = ['chainId', 'nonce', 'maxPriorityFeePerGas', 'maxFeePerGas', 'gas', 'to', 'value', 'data', 'dataHash', 'call', 'accessList', 'from', 'expectedAddress'];
const defined = <T extends Obj>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * The approvers' `metaData` (braided-rivers `signer/flow/metaData.ts`, `buildMetaData`). Its `digest` is
 * deliberately ignored: br-verify checks the payload, never the digest the requester wrote.
 */
export function fromMetaData(m: Obj): Read {
  const fn = m.function as string;
  const target = m.targetContract as { name?: string } | undefined;
  return {
    format: 'metaData',
    expected: defined({
      chainId: m.chainId as number, nonce: m.nonce as number, from: m.from as string, to: m.to as string,
      value: m.value as string, gas: m.gasLimit as string,
      maxFeePerGas: (m.maxFeePerGas ?? undefined) as string | undefined,
      maxPriorityFeePerGas: (m.maxPriorityFeePerGas ?? undefined) as string | undefined,
      ...(fn === 'none (value transfer)' ? { data: '0x' }
        : { call: { signature: fn, args: ((m.args ?? []) as { value: unknown }[]).map((a) => a.value) } }),
    }),
    notes: defined({ toName: target?.name, ticket: m.ticket as string, keyLabel: m.keyLabel as string }),
  };
}

/** A facility-book request bundle (`build/mfsol/ceremony/plan-three/*.json`, docs/mfsol-bootstrappers.md). */
export function fromBundle(b: Obj): Read {
  if (b.kind === 'message') throw new Error('this bundle is a signed message (EIP-191), which br-verify does not verify');
  if (b.kind !== 'create' && b.kind !== 'call') throw new Error(`unknown bundle kind ${JSON.stringify(b.kind)}`);
  return {
    format: 'bundle',
    expected: defined({
      chainId: b.chainId as number, from: b.from as string, to: (b.kind === 'create' ? null : b.to) as string | null,
      value: b.value as string, data: (b.data ?? undefined) as string | undefined, dataHash: b.initCodeHash as string | undefined,
      nonce: b.expectedNonce as number | undefined, expectedAddress: b.expectedAddress as string | undefined,
      gas: b.gasLimit as string | undefined,
    }),
    notes: defined({ artifact: b.artifact as BundleArtifact | undefined, constructorArgs: b.constructorArgs }),
  };
}

/** Reads expected JSON in any of the three formats. A plain `Expected` with an unknown key is refused. */
export function readExpected(o: unknown): Read {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new Error('expected a JSON object');
  const obj = o as Obj;
  if ('gasLimit' in obj && 'function' in obj && ('digest' in obj || obj.kind === 'transaction')) return fromMetaData(obj);
  if (['create', 'call', 'message'].includes(obj.kind as string) && ('keyPolicyRule' in obj || 'initCodeHash' in obj || 'payloadBytes' in obj)) return fromBundle(obj);
  const unknown = Object.keys(obj).filter((k) => !EXPECTED_KEYS.includes(k));
  if (unknown.length > 0) throw new Error(`unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  return { format: 'expected', expected: obj as Expected, notes: {} };
}
