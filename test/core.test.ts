import { describe, expect, it } from 'vitest';
import {
  bytesToHex, encodeFunctionData, getContractAddress, keccak256, parseAbi, serializeTransaction, toRlp, type Hex,
} from 'viem';
import { compare, type Expected } from '../src/core/compare.js';
import { decode, decodeCall, GAS_CAP, INITCODE_MAX } from '../src/core/decode.js';
import { parsePayload, readPayloadText, serializeTx, type Tx } from '../src/core/payload.js';
import { DEPLOYER_1, KNOWN, KNOWN_DIGEST, KNOWN_PAYLOAD, bytesOf, expectedFrom, randomTx, rng } from './helpers.js';

const check = (payload: Hex, e: Expected) => compare(parsePayload(bytesOf(payload)), e);

const TOKEN = '0x1000000000000000000000000000000000000001';
const HOLDER = '0x2000000000000000000000000000000000000002';
const MINT = parseAbi(['function mint(address to, uint256 amount)']);
const mintData = encodeFunctionData({ abi: MINT, args: [HOLDER, 7000n * 10n ** 18n] });
const CALL: Tx = { ...KNOWN, chainId: 1, nonce: 5, gas: 309_938n, to: TOKEN, data: mintData };
const callExpected = (): Expected => {
  const { data: _data, ...rest } = expectedFrom(CALL);
  return { ...rest, call: { signature: 'mint(address,uint256)', args: [HOLDER, '7000000000000000000000'] } };
};

describe('1. the known vector', () => {
  it('serialises to the known payload and digest', () => {
    expect(serializeTx(KNOWN)).toBe(KNOWN_PAYLOAD);
    expect(keccak256(KNOWN_PAYLOAD)).toBe(KNOWN_DIGEST);
  });
  it('parses back to the same fields', () => {
    const p = parsePayload(bytesOf(KNOWN_PAYLOAD));
    expect(p).toEqual({ ok: true, tx: KNOWN, payload: KNOWN_PAYLOAD });
  });
  it('decodes with the digest the HSM signs', () => {
    const d = decode(KNOWN, KNOWN_PAYLOAD);
    expect(d.payloadHash).toBe(KNOWN_DIGEST);
    expect(d.payloadBytes).toBe(24);
    expect(d.kind).toBe('contract creation');
    expect(d.maxCost).toBe(11_878_178n * 2_000_000_000n);
  });
});

describe('2. MATCH', () => {
  it('a correct creation, data compared as bytes', () => {
    const r = check(KNOWN_PAYLOAD, expectedFrom(KNOWN));
    expect(r.verdict).toBe('MATCH');
    expect(r.dataComparedBy).toBe('bytes');
    expect(r.notCompared).toEqual([]);
  });
  it('a correct creation by init-code hash, with the CREATE address', () => {
    const { data: _d, ...rest } = expectedFrom(KNOWN);
    const r = check(KNOWN_PAYLOAD, { ...rest, dataHash: keccak256('0x6080'), from: DEPLOYER_1, expectedAddress: '0x06Fbac10db58E960Aa3D6Ff94554426e6c1AbE50' });
    expect(r.verdict).toBe('MATCH');
    expect(r.dataComparedBy).toBe('keccak256');
    expect(r.createAddress).toBe('0x06Fbac10db58E960Aa3D6Ff94554426e6c1AbE50');
  });
  it('a correct call from a signature and arguments', () => {
    const r = check(serializeTx(CALL), callExpected());
    expect(r.verdict).toBe('MATCH');
    expect(r.dataComparedBy).toBe('bytes');
  });
  it('data, dataHash and call all given and agreeing', () => {
    const r = check(serializeTx(CALL), { ...callExpected(), data: mintData, dataHash: keccak256(mintData) });
    expect(r.verdict).toBe('MATCH');
  });
});

describe('3. MISMATCH names each field', () => {
  const payload = serializeTx(CALL);
  const cases: [string, Partial<Expected>, string][] = [
    ['nonce', { nonce: 6 }, 'nonce'],
    ['chain ID', { chainId: 84532 }, 'chainId'],
    ['max fee', { maxFeePerGas: '2000000001' }, 'maxFeePerGas'],
    ['max priority fee', { maxPriorityFeePerGas: '999999999' }, 'maxPriorityFeePerGas'],
    ['gas limit', { gas: '309939' }, 'gas'],
    ['to', { to: HOLDER }, 'to'],
    ['value', { value: '1' }, 'value'],
    ['access list', { accessList: [{ address: HOLDER, storageKeys: [] }] }, 'accessList'],
    ['creation versus call', { to: null }, 'to'],
  ];
  for (const [name, change, field] of cases) {
    it(name, () => {
      const r = check(payload, { ...callExpected(), ...change });
      expect(r.verdict).toBe('MISMATCH');
      expect(r.differences.map((d) => d.field)).toEqual([field]);
    });
  }
  it('tampered calldata (one byte) as bytes', () => {
    const tampered = (mintData.slice(0, -2) + '01') as Hex;
    const r = check(serializeTx({ ...CALL, data: tampered }), { ...expectedFrom(CALL) });
    expect(r.verdict).toBe('MISMATCH');
    expect(r.differences.map((d) => d.field)).toEqual(['data']);
  });
  it('tampered calldata (one byte) against the call names the argument', () => {
    const tampered = (mintData.slice(0, -2) + '01') as Hex;
    const r = check(serializeTx({ ...CALL, data: tampered }), callExpected());
    expect(r.verdict).toBe('MISMATCH');
    expect(r.differences[0]!.field).toBe('argument 2, uint256');
    const named = check(serializeTx({ ...CALL, data: tampered }), { ...callExpected(), call: { signature: 'mint(address to, uint256 amount)', args: [HOLDER, '7000000000000000000000'] } });
    expect(named.differences[0]!.field).toBe('argument 2 (amount), uint256');
  });
  it('tampered init code against the hash pin', () => {
    const { data: _d, ...rest } = expectedFrom(KNOWN);
    const r = check(serializeTx({ ...KNOWN, data: '0x6081' }), { ...rest, dataHash: keccak256('0x6080') });
    expect(r.verdict).toBe('MISMATCH');
    expect(r.differences.map((d) => d.field)).toEqual(['data']);
  });
  it('a call expected, a creation in the payload', () => {
    const r = check(KNOWN_PAYLOAD, { ...expectedFrom(KNOWN), to: TOKEN });
    expect(r.verdict).toBe('MISMATCH');
    expect(r.differences[0]).toMatchObject({ field: 'to', expected: TOKEN, actual: 'contract creation' });
  });
  it('the wrong expected address', () => {
    const r = check(KNOWN_PAYLOAD, { ...expectedFrom(KNOWN), from: DEPLOYER_1, expectedAddress: '0x6C7673ADB5A352155A92158B6A5A63dFb9b7FAe1' });
    expect(r.verdict).toBe('MISMATCH');
    expect(r.differences.map((d) => d.field)).toEqual(['expectedAddress']);
  });
  it('a huge expected chain ID or nonce does not round to the payload value', () => {
    const tx: Tx = { ...KNOWN, chainId: Number.MAX_SAFE_INTEGER };
    expect(check(serializeTx(tx), expectedFrom(tx)).verdict).toBe('MATCH');
    const r = check(serializeTx(tx), { ...expectedFrom(tx), chainId: '9007199254740992' });
    expect(r.verdict).toBe('MISMATCH');
    expect(r.differences.map((d) => d.field)).toEqual(['chainId']);
  });
  it('an expected address for a call', () => {
    const r = check(payload, { ...callExpected(), expectedAddress: TOKEN });
    expect(r.verdict).toBe('MISMATCH');
  });
  it('data and dataHash that disagree', () => {
    const r = check(KNOWN_PAYLOAD, { ...expectedFrom(KNOWN), dataHash: keccak256('0x6081') });
    expect(r.verdict).toBe('MISMATCH');
  });
});

describe('4. PARTIAL and NOT COMPARED', () => {
  it('lists the fields not compared', () => {
    const r = check(KNOWN_PAYLOAD, { chainId: 1, nonce: 0 });
    expect(r.verdict).toBe('PARTIAL');
    expect(r.notCompared).toEqual(['maxPriorityFeePerGas', 'maxFeePerGas', 'gas', 'to', 'value', 'data', 'accessList']);
  });
  it('an expected address with no from is listed as not compared', () => {
    const r = check(KNOWN_PAYLOAD, { ...expectedFrom(KNOWN), expectedAddress: '0x06Fbac10db58E960Aa3D6Ff94554426e6c1AbE50' });
    expect(r.verdict).toBe('PARTIAL');
    expect(r.notCompared).toEqual(['expectedAddress (no "from" entered)']);
  });
  it('nothing entered gives NOT COMPARED', () => {
    const r = check(KNOWN_PAYLOAD, {});
    expect(r.verdict).toBe('NOT COMPARED');
    expect(r.notCompared).toHaveLength(9);
  });
  it('a from alone compares nothing', () => {
    const r = check(KNOWN_PAYLOAD, { from: DEPLOYER_1 });
    expect(r.verdict).toBe('NOT COMPARED');
    expect(r.createAddress).toBe('0x06Fbac10db58E960Aa3D6Ff94554426e6c1AbE50');
  });
  it('every subset of the fields short of all nine is never MATCH', () => {
    const full = expectedFrom(KNOWN);
    const keys = Object.keys(full) as (keyof Expected)[];
    for (let mask = 0; mask < 2 ** keys.length - 1; mask++) {
      const e: Expected = {};
      keys.forEach((k, i) => { if (mask & (1 << i)) (e as Record<string, unknown>)[k] = full[k]; });
      expect(check(KNOWN_PAYLOAD, e).verdict).not.toBe('MATCH');
    }
  });
});

describe('5. encodings', () => {
  const b64 = Buffer.from(KNOWN_PAYLOAD.slice(2), 'hex').toString('base64');
  const read = (t: string) => readPayloadText(t);
  it.each([
    ['hex with 0x', KNOWN_PAYLOAD],
    ['hex without 0x', KNOWN_PAYLOAD.slice(2)],
    ['upper-case hex', '0X' + KNOWN_PAYLOAD.slice(2).toUpperCase()],
    ['hex with spaces and line breaks', KNOWN_PAYLOAD.replace(/(.{8})/g, '$1 \n\t')],
  ])('%s', (_, text) => {
    const [r, ...rest] = read(text);
    expect(rest).toEqual([]);
    expect(r!.encoding).toBe('hex');
    expect(bytesToHex(r!.bytes)).toBe(KNOWN_PAYLOAD);
  });
  it.each([
    ['base64 with padding', b64, 'base64'],
    ['base64 without padding', b64.replace(/=+$/, ''), 'base64'],
    ['base64 with line breaks', b64.replace(/(.{10})/g, '$1\r\n'), 'base64'],
    ['base64 of hex text', Buffer.from(KNOWN_PAYLOAD.slice(2).toUpperCase()).toString('base64'), 'base64 of hex'],
    ['base64 of 0x-hex text', Buffer.from(KNOWN_PAYLOAD).toString('base64'), 'base64 of hex'],
  ])('%s', (_, text, encoding) => {
    const [r, ...rest] = read(text);
    expect(rest).toEqual([]);
    expect(r!.encoding).toBe(encoding);
    expect(bytesToHex(r!.bytes)).toBe(KNOWN_PAYLOAD);
  });
  it('URL-safe base64', () => {
    // A payload whose base64 contains '+' and '/', so the URL-safe form differs.
    const tx: Tx = { ...KNOWN, data: '0xfbfffe3e3f' };
    const std = Buffer.from(serializeTx(tx).slice(2), 'hex').toString('base64');
    const url = std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(url).not.toBe(std);
    expect(bytesToHex(read(url)[0]!.bytes)).toBe(serializeTx(tx));
  });
  it('the ambiguous case cannot arise, so one reading is always chosen', () => {
    // Hex that doesn't start 0x02 can't parse as EIP-1559. Base64 of a 0x02 payload has its second
    // character in g..v, and base64 of hex text starts "MD" (or "MH" after "0x"), so neither is ever all hex digits.
    const r = rng(5);
    for (let i = 0; i < 1000; i++) {
      const p = serializeTx(randomTx(r));
      const b = Buffer.from(p.slice(2), 'hex').toString('base64');
      const bh = Buffer.from(p.slice(2)).toString('base64');
      expect(/^[0-9a-fA-F]*$/.test(b) || /^[0-9a-fA-F]*$/.test(bh)).toBe(false);
      expect(read(b)).toHaveLength(1);
    }
    // Text valid in both alphabets where neither reading parses: hex is kept, and parsing then refuses it.
    expect(read('abcd')).toEqual([{ encoding: 'hex', bytes: new Uint8Array([0xab, 0xcd]) }]);
  });
  it('hex that is not a transaction but valid base64 of one is read as base64', () => {
    // Base64 text with only hex-digit characters can't be a transaction (see above), so check the
    // rule on its other branch: base64 that parses wins over hex that doesn't.
    const b = Buffer.from(KNOWN_PAYLOAD.slice(2), 'hex').toString('base64').replace(/=+$/, '');
    expect(read(b)).toHaveLength(1);
    expect(read(b)[0]!.encoding).toBe('base64');
  });
  it('text that is neither hex nor base64 has no reading', () => {
    expect(read('not a payload!')).toEqual([]);
    expect(read('a')).toEqual([]); // odd-length hex, and one base64 character is no byte
    expect(read('abc')[0]!.encoding).toBe('base64'); // odd-length hex is tried as base64
  });
  it('odd-length hex is read as base64, which then fails to parse', () => {
    const r = read(KNOWN_PAYLOAD.slice(0, -1));
    expect(r.every((x) => !parsePayload(x.bytes).ok)).toBe(true);
  });
});

describe('6. fail closed', () => {
  const verdictOf = (bytes: Uint8Array) => compare(parsePayload(bytes), expectedFrom(KNOWN));
  it('a signed transaction', () => {
    const signed = serializeTransaction({ type: 'eip1559', chainId: 1, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2_000_000_000n, gas: 11_878_178n, data: '0x6080' }, { r: '0x01', s: '0x02', yParity: 1 });
    const r = verdictOf(bytesOf(signed));
    expect(r.verdict).toBe('CANNOT VERIFY');
    expect(r.reason).toBe('this is a signed transaction, not the payload from DETAILS');
  });
  it('legacy', () => {
    const legacy = serializeTransaction({ type: 'legacy', chainId: 1, gasPrice: 1n, gas: 21000n, data: '0x6080' });
    expect(verdictOf(bytesOf(legacy)).reason).toMatch(/not an EIP-1559 transaction/);
  });
  it.each([
    ['type 1', serializeTransaction({ type: 'eip2930', chainId: 1, gasPrice: 1n, gas: 21000n, accessList: [] })],
    ['type 3', '0x03c0'],
    ['type 4', '0x04c0'],
  ])('%s', (_, payload) => {
    const r = verdictOf(bytesOf(payload as Hex));
    expect(r.verdict).toBe('CANNOT VERIFY');
    expect(r.reason).toMatch(/not an EIP-1559 transaction/);
  });
  it('32 bytes is a bare hash', () => {
    expect(verdictOf(bytesOf(KNOWN_DIGEST)).verdict).toBe('BARE HASH');
  });
  it('a 66-byte 0x1901 payload', () => {
    const r = verdictOf(new Uint8Array([0x19, 0x01, ...new Uint8Array(64)]));
    expect(r.reason).toBe('typed-data (EIP-712) payload; not supported in this version');
  });
  it('an EIP-191 payload', () => {
    const r = verdictOf(new TextEncoder().encode('\x19Ethereum Signed Message:\n32' + 'x'.repeat(32)));
    expect(r.reason).toBe('signed-message (EIP-191) payload; not supported in this version');
  });
  it('empty input', () => {
    expect(verdictOf(new Uint8Array()).reason).toBe('the payload is empty');
  });
  it('trailing bytes', () => {
    expect(verdictOf(bytesOf((KNOWN_PAYLOAD + '00') as Hex)).verdict).toBe('CANNOT VERIFY');
  });
  it('a leading-zero integer', () => {
    // nonce written as 0x0000 (two bytes) instead of the empty string
    const fields = ['0x01', '0x0000', '0x3b9aca00', '0x77359400', '0xb53f22', '0x', '0x', '0x6080', []] as const;
    const payload = ('0x02' + toRlp(fields as unknown as Hex[]).slice(2)) as Hex;
    const r = verdictOf(bytesOf(payload));
    expect(r.verdict).toBe('CANNOT VERIFY');
    expect(r.reason).toMatch(/canonical/);
  });
  it('a max priority fee above the max fee (viem refuses to parse it)', () => {
    const fields = ['0x01', '0x', '0x03', '0x02', '0xb53f22', '0x', '0x', '0x6080', []] as const;
    const payload = ('0x02' + toRlp(fields as unknown as Hex[]).slice(2)) as Hex;
    const r = verdictOf(bytesOf(payload));
    expect(r.verdict).toBe('CANNOT VERIFY');
    expect(r.reason).toMatch(/doesn't parse.*tip/i);
  });
  it('an unknown first byte', () => {
    expect(verdictOf(new Uint8Array([0x7f, 0xc0])).reason).toMatch(/first byte 0x7f/);
  });
  it('a 45 KB payload cut short at several points', () => {
    const r = rng(45);
    const big: Tx = { ...KNOWN, data: r.hex(45_459) as Hex, gas: 13_783_094n };
    const full = bytesOf(serializeTx(big));
    expect(full.length).toBe(45_485);
    for (const cut of [1, 2, 3, 10, 100, 45_000, full.length - 30, full.length - 2, full.length - 1]) {
      const v = compare(parsePayload(full.slice(0, cut)), expectedFrom(big));
      expect(v.verdict).not.toBe('MATCH');
    }
    expect(compare(parsePayload(full), expectedFrom(big)).verdict).toBe('MATCH');
  });
  it('invalid expected fields give CANNOT VERIFY, never MATCH', () => {
    for (const e of [
      { ...expectedFrom(KNOWN), value: '1.5' }, { ...expectedFrom(KNOWN), nonce: -1 }, { ...expectedFrom(KNOWN), to: '0x123' },
      { ...expectedFrom(KNOWN), dataHash: '0x12' }, { ...expectedFrom(KNOWN), data: '0x608' }, { ...expectedFrom(KNOWN), gas: 1.5 as unknown as string },
      { ...expectedFrom(KNOWN), accessList: 'none' as unknown as [] }, { ...expectedFrom(KNOWN), accessList: [{ address: HOLDER, storageKeys: ['0x12'] }] },
      { ...expectedFrom(KNOWN), accessList: [{ address: HOLDER } as unknown as { address: string; storageKeys: string[] }] },
      { ...callExpected(), call: { signature: 'not a function', args: [] } }, { ...callExpected(), call: { signature: 'mint(address,uint256)', args: [HOLDER] } },
      { ...callExpected(), call: { signature: 'mint(address,uint256)', args: ['0x12', '1'] } },
    ] as Expected[]) {
      const r = check(KNOWN_PAYLOAD, e);
      expect(r.verdict, JSON.stringify(e)).toBe('CANNOT VERIFY');
      expect(r.reason).toMatch(/not valid/);
    }
  });
});

describe('7. creations', () => {
  it('44,545 random bytes: length and hash', () => {
    const data = rng(1).hex(44_545) as Hex;
    const tx: Tx = { ...KNOWN, data };
    const d = decode(tx, serializeTx(tx));
    expect(d.dataBytes).toBe(44_545);
    expect(d.dataHash).toBe(keccak256(data));
    expect(d.payloadBytes).toBe(44_571);
  });
  it('CREATE(deployer-1, 0, 1, 2) gives the pinned addresses', () => {
    const want = ['0x06Fbac10db58E960Aa3D6Ff94554426e6c1AbE50', '0x6C7673ADB5A352155A92158B6A5A63dFb9b7FAe1', '0x8d30Bf3c76cb7B6eb67bAA24720dEaAC21ea4E5e'];
    want.forEach((a, n) => {
      expect(getContractAddress({ from: DEPLOYER_1, nonce: BigInt(n) })).toBe(a);
      const tx: Tx = { ...KNOWN, nonce: n };
      expect(check(serializeTx(tx), { from: DEPLOYER_1, expectedAddress: a, nonce: n }).verdict).toBe('PARTIAL');
    });
  });
  it('the 49,152-byte warning fires above the limit only', () => {
    const at = { ...KNOWN, data: rng(2).hex(INITCODE_MAX) as Hex };
    const over = { ...KNOWN, data: rng(2).hex(INITCODE_MAX + 1) as Hex };
    expect(decode(at, serializeTx(at)).warnings.join()).not.toMatch(/init code/);
    expect(decode(over, serializeTx(over)).warnings.join()).toMatch(/init code is longer than 49152/);
  });
  it('the gas-cap warning fires at 16,777,216', () => {
    const below = { ...KNOWN, gas: GAS_CAP - 1n };
    const at = { ...KNOWN, gas: GAS_CAP };
    expect(decode(below, serializeTx(below)).warnings).toEqual([]);
    expect(decode(at, serializeTx(at)).warnings.join()).toMatch(/gas limit is 16777216 or more/);
  });
  it('every other warning', () => {
    const tx: Tx = { ...KNOWN, data: '0x', chainId: 999, value: 1n, accessList: [{ address: TOKEN, storageKeys: [] }], to: '0x0000000000000000000000000000000000000000' };
    const d = decode(tx, serializeTx(tx));
    expect(d.warnings).toHaveLength(4);
    expect(d.chain.name).toMatch(/Unknown chain/);
    expect(d.kind).toBe('plain transfer');
  });
  it('chain names', () => {
    for (const [id, name] of [[84532, 'Base Sepolia'], [31337, 'Local test chain'], [1337, 'Local test chain'], [1, 'Chain ID 1: Fork of Ethereum mainnet']] as const) {
      const tx = { ...KNOWN, chainId: id };
      expect(decode(tx, serializeTx(tx)).chain.name).toContain(name);
    }
  });
});

describe('8. calls', () => {
  it('mint(address,uint256) decodes and re-encodes', () => {
    const v = decodeCall(mintData, 'mint(address,uint256)');
    expect(v).toMatchObject({ decoded: true, signature: 'mint(address,uint256)', selector: '0x40c10f19' });
    expect(v.decoded && v.args.map((a) => a.value)).toEqual([HOLDER, 7000n * 10n ** 18n]);
    expect(decode(CALL, serializeTx(CALL), 'mint(address to, uint256 amount)').call).toMatchObject({ decoded: true });
  });
  it('a wrong signature is caught by the selector', () => {
    const r = check(serializeTx(CALL), { ...callExpected(), call: { signature: 'burn(address,uint256)', args: [HOLDER, '1'] } });
    expect(r.verdict).toBe('MISMATCH');
    expect(r.differences[0]!.field).toBe('function');
    expect(decodeCall(mintData, 'burn(address,uint256)')).toMatchObject({ decoded: false });
  });
  it('trailing calldata bytes are caught', () => {
    const tx = { ...CALL, data: (mintData + '00') as Hex };
    const r = check(serializeTx(tx), callExpected());
    expect(r.verdict).toBe('MISMATCH');
    expect(r.differences.map((d) => d.field)).toEqual(['data']);
  });
  it('no signature: selector only', () => {
    expect(decodeCall(mintData)).toEqual({ decoded: false, selector: '0x40c10f19', note: 'function not decoded (no signature entered)' });
    expect(decode(CALL, serializeTx(CALL)).call).toMatchObject({ decoded: false });
  });
  it('data that does not decode', () => {
    expect(decodeCall('0x40c10f1900', 'mint(address,uint256)')).toMatchObject({ decoded: false, note: "the data doesn't decode with the signature entered" });
    const r = check(serializeTx({ ...CALL, data: '0x40c10f1900' }), callExpected());
    expect(r.verdict).toBe('MISMATCH');
    expect(r.differences[0]!.field).toBe('function');
  });
  it('arrays, tuples, booleans and signed integers', () => {
    const abi = parseAbi(['function f((address a, uint256[] b) t, bool c, int8 d, bytes e, string s)']);
    const args = [{ a: HOLDER, b: [1n, 2n] }, true, -3, '0xabcd', 'hi'] as const;
    const data = encodeFunctionData({ abi, args: args as never });
    const tx = { ...CALL, data };
    const sig = 'f((address a, uint256[] b) t, bool c, int8 d, bytes e, string s)';
    const base = { ...expectedFrom(tx), data: undefined };
    expect(check(serializeTx(tx), { ...base, call: { signature: sig, args: [{ a: HOLDER, b: ['1', 2] }, 'true', '-3', '0xabcd', 'hi'] } }).verdict).toBe('MATCH');
    expect(check(serializeTx(tx), { ...base, call: { signature: sig, args: [[HOLDER, ['1', '2']], false, -3, '0xabcd', 'hi'] } }).verdict).toBe('MISMATCH');
    expect(check(serializeTx(tx), { ...base, call: { signature: sig, args: [{ a: HOLDER, b: '1' }, true, -3, '0xabcd', 'hi'] } }).verdict).toBe('CANNOT VERIFY');
    expect(check(serializeTx(tx), { ...base, call: { signature: sig, args: [{ a: HOLDER, b: [] }, 'yes', -3, '0xabcd', 'hi'] } }).verdict).toBe('CANNOT VERIFY');
  });
  it('a "function" prefix and an event are handled', () => {
    expect(decodeCall(mintData, 'function mint(address,uint256)')).toMatchObject({ decoded: true });
    expect(check(serializeTx(CALL), { ...callExpected(), call: { signature: 'event Transfer(address,uint256)', args: [] } }).verdict).toBe('CANNOT VERIFY');
  });
});
