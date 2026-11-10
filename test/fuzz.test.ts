// 9. Fuzz with a fixed seed. 10. Differential test against ethers v6 (a dev dependency only).
import { Transaction } from 'ethers';
import { describe, expect, it } from 'vitest';
import { compare } from '../src/core/compare.js';
import { parsePayload, serializeTx, type Tx } from '../src/core/payload.js';
import { bytesOf, expectedFrom, randomTx, rng } from './helpers.js';

const CASES = 1500;
const r = rng(20261110);
const txs: Tx[] = Array.from({ length: CASES }, () => randomTx(r));

describe('9. fuzz', () => {
  it(`${CASES} random valid transactions round-trip and MATCH their own fields`, () => {
    let bare = 0;
    for (const tx of txs) {
      const payload = serializeTx(tx);
      const p = parsePayload(bytesOf(payload));
      // By rule, any 32-byte payload is a bare hash, even a (tiny) valid transaction. That fails closed.
      if (payload.length === 2 + 64) { expect(p).toMatchObject({ ok: false, verdict: 'BARE HASH' }); bare++; continue; }
      expect(p.ok).toBe(true);
      if (!p.ok) continue;
      expect(serializeTx(p.tx)).toBe(payload);
      expect(compare(p, expectedFrom(tx)).verdict).toBe('MATCH');
    }
    expect(bare).toBeLessThan(CASES / 10);
  });

  it('flipping any single byte never yields MATCH against the original fields', () => {
    let flips = 0;
    txs.forEach((tx, n) => {
      const bytes = bytesOf(serializeTx(tx));
      const e = expectedFrom(tx);
      // One random position per case, plus every position for the first 20 cases.
      const positions = n < 20 ? Array.from(bytes, (_, i) => i) : [r.int(bytes.length)];
      for (const i of positions) {
        const copy = bytes.slice();
        copy[i] = copy[i]! ^ (1 + r.int(255));
        expect(compare(parsePayload(copy), e).verdict).not.toBe('MATCH');
        flips++;
      }
    });
    expect(flips).toBeGreaterThan(CASES);
  });
});

describe('10. differential: ethers v6 agrees with viem', () => {
  it(`unsignedSerialized equals serializeTransaction for ${CASES} cases`, () => {
    for (const tx of txs) {
      const e = Transaction.from({
        type: 2, chainId: tx.chainId, nonce: tx.nonce, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        maxFeePerGas: tx.maxFeePerGas, gasLimit: tx.gas, to: tx.to, value: tx.value, data: tx.data,
        accessList: tx.accessList,
      });
      expect(e.unsignedSerialized).toBe(serializeTx(tx));
    }
  });
});
