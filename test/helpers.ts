import { bytesToHex, type Hex } from 'viem';
import type { Expected } from '../src/core/compare.js';
import { serializeTx, type Tx } from '../src/core/payload.js';

export const DEPLOYER_1 = '0x295433a6CA85a947C7a69Ae646615Dff7B5a0734' as const;
export const KNOWN: Tx = {
  chainId: 1, nonce: 0, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2_000_000_000n, gas: 11_878_178n,
  to: null, value: 0n, data: '0x6080', accessList: [],
};
export const KNOWN_PAYLOAD = '0x02d60180843b9aca00847735940083b53f228080826080c0';
export const KNOWN_DIGEST = '0x3e0439a8c03f175b15faa919d8bd271e056f0427502cbe9b4fbc091dff37ca40';

/** A small seeded generator (mulberry32), so every run sees the same cases. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const bytes = (n: number) => Uint8Array.from({ length: n }, () => int(256));
  const big = (maxBytes: number) => (maxBytes === 0 ? 0n : BigInt(bytesToHex(bytes(1 + int(maxBytes)))));
  return { next, int, bytes, big, hex: (n: number) => bytesToHex(bytes(n)) };
}

export function randomTx(r: ReturnType<typeof rng>): Tx {
  const chains = [1, 84532, 31337, 1337, 1 + r.int(2 ** 31)];
  return {
    chainId: chains[r.int(chains.length)]!,
    nonce: r.int(4) === 0 ? 0 : r.int(2 ** 31),
    ...fees(r),
    gas: r.big(4),
    to: r.int(3) === 0 ? null : (r.hex(20) as Hex),
    value: r.int(2) === 0 ? 0n : r.big(12),
    data: r.int(4) === 0 ? '0x' : r.hex(r.int(300)),
    accessList: r.int(5) === 0 ? [{ address: r.hex(20) as Hex, storageKeys: Array.from({ length: r.int(3) }, () => r.hex(32) as Hex) }] : [],
  } as Tx;
}

function fees(r: ReturnType<typeof rng>) {
  const a = r.int(5) === 0 ? 0n : r.big(8);
  const b = r.int(5) === 0 ? 0n : r.big(8);
  return a <= b ? { maxPriorityFeePerGas: a, maxFeePerGas: b } : { maxPriorityFeePerGas: b, maxFeePerGas: a };
}

/** The expected request with every field filled in from `tx`. */
export function expectedFrom(tx: Tx): Expected {
  return {
    chainId: tx.chainId, nonce: tx.nonce, maxPriorityFeePerGas: String(tx.maxPriorityFeePerGas),
    maxFeePerGas: String(tx.maxFeePerGas), gas: String(tx.gas), to: tx.to, value: String(tx.value),
    data: tx.data, accessList: tx.accessList.map((e) => ({ address: e.address, storageKeys: [...e.storageKeys] })),
  };
}

export const hexOf = (tx: Tx) => serializeTx(tx);
export const bytesOf = (h: Hex) => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));
