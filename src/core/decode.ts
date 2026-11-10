// The decoded view of a parsed payload: chain, kind, call, sizes, hashes and warnings.
import {
  decodeFunctionData, keccak256, parseAbiItem, toFunctionSelector, zeroAddress, type AbiFunction, type Hex,
} from 'viem';
import type { Tx } from './payload.js';

export const CHAIN_1 = 'Chain ID 1: Fork of Ethereum mainnet. Braided Rivers signs chain ID 1 only for its local fork. ' +
  "br-verify can't tell the fork from the real chain: the same signed bytes would be valid on both.";
const UNKNOWN_CHAIN = 'Unknown chain. Reject unless the ticket names this chain ID';

export function chainName(id: number): { name: string; known: boolean } {
  if (id === 84532) return { name: 'Base Sepolia', known: true };
  if (id === 31337 || id === 1337) return { name: 'Local test chain', known: true };
  if (id === 1) return { name: CHAIN_1, known: true };
  return { name: UNKNOWN_CHAIN, known: false };
}

/** Parses a function signature the approver entered, e.g. `mint(address,uint256)`. Throws if invalid. */
export function parseSignature(signature: string): AbiFunction {
  const item = parseAbiItem(`function ${signature.trim().replace(/^function\s+/, '')}`);
  if (item.type !== 'function') throw new Error('not a function signature');
  return item as AbiFunction;
}

export type CallView =
  | { decoded: true; signature: string; selector: Hex; args: { name: string; type: string; value: unknown }[] }
  | { decoded: false; selector: Hex; note: string };

/** Decodes `data` with the approver's signature. Only the selector without one, or if it doesn't decode. */
export function decodeCall(data: Hex, signature?: string): CallView {
  const selector = data.slice(0, 10) as Hex;
  if (!signature) return { decoded: false, selector, note: 'function not decoded (no signature entered)' };
  try {
    const item = parseSignature(signature);
    if (toFunctionSelector(item) !== selector) return { decoded: false, selector, note: 'the selector is not the signature entered' };
    const { args = [] } = decodeFunctionData({ abi: [item], data });
    const sig = `${item.name}(${item.inputs.map((p) => p.type).join(',')})`;
    return { decoded: true, signature: sig, selector, args: item.inputs.map((p, i) => ({ name: p.name ?? '', type: p.type, value: args[i] })) };
  } catch {
    return { decoded: false, selector, note: "the data doesn't decode with the signature entered" };
  }
}

export interface Decoded {
  chain: { id: number; name: string };
  kind: 'contract creation' | 'contract call' | 'plain transfer';
  call: CallView | null;
  dataBytes: number; dataHash: Hex; payloadBytes: number; payloadHash: Hex; maxCost: bigint;
  warnings: string[];
}

export const GAS_CAP = 16_777_216n;
export const INITCODE_MAX = 49_152;

export function decode(tx: Tx, payload: Hex, signature?: string): Decoded {
  const dataBytes = (tx.data.length - 2) / 2;
  const kind = tx.to === null ? 'contract creation' : dataBytes === 0 ? 'plain transfer' : 'contract call';
  const chain = chainName(tx.chainId);
  const w: string[] = [];
  if (tx.value !== 0n) w.push(`The value is not 0: ${tx.value} wei.`);
  if (tx.accessList.length > 0) w.push('The access list is not empty.');
  if (tx.gas >= GAS_CAP) w.push(`The gas limit is ${GAS_CAP} or more. The signing flow refuses this.`);
  if (kind === 'contract creation' && dataBytes > INITCODE_MAX) w.push(`The init code is longer than ${INITCODE_MAX} bytes (EIP-3860). It can't deploy.`);
  if (!chain.known) w.push(`Chain ID ${tx.chainId} is unknown.`);
  if (tx.to === zeroAddress) w.push('"To" is the zero address.');
  return {
    chain: { id: tx.chainId, name: chain.name }, kind,
    call: kind === 'contract call' ? decodeCall(tx.data, signature) : null,
    dataBytes, dataHash: keccak256(tx.data), payloadBytes: (payload.length - 2) / 2, payloadHash: keccak256(payload),
    maxCost: tx.gas * tx.maxFeePerGas, warnings: w,
  };
}
