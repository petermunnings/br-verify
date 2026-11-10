// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256, type Hex } from 'viem';
import { serializeTx, type Tx } from '../src/core/payload.js';
import { DEPLOYER_1, KNOWN, rng } from './helpers.js';

(globalThis as { __BR_TEST__?: boolean }).__BR_TEST__ = true;
const page = readFileSync('src/web/page.html', 'utf8').replace('__CSP__', '').replace('__STYLE__', '').replace('<script>__SCRIPT__</script>', '');
let mount: typeof import('../src/web/main.js').mount;
beforeAll(async () => { ({ mount } = await import('../src/web/main.js')); });

const D3: Tx = { ...KNOWN, nonce: 2, gas: 13_783_094n, data: rng(3).hex(45_459) as Hex };
const D3_PAYLOAD = serializeTx(D3);
const D3_B64 = Buffer.from(D3_PAYLOAD.slice(2), 'hex').toString('base64');
const D3_EXPECTED = { chainId: 1, nonce: 2, maxPriorityFeePerGas: '1000000000', maxFeePerGas: '2000000000', gas: '13783094', to: null, value: '0', dataHash: keccak256(D3.data), accessList: [], from: DEPLOYER_1, expectedAddress: '0x8d30Bf3c76cb7B6eb67bAA24720dEaAC21ea4E5e' };

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
const clipboard = { readText: vi.fn(), writeText: vi.fn() };
function type(id: string, value: string) {
  const el = $<HTMLInputElement | HTMLTextAreaElement>(id);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  vi.runAllTimers();
}
const verdict = () => $('verdict').querySelector('.headline')!.textContent;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.innerHTML = page.replace(/^[\s\S]*?<html[^>]*>/, '').replace(/<\/html>\s*$/, '');
  clipboard.readText.mockReset(); clipboard.writeText.mockReset();
  mount(document, { navigator: { clipboard } as unknown as Navigator, setTimeout, clearTimeout });
});
afterEach(() => { vi.useRealTimers(); });

describe('the web page', () => {
  it('shows the version, the footer, and waits', () => {
    expect($('version').textContent).toBe('dev');
    expect($('footer').textContent).toMatch(/^br-verify checks that the payload matches what you entered/);
    expect(verdict()).toBe('Waiting for a payload');
    expect($<HTMLButtonElement>('copy').disabled).toBe(true);
  });
  it('a 45 KB base64 paste: byte count, decoded only, quickly, and no full data in the DOM', () => {
    const t0 = performance.now();
    type('payload', D3_B64);
    const ms = performance.now() - t0;
    expect($('count').textContent).toBe('45,485 bytes (read as base64)');
    // The access list defaults to empty, so a bare paste compares that one field.
    expect(verdict()).toBe('PARTIAL: the fields you entered match');
    expect($('verdict').textContent).toMatch(/Not compared: chain ID, nonce, max priority fee, max fee, gas limit, to, value, data\./);
    expect(ms).toBeLessThan(1000);
    expect(document.body.innerHTML).not.toContain(D3.data.slice(200, 400));
    const dd = [...document.querySelectorAll('#decoded dt')].map((x) => x.textContent);
    expect(dd).toContain('Init-code hash');
    expect($('nonce-chain1').hidden).toBe(false);
  });
  it('MATCH from expected JSON; MISMATCH when one field is changed', () => {
    type('payload', D3_B64);
    $<HTMLTextAreaElement>('json').value = JSON.stringify(D3_EXPECTED);
    $('json-use').click();
    vi.runAllTimers();
    expect($('json-status').textContent).toMatch(/^Read as expected\./);
    expect(verdict()).toBe('MATCH: the payload is the transaction you entered');
    expect($('verdict').className).toBe('verdict green');
    expect($('verdict').textContent).toMatch(/keccak256/);
    type('f-nonce', '3');
    expect(verdict()).toBe('MISMATCH: reject the request');
    expect($('verdict').textContent).toMatch(/nonce: expected 3, payload has 2/);
    type('f-nonce', '2');
    type('f-maxFeePerGas', '2,000,000,001');
    expect($('verdict').textContent).toMatch(/max fee: expected 2000000001/);
  });
  it('the form by hand: PARTIAL, then a call with a signature', () => {
    const call: Tx = { ...KNOWN, to: '0x1000000000000000000000000000000000000001', data: '0x40c10f19000000000000000000000000200000000000000000000000000000000000000200000000000000000000000000000000000000000000017b7883c06916600000' };
    type('payload', serializeTx(call));
    type('f-chainId', '1');
    expect(verdict()).toBe('PARTIAL: the fields you entered match');
    for (const [id, v] of [['f-nonce', '0'], ['f-value', '0'], ['f-gas', '11 878 178'], ['f-maxFeePerGas', '2000000000'], ['f-maxPriorityFeePerGas', '1000000000']]) type(id!, v!);
    (document.querySelector('input[name="kind"][value="call"]') as HTMLInputElement).checked = true;
    type('f-to', '0x1000000000000000000000000000000000000001');
    type('f-toName', 'Test Token');
    $<HTMLSelectElement>('f-accessList').value = 'empty';
    $('f-accessList').dispatchEvent(new Event('change', { bubbles: true }));
    type('f-signature', 'mint(address,uint256)');
    type('f-args', '0x2000000000000000000000000000000000000002\n7000000000000000000000');
    expect(verdict()).toBe('MATCH: the payload is the transaction you entered');
    expect($('decoded').textContent).toContain('Test Token: name as entered, not verified');
    type('f-args', '["0x2000000000000000000000000000000000000002", "7000000000000000000001"]');
    expect(verdict()).toBe('MISMATCH: reject the request');
    type('f-args', '[not json');
    expect(verdict()).toMatch(/CANNOT VERIFY/);
    type('f-args', '');
    type('f-data', '0x40c10f19');
    expect(verdict()).toMatch(/CANNOT VERIFY|MISMATCH/);
    $('clear-form').click();
    vi.runAllTimers();
    expect(verdict()).toBe('PARTIAL: the fields you entered match');
    expect($<HTMLSelectElement>('f-accessList').value).toBe('empty');
    $<HTMLSelectElement>('f-accessList').value = '';
    $('f-accessList').dispatchEvent(new Event('change', { bubbles: true }));
    vi.runAllTimers();
    expect(verdict()).toBe('NOT COMPARED: decoded only');
  });
  it('metaData JSON (base64) fills the form; bad JSON is reported', () => {
    const meta = JSON.parse(readFileSync('test/fixtures/metadata-mint.json', 'utf8'));
    $<HTMLTextAreaElement>('json').value = Buffer.from(JSON.stringify(meta)).toString('base64');
    $('json-use').click();
    expect($('json-status').textContent).toMatch(/Read as metaData\. Its "digest" is ignored/);
    expect($('f-signature').value).toBe('mint(address,uint256)');
    expect($('f-gas').value).toBe('309938');
    expect($('f-toName').value).toBe('Test Token');
    $<HTMLTextAreaElement>('json').value = '{"gasLimit": 1}';
    $('json-use').click();
    expect($('json-status').textContent).toBe('Not used: unknown field: gasLimit');
  });
  it('fail closed: unreadable text, a bare hash, and a signed transaction', () => {
    type('payload', 'not a payload!');
    expect(verdict()).toMatch(/^CANNOT VERIFY: br-verify can't read this text/);
    expect($('count').textContent).toMatch(/not readable as hex or base64/);
    type('payload', keccak256('0x00'));
    expect(verdict()).toBe('BARE HASH: reject');
    $('clear-payload').click();
    expect(verdict()).toBe('Waiting for a payload');
    expect($('count').textContent).toBe('Nothing pasted yet.');
  });
  it('Paste uses the clipboard, and falls back to a manual paste', async () => {
    clipboard.readText.mockResolvedValue(D3_PAYLOAD);
    $('paste').click();
    await flush();
    expect($('count').textContent).toBe('45,485 bytes (read as hex)');
    clipboard.readText.mockRejectedValue(new Error('denied'));
    $('paste').click();
    await flush();
    expect($('count').textContent).toMatch(/Long-press the box and choose Paste/);
  });
  it('Copy result writes the record, and shows it if copying is blocked', async () => {
    type('payload', D3_B64);
    clipboard.writeText.mockResolvedValue(undefined);
    $('copy').click();
    await flush();
    expect(clipboard.writeText.mock.calls[0]![0]).toMatch(/^br-verify dev \(commit dev\), .*\nVerdict: PARTIAL\n/);
    expect(clipboard.writeText.mock.calls[0]![0]).toMatch(/\nAccess list: payload empty; expected empty \(the form's default\)\n/);
    expect($('copy-status').textContent).toBe('Copied. Paste it into the Linear ticket.');
    clipboard.writeText.mockRejectedValue(new Error('no'));
    $('copy').click();
    await flush();
    expect($('record').hidden).toBe(false);
    expect($('record').textContent).toMatch(/Verdict: PARTIAL/);
  });
  it('the nonce check sends nothing until asked, and needs a decoded payload', async () => {
    const fetch = vi.fn(async (_u: string, init: RequestInit) => ({ ok: true, status: 200, json: async () => ({ result: JSON.parse(init.body as string).method === 'eth_chainId' ? '0x1' : '0x2' }) }));
    vi.stubGlobal('fetch', fetch);
    try {
      $('nonce-check').click();
      expect($('nonce-result').textContent).toBe('Paste a payload that decodes first.');
      type('payload', D3_B64);
      expect(fetch).not.toHaveBeenCalled();
      $<HTMLInputElement>('rpc').value = 'http://127.0.0.1:8545';
      $<HTMLInputElement>('f-from').value = DEPLOYER_1;
      $('nonce-check').click();
      await flush(); await flush();
      expect($('nonce-result').textContent).toMatch(/^Nonce check \(separate from the verdict\): Next nonce on chain: 2; this request: 2\. In order\./);
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally { vi.unstubAllGlobals(); }
  });
  it('a payload with an access list gives MISMATCH against the default', () => {
    const listed: Tx = { ...D3, accessList: [{ address: DEPLOYER_1, storageKeys: [] }] };
    type('payload', serializeTx(listed));
    expect(verdict()).toBe('MISMATCH: reject the request');
    expect($('verdict').textContent).toMatch(/access list: expected \[\], payload has/);
    expect($('warnings').textContent).toMatch(/The access list is not empty/);
  });
  it('expected JSON with an access list: shown as its own option, then the default again', () => {
    const list = [{ address: DEPLOYER_1, storageKeys: [] }];
    type('payload', serializeTx({ ...D3, accessList: list as Tx['accessList'] }));
    $<HTMLTextAreaElement>('json').value = JSON.stringify({ ...D3_EXPECTED, accessList: list });
    $('json-use').click();
    vi.runAllTimers();
    expect($<HTMLSelectElement>('f-accessList').value).toBe('json');
    expect(verdict()).toBe('MATCH: the payload is the transaction you entered');
    $<HTMLTextAreaElement>('json').value = JSON.stringify({ ...D3_EXPECTED, accessList: undefined });
    $('json-use').click();
    vi.runAllTimers();
    expect($<HTMLSelectElement>('f-accessList').value).toBe('empty');
    expect(document.querySelector('#f-accessList option[value="json"]')).toBeNull();
    expect(verdict()).toBe('MISMATCH: reject the request');
  });
  it('the encoding chooser stays hidden for one reading', () => {
    // Real text never reads two ways (core tests); the chooser is hidden for one reading.
    type('payload', D3_PAYLOAD);
    expect($<HTMLFieldSetElement>('choose').hidden).toBe(true);
  });
});
