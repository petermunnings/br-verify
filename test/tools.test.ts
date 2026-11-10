import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { encodeDeployData, keccak256, parseAbi, type Hex } from 'viem';
import { fromBundle, readExpected } from '../src/adapters/index.js';
import { checkArtifact, initcode } from '../src/cli/initcode.js';
import { main, pick, type Io } from '../src/cli/main.js';
import { readPayloadText, serializeTx, type Tx } from '../src/core/payload.js';
import { checkNonce, CHAIN_1_RPC_NOTE } from '../src/rpc/nonce.js';
import { arg, decodedRows, parseJsonText, record, verdictText, verify, visible } from '../src/view/report.js';
import { DEPLOYER_1, KNOWN, KNOWN_PAYLOAD, expectedFrom, rng } from './helpers.js';

const fixture = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')) as Record<string, unknown>;
const META = fixture('metadata-mint.json');
const MINT = fixture('bundle-call.json');
const MINT_TX: Tx = {
  ...KNOWN, nonce: 0, gas: 309_938n, to: '0x1000000000000000000000000000000000000001', data: MINT.data as Hex,
};
const reading = (tx: Tx) => readPayloadText(serializeTx(tx))[0]!;

describe('adapters', () => {
  it('metaData maps onto the expected fields, and its digest is ignored', () => {
    const r = readExpected(META);
    expect(r.format).toBe('metaData');
    expect(r.expected).toEqual({
      chainId: 1, nonce: 0, from: META.from, to: META.to, value: '0', gas: '309938', maxFeePerGas: '2000000000',
      maxPriorityFeePerGas: '1000000000',
      call: { signature: 'mint(address,uint256)', args: ['0x2000000000000000000000000000000000000002', '7000000000000000000000'] },
    });
    expect(r.notes).toEqual({ source: 'metaData', toName: 'Test Token', ticket: 'BRA-420', keyLabel: 'test-minter' });
    // The fixture's digest is all zeros: the verdict comes from the payload only.
    const rep = verify(reading(MINT_TX), r.expected, r.notes);
    expect(rep.result.verdict).toBe('PARTIAL');
    expect(rep.result.notCompared).toEqual(['accessList']);
    expect(verify(reading(MINT_TX), { ...r.expected, accessList: [] }).result.verdict).toBe('MATCH');
  });
  it('a value transfer in metaData expects empty data, and null fees are not entered', () => {
    const r = readExpected({ ...META, function: 'none (value transfer)', args: [], maxFeePerGas: null, maxPriorityFeePerGas: null, targetContract: undefined });
    expect(r.expected.data).toBe('0x');
    expect(r.expected.call).toBeUndefined();
    expect(r.expected.maxFeePerGas).toBeUndefined();
  });
  it('a real call bundle', () => {
    const r = readExpected(MINT);
    expect(r.format).toBe('bundle');
    expect(r.expected).toEqual({ chainId: 1, from: MINT.from, to: MINT.to, value: 0, data: MINT.data });
    expect(verify(reading(MINT_TX), r.expected).result.verdict).toBe('PARTIAL');
  });
  it('a creation bundle', () => {
    const r = fromBundle({ kind: 'create', chainId: 1, from: DEPLOYER_1, to: null, value: 0, data: '0x6080', initCodeHash: keccak256('0x6080'), expectedNonce: 0, expectedAddress: '0x06Fbac10db58E960Aa3D6Ff94554426e6c1AbE50', gasLimit: 11878178, artifact: { creationCodeHash: '0x01' }, constructorArgs: { admin: DEPLOYER_1 } });
    expect(r.expected).toMatchObject({ to: null, nonce: 0, dataHash: keccak256('0x6080'), gas: 11878178 });
    expect(r.notes.artifact).toEqual({ creationCodeHash: '0x01' });
    expect(r.notes.source).toBe('bundle');
  });
  it('message bundles and unknown kinds are refused', () => {
    expect(() => readExpected(fixture('bundle-message.json'))).toThrow(/EIP-191/);
    expect(() => fromBundle({ kind: 'other' })).toThrow(/unknown bundle kind/);
  });
  it('plain expected JSON with an unknown key is refused', () => {
    expect(readExpected({ chainId: 1 })).toMatchObject({ format: 'expected', notes: { source: 'expected' } });
    expect(() => readExpected({ chainId: 1, gasLimit: '1' })).toThrow(/unknown field: gasLimit/);
    expect(() => readExpected({ a: 1, b: 2 })).toThrow(/unknown fields: a, b/);
    expect(() => readExpected([])).toThrow(/JSON object/);
  });
  it('JSON text or base64 of JSON text', () => {
    expect(parseJsonText(' {"a":1} ')).toEqual({ a: 1 });
    expect(parseJsonText(Buffer.from('{"a":"é"}').toString('base64'))).toEqual({ a: 'é' });
  });
});

describe('view', () => {
  it('verdict wording for every verdict', () => {
    const v = (t: string) => verdictText({ verdict: t as never, reason: 'why', differences: [{ field: 'nonce', expected: '1', actual: '2' }], notCompared: ['gas'], dataComparedBy: 'keccak256', createAddress: null });
    expect(v('MATCH')).toMatchObject({ tone: 'green', headline: 'MATCH: the payload is the transaction you entered' });
    expect(v('MATCH').detail).toMatch(/keccak256/);
    expect(v('MISMATCH').detail).toBe('nonce: expected 1, payload has 2');
    expect(v('PARTIAL').headline).toBe('PARTIAL: the fields you entered match');
    expect(v('PARTIAL').detail).toBe('Compared: chain ID, nonce, max priority fee, max fee, to, value, data, access list.\nNot compared: gas limit. Check those against the ticket.');
    const onlyList = verdictText({ verdict: 'PARTIAL', reason: '', differences: [], notCompared: ['chainId', 'nonce', 'maxPriorityFeePerGas', 'maxFeePerGas', 'gas', 'to', 'value', 'data'], dataComparedBy: null, createAddress: null });
    expect(onlyList.headline).toBe('PARTIAL: only the access list was compared');
    expect(v('NOT COMPARED').tone).toBe('grey');
    expect(v('CANNOT VERIFY').detail).toBe('why. Reject unless the ticket explains why.');
    expect(v('BARE HASH').headline).toBe('BARE HASH: reject');
  });
  it('arguments: long bytes as length and hash, structures walked', () => {
    const long = `0x${'ab'.repeat(65)}` as Hex;
    expect(arg(long)).toBe(`65 bytes, keccak256 ${keccak256(long)}`);
    expect(arg([1n, true, { a: 'x' }])).toBe('[1, true, {a: x}]');
    expect(arg(undefined)).toBe('undefined');
  });
  it('the decoded view of a call, with the name as entered', () => {
    const rep = verify(reading(MINT_TX), { call: { signature: 'mint(address to, uint256 amount)', args: [] } }, { toName: 'Test Token' });
    const rows = Object.fromEntries(decodedRows(rep));
    expect(rows.To).toBe('0x1000000000000000000000000000000000000001 (Test Token: name as entered, not verified)');
    expect(rows.Function).toBe('mint(address,uint256) (selector 0x40c10f19 matches; the name is as entered, not verified)');
    expect(rows['  2. uint256']).toBe('7000000000000000000000 (amount: name as entered, not verified)');
    expect(rows['Max fee']).toBe('2,000,000,000 wei (2 gwei)');
  });
  it('the decoded view of an undecoded call and of a creation with from', () => {
    const rows = Object.fromEntries(decodedRows(verify(reading(MINT_TX))));
    expect(rows.Function).toBe('0x40c10f19: function not decoded (no signature entered)');
    const big: Tx = { ...KNOWN, data: rng(3).hex(100) as Hex, accessList: [{ address: DEPLOYER_1, storageKeys: [] }] };
    const c = Object.fromEntries(decodedRows(verify(reading(big), { from: DEPLOYER_1 })));
    expect(c['CREATE address']).toMatch(/^0x06Fbac10db58E960Aa3D6Ff94554426e6c1AbE50 \(from 0x2954.*signKeyName/);
    expect(c['Data preview']).toMatch(/^0x[0-9a-f]{32}…[0-9a-f]{32}$/);
    expect(c['Access list']).toBe(`${DEPLOYER_1} []`);
    expect(decodedRows(verify({ encoding: 'hex', bytes: new Uint8Array(32) }))).toEqual([]);
  });
  it('the result record', () => {
    const now = new Date('2026-11-10T08:00:00.123Z');
    const m = record(verify(reading(KNOWN), { ...expectedFrom(KNOWN), from: DEPLOYER_1 }), now).split('\n');
    expect(m[0]).toBe('br-verify dev (commit dev), 2026-11-10T08:00:00Z');
    expect(m.slice(1)).toEqual([
      'Verdict: MATCH (data compared as bytes)',
      'Expected fields from: typed in',
      'Payload: 24 bytes, keccak256 0x3e0439a8c03f175b15faa919d8bd271e056f0427502cbe9b4fbc091dff37ca40',
      `Chain 1 · nonce 0 · contract creation · init-code hash ${keccak256('0x6080')} · 2 bytes`,
      `CREATE address 0x06Fbac10db58E960Aa3D6Ff94554426e6c1AbE50 (from ${DEPLOYER_1}, as entered)`,
      "signKeyName in DETAILS: br-verify can't see it. Check it is the key the ticket names",
      'Gas limit 11,878,178 · max fee 2,000,000,000 wei · max priority fee 1,000,000,000 wei · value 0 wei',
      'Access list: payload empty; expected empty',
      'Not compared: none',
    ]);
    const bad = record(verify(reading(MINT_TX), { nonce: 3, dataHash: keccak256(MINT.data as Hex) }), now);
    expect(bad).toMatch(/Verdict: MISMATCH\n/);
    expect(bad).toMatch(/Differs: nonce \(expected 3; payload 0\)/);
    expect(bad).toMatch(/contract call to 0x1000.* · selector 0x40c10f19 ·/);
    expect(bad).toMatch(/Access list: payload empty; expected not entered/);
    const dflt = record(verify(reading(KNOWN), { accessList: [] }, { accessListDefault: true }), now);
    expect(dflt).toMatch(/Access list: payload empty; expected empty \(the form's default\)/);
    const listed: Tx = { ...KNOWN, accessList: [{ address: DEPLOYER_1, storageKeys: [] }] };
    expect(record(verify(reading(listed), { accessList: [{ address: DEPLOYER_1, storageKeys: [] }] }), now)).toMatch(/Access list: payload 1 entries; expected 1 entries/);
    expect(record(verify({ encoding: 'base64', bytes: new Uint8Array(32) }), now)).toMatch(/Verdict: BARE HASH\nExpected fields from: nothing entered\nReason: .*\nPayload: 32 bytes, read as base64/);
    expect(record(verify(reading(KNOWN), { value: 'x' }), now)).toMatch(/Reason: what you entered is not valid/);
    expect(record(verify(reading(KNOWN)), now)).toMatch(/\nExpected fields from: nothing entered\n/);
  });
  it('names from metaData are marked as entered, and the record names the source', () => {
    // Marelize's review: a requester's metaData can give reassuring names to the arguments of a real call.
    const r = readExpected({ ...META, function: 'mint(address yourOwnSafe, uint256 readOnlyAmount)' });
    const rep = verify(reading(MINT_TX), { ...r.expected, accessList: [] }, r.notes);
    expect(rep.result.verdict).toBe('MATCH');
    const rows = Object.fromEntries(decodedRows(rep));
    expect(rows['  1. address']).toBe('0x2000000000000000000000000000000000000002 (yourOwnSafe: name as entered, not verified)');
    expect(rows.Function).toMatch(/the name is as entered, not verified/);
    expect(record(rep, new Date())).toMatch(/\nExpected fields from: metaData \(written by the requester's machine\)\n/);
    const b = readExpected(MINT);
    expect(record(verify(reading(MINT_TX), b.expected, b.notes), new Date())).toMatch(/Expected fields from: a facility-book bundle/);
  });
  it('invisible and direction-changing characters are shown as code points', () => {
    expect(visible('ab\u202Ecd\u200B\uFEFF\n')).toBe('ab[U+202E]cd[U+200B][U+FEFF][U+000A]');
    expect(visible('plain · text … ×')).toBe('plain · text … ×');
    expect(arg('safe\u202Eexe.txt')).toBe('safe[U+202E]exe.txt');
    expect(arg({ ['k\u2066']: 'v' })).toBe('{k[U+2066]: v}');
    const rows = Object.fromEntries(decodedRows(verify(reading(MINT_TX), {}, { toName: 'Token\u202E' })));
    expect(rows.To).toMatch(/\(Token\[U\+202E\]: name as entered/);
    const v = verdictText({ verdict: 'CANNOT VERIFY', reason: 'bad \u2067x', differences: [], notCompared: [], dataComparedBy: null, createAddress: null });
    expect(v.detail).toBe('bad [U+2067]x. Reject unless the ticket explains why.');
  });
});

describe('initcode', () => {
  const abi = parseAbi(['constructor(address admin, bytes code, (address a, uint8 b) t)']);
  const creation = '0x6080604052' as Hex;
  const longCode = rng(9).hex(100) as Hex;
  const data = encodeDeployData({ abi, bytecode: creation, args: [DEPLOYER_1, longCode, { a: DEPLOYER_1, b: 7 }] });
  const artifact = { abi, bytecode: { object: creation } };
  it('checks the creation code and decodes the constructor arguments', () => {
    const { view, checks } = checkArtifact(data, artifact, 'X.json');
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(view.creationHash).toBe(keccak256(creation));
    expect(view.args.map((a) => [a.name, a.value])).toEqual([
      ['admin', DEPLOYER_1], ['code', `100 bytes, keccak256 ${keccak256(longCode)}`], ['t', ''], ['t.a', DEPLOYER_1], ['t.b', '7'],
    ]);
  });
  it('refuses unlinked libraries and missing bytecode; catches a wrong prefix and bad arguments', () => {
    expect(() => checkArtifact(data, { bytecode: { object: '0x60__$abc$__' } }, 'x')).toThrow(/unlinked/);
    expect(() => checkArtifact(data, { bytecode: {} }, 'x')).toThrow(/no bytecode/);
    expect(checkArtifact(data, { abi, bytecode: '0x6081' }, 'x').checks[0]!.ok).toBe(false);
    expect(checkArtifact(`${creation}00`, artifact, 'x').checks[1]).toMatchObject({ name: 'constructor arguments decode', ok: false });
    const extra = `${data}00` as Hex;
    expect(checkArtifact(extra, artifact, 'x').checks[1]).toMatchObject({ ok: false });
  });
  it('verdicts', () => {
    const h = keccak256(data);
    expect(initcode({ data, expectHash: h }).verdict).toBe('MATCH');
    expect(initcode({ data, expectHash: h, from: DEPLOYER_1, nonce: 0, expectAddress: '0x06Fbac10db58E960Aa3D6Ff94554426e6c1AbE50' }).verdict).toBe('MATCH');
    expect(initcode({ data, expectHash: h, expectAddress: '0x06Fbac10db58E960Aa3D6Ff94554426e6c1AbE50' }).verdict).toBe('PARTIAL');
    expect(initcode({ data, expectHash: keccak256('0x00') }).verdict).toBe('MISMATCH');
    expect(initcode({ data }).verdict).toBe('NOT COMPARED');
    expect(initcode({ data, bundle: { initCodeHash: keccak256('0x00') } }).verdict).toBe('MISMATCH');
    expect(initcode({ data, expectHash: h, artifact: { json: { bytecode: {} }, name: 'x' } }).verdict).toBe('CANNOT VERIFY');
    expect(initcode({ data, expectHash: h, artifact: { json: artifact, name: 'x' }, bundle: { creationCodeHash: keccak256(creation) } }).verdict).toBe('MATCH');
    expect(initcode({ data: rng(4).hex(49_153) as Hex }).warnings[0]).toMatch(/49152/);
  });
});

describe('11. nonce check (mocked fetch)', () => {
  const FROM = '0x3000000000000000000000000000000000000003';
  const rpc = (answers: Record<string, unknown>) => vi.fn(async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(init.body as string) as { method: string; params: string[] };
    const a = answers[method === 'eth_getTransactionCount' ? `count:${params[1]}` : method];
    if (a instanceof Error) throw a;
    return { ok: a !== 'http500', status: a === 'http500' ? 500 : 200, json: async () => (typeof a === 'object' ? a : { result: a }) };
  });
  const ok = { eth_chainId: '0x14a34', 'count:latest': '0x5', 'count:pending': '0x5' };
  it('in order', async () => {
    const r = await checkNonce('https://rpc.example', FROM, 84532, 5, rpc(ok));
    expect(r).toMatchObject({ status: 'in order', latest: 5, pending: 5 });
    expect(r.text).toBe('Next nonce on chain: 5; this request: 5. In order.');
  });
  it('already used, and ahead (with pending)', async () => {
    expect((await checkNonce('https://rpc.example', FROM, 84532, 4, rpc(ok))).status).toBe('already used');
    const r = await checkNonce('https://rpc.example', FROM, 84532, 7, rpc({ ...ok, 'count:pending': '0x6' }));
    expect(r.status).toBe('ahead');
    expect(r.text).toMatch(/5 \(6 counting pending transactions\)/);
  });
  it('chain mismatch', async () => {
    expect((await checkNonce('https://rpc.example', FROM, 1, 5, rpc(ok))).status).toBe('chain mismatch');
  });
  it('RPC errors, with the chain 1 note', async () => {
    const r = await checkNonce('https://rpc.example', FROM, 1, 5, rpc({ eth_chainId: { error: { message: 'nope' } } }));
    expect(r.status).toBe('error');
    expect(r.text).toContain('eth_chainId: nope');
    expect(r.text).toContain(CHAIN_1_RPC_NOTE);
    expect((await checkNonce('https://rpc.example', FROM, 1, 0, rpc({ eth_chainId: 'http500' }))).text).toMatch(/HTTP 500/);
    expect((await checkNonce('https://rpc.example', FROM, 1, 0, rpc({ eth_chainId: 'zz' }))).text).toMatch(/not a hex quantity/);
    expect((await checkNonce('https://rpc.example', FROM, 1, 0, rpc({ eth_chainId: new Error('offline') }))).text).toMatch(/offline/);
    expect((await checkNonce('https://rpc.example', FROM, 1, 0, rpc({ eth_chainId: { error: {} } }))).text).toMatch(/RPC error/);
    expect((await checkNonce('https://rpc.example', FROM, 1, 0, vi.fn(async () => { throw 'x'; }))).text).toMatch(/failed: x/);
  });
  it('refuses a bad URL or from without calling anything', async () => {
    const f = rpc(ok);
    expect((await checkNonce('ftp://x', FROM, 1, 0, f)).status).toBe('error');
    expect((await checkNonce('https://x', '', 1, 0, f)).text).toMatch(/Enter "from"/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('the CLI', () => {
  const files: Record<string, string> = {
    'known.txt': KNOWN_PAYLOAD,
    'b64.txt': Buffer.from(KNOWN_PAYLOAD.slice(2), 'hex').toString('base64'),
    'bad.txt': 'not a payload!',
    'exp.json': JSON.stringify(expectedFrom(KNOWN)),
    'meta.json': JSON.stringify(META),
    'mint.txt': serializeTx(MINT_TX),
    'data.txt': '0x6080',
  };
  const run = async (args: string[], extra: Partial<Io> = {}) => {
    const out: string[] = []; const err: string[] = [];
    const code = await main(args, {
      out: (s) => out.push(s), err: (s) => err.push(s), now: () => new Date('2026-11-10T08:00:00Z'),
      readFile: (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]!; }, ...extra,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  it('decode: NOT COMPARED, exit 2', async () => {
    const r = await run(['decode', 'known.txt']);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/NOT COMPARED/);
    expect(r.out).toMatch(/Digest the HSM signs +keccak256\(payload\) 0x3e04/);
  });
  it('compare: MATCH exit 0, MISMATCH exit 1, with --json and --record', async () => {
    expect((await run(['compare', '--payload', 'b64.txt', '--expected', 'exp.json'])).code).toBe(0);
    const m = await run(['compare', '--payload', 'known.txt', '--expected', '{"nonce": 1}', '--json']);
    expect(m.code).toBe(1);
    expect(JSON.parse(m.out)).toMatchObject({ verdict: 'MISMATCH', encoding: 'hex', result: { differences: [{ field: 'nonce' }] } });
    const rec = await run(['compare', '--payload', 'known.txt', '--expected', 'exp.json', '--record']);
    expect(rec.out.split('\n')[1]).toBe('Verdict: MATCH (data compared as bytes)');
  });
  it('compare with metaData says it ignores the digest', async () => {
    const r = await run(['compare', '--payload', 'mint.txt', '--expected', 'meta.json']);
    expect(r.err).toMatch(/read as metaData\. Its digest is ignored/);
    expect(r.out).toMatch(/PARTIAL/);
  });
  it('--from must agree with "from" in the expected fields (Marelize\'s review)', async () => {
    const other = '0x4000000000000000000000000000000000000004';
    const r = await run(['compare', '--payload', 'mint.txt', '--expected', 'meta.json', '--from', other]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/CANNOT VERIFY: --from 0x4000\S+ differs from "from" in the expected fields \(0x3000\S+\)\. br-verify won't choose between them/);
    const same = await run(['compare', '--payload', 'mint.txt', '--expected', 'meta.json', '--from', String(META.from), '--json']);
    expect(JSON.parse(same.out).verdict).toBe('PARTIAL');
    expect((await run(['compare', '--payload', 'known.txt', '--expected', '{"nonce": 0}', '--from', other, '--record'])).out).toMatch(/Verdict: PARTIAL/);
  });
  it('the nonce check is opt-in and separate', async () => {
    const fetch = vi.fn(async (_u: string, init: RequestInit) => ({ ok: true, status: 200, json: async () => ({ result: JSON.parse(init.body as string).method === 'eth_chainId' ? '0x1' : '0x0' }) }));
    const r = await run(['decode', 'known.txt', '--rpc', 'http://127.0.0.1:8545', '--from', DEPLOYER_1], { fetch: fetch as never });
    expect(r.out).toMatch(/Nonce check \(separate from the verdict\): Next nonce on chain: 0; this request: 0\. In order\. This result comes from the RPC you entered/);
    expect((await run(['decode', 'known.txt'])).out).not.toMatch(/Nonce check/);
  });
  it('unreadable payloads, bad arguments and usage', async () => {
    expect(await run(['decode', 'bad.txt'])).toMatchObject({ code: 2, out: expect.stringMatching(/CANNOT VERIFY: br-verify can't verify this payload \(the text is neither hex nor base64\)/) });
    expect(JSON.parse((await run(['decode', 'bad.txt', '--json'])).out)).toMatchObject({ verdict: 'CANNOT VERIFY' });
    expect((await run(['decode'])).err).toMatch(/decode needs a file/);
    expect((await run(['compare', '--payload', 'known.txt'])).err).toMatch(/needs --expected/);
    expect((await run(['compare', '--expected', '{}'])).err).toMatch(/needs --payload/);
    expect((await run(['decode', 'missing.txt'])).err).toMatch(/ENOENT/);
    expect((await run(['frobnicate'])).err).toMatch(/unknown command/);
    expect((await run(['--bogus'])).code).toBe(2);
    expect(await run([])).toMatchObject({ code: 2, out: expect.stringMatching(/Exit codes/) });
    expect((await run(['--help'])).code).toBe(0);
    expect((await run(['--version'])).out).toBe('br-verify dev (commit dev)');
  });
  it('initcode with --data, pins, --record and --json', async () => {
    const h = keccak256('0x6080');
    const r = await run(['initcode', '--data', 'data.txt', '--from', DEPLOYER_1, '--nonce', '0', '--expect-hash', h, '--expect-address', '0x06Fbac10db58E960Aa3D6Ff94554426e6c1AbE50']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/MATCH: the init code has the hash you entered/);
    const rec = await run(['initcode', '--data', 'data.txt', '--expect-hash', keccak256('0x6081'), '--record']);
    expect(rec.code).toBe(1);
    expect(rec.out).toMatch(/DIFFERS: init-code hash \(you\)/);
    expect(JSON.parse((await run(['initcode', '--data', 'data.txt', '--json'])).out)).toMatchObject({ verdict: 'NOT COMPARED', bytes: 2 });
    expect((await run(['initcode', '--data', 'data.txt', '--nonce', '-1'])).err).toMatch(/--nonce/);
    expect((await run(['initcode'])).err).toMatch(/needs --data/);
    expect((await run(['initcode', '--data', 'bad.txt'])).err).toMatch(/--data: the text is neither/);
  });
  it('initcode --bundle and --artifact', async () => {
    const abi = parseAbi(['constructor(address admin)']);
    const data = encodeDeployData({ abi, bytecode: '0x6080', args: [DEPLOYER_1] });
    files['bundle.json'] = JSON.stringify({ name: 'D1', kind: 'create', chainId: 1, from: DEPLOYER_1, keyPolicyRule: 'x', to: null, value: 0, expectedNonce: 0, data, initCodeHash: keccak256(data), payloadBytes: 34, expectedAddress: '0x06Fbac10db58E960Aa3D6Ff94554426e6c1AbE50', artifact: { creationCodeHash: keccak256('0x6080') } });
    files['artifact.json'] = JSON.stringify({ abi, bytecode: { object: '0x6080' } });
    const r = await run(['initcode', '--bundle', 'bundle.json', '--artifact', 'artifact.json', '--expect-hash', keccak256(data)]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/admin \(address\) +0x2954/);
    const rec = await run(['initcode', '--bundle', 'bundle.json', '--artifact', 'artifact.json', '--record']);
    expect(rec.out).toMatch(/Artifact artifact.json: creation code 2 bytes/);
    // --from and --nonce must agree with the bundle; br-verify won't choose between them.
    const other = '0x4000000000000000000000000000000000000004';
    expect((await run(['initcode', '--bundle', 'bundle.json', '--from', other])).err).toMatch(/--from 0x4000\S+ differs from the bundle's "from"/);
    expect((await run(['initcode', '--bundle', 'bundle.json', '--nonce', '1'])).err).toMatch(/--nonce 1 differs from the bundle's "expectedNonce" \(0\)/);
    expect((await run(['initcode', '--bundle', 'bundle.json', '--from', DEPLOYER_1.toLowerCase(), '--nonce', '0', '--expect-hash', keccak256(data)])).code).toBe(0);
    files['call.json'] = JSON.stringify(MINT);
    expect((await run(['initcode', '--bundle', 'call.json'])).err).toMatch(/contract-creation bundle/);
    files['nonce-less.json'] = JSON.stringify({ kind: 'create', keyPolicyRule: 'x', to: null, data: '0x6080' });
    expect((await run(['initcode', '--bundle', 'nonce-less.json'])).out).toMatch(/not computed/);
    files['bad-art.json'] = JSON.stringify({ bytecode: { object: '0x60__$x$__' } });
    expect((await run(['initcode', '--bundle', 'bundle.json', '--artifact', 'bad-art.json', '--record'])).out).toMatch(/Reason: .*unlinked/);
  });
  it('an ambiguous reading needs --encoding', () => {
    // Real payload text can't read two ways (see the core tests), so test the picker directly.
    const two = [{ encoding: 'hex' as const, bytes: new Uint8Array([2]) }, { encoding: 'base64' as const, bytes: new Uint8Array([3]) }];
    expect(pick(two)).toBe('the payload text reads as both hex and base64; choose with --encoding');
    expect(pick(two, 'base64')).toBe(two[1]);
    expect(pick([])).toBe('the text is neither hex nor base64');
  });
});

describe('payload size', () => {
  it('a 100 KB payload decodes and compares quickly', () => {
    const tx: Tx = { ...KNOWN, data: rng(100).hex(100_000) as Hex };
    const text = Buffer.from(serializeTx(tx).slice(2), 'hex').toString('base64');
    const t0 = performance.now();
    const rep = verify(readPayloadText(text)[0]!, expectedFrom(tx));
    const ms = performance.now() - t0;
    expect(rep.result.verdict).toBe('MATCH');
    expect(ms).toBeLessThan(1000);
  });
});
