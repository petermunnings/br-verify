// The page: plain DOM, no framework. Every value is written with textContent, never as HTML.
import { readExpected, type Notes } from '../adapters/index.js';
import type { Expected } from '../core/compare.js';
import { readPayloadText, type Reading } from '../core/payload.js';
import { checkNonce } from '../rpc/nonce.js';
import { COMMIT, decodedRows, FOOTER, grp, parseJsonText, record, verdictText, verify, VERSION, type Report } from '../view/report.js';

const FIELDS = ['chainId', 'nonce', 'value', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'dataHash', 'from', 'expectedAddress'] as const;
const NUMERIC = new Set(['chainId', 'nonce', 'value', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas']);

export function mount(doc: Document, win: { navigator: Navigator; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = window): void {
  const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => doc.getElementById(id) as T;
  const el = (tag: string, text = '', cls = '') => Object.assign(doc.createElement(tag), { textContent: text, className: cls });
  $('version').textContent = VERSION;
  $('commit').textContent = COMMIT;
  $('footer').textContent = FOOTER;

  let notes: Notes = {};
  // The access list defaults to "Empty". A non-empty list from pasted JSON gets its own option.
  let listFromJson: Expected['accessList'] = undefined;
  let listChosen = false;
  const listBox = () => $<HTMLSelectElement>('f-accessList');
  function resetList(): void {
    listBox().querySelector('option[value="json"]')?.remove();
    listBox().value = 'empty';
    listFromJson = undefined;
    listChosen = false;
  }
  let choice: number | null = null;
  let last: Report | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const kind = () => (doc.querySelector('input[name="kind"]:checked') as HTMLInputElement | null)?.value ?? '';
  const clean = (id: string, v: string) => (NUMERIC.has(id) ? v.replace(/[\s,_]/g, '') : v.trim());

  /** The form as `Expected`. An empty box is "not entered", never zero. */
  function expected(): Expected {
    const e: Record<string, unknown> = {};
    for (const f of FIELDS) { const v = clean(f, $(`f-${f}`).value); if (v !== '') e[f] = v; }
    if (kind() === 'create') e.to = null;
    if (kind() === 'call') e.to = $('f-to').value.trim();
    if (listBox().value === 'empty') e.accessList = [];
    if (listBox().value === 'json') e.accessList = listFromJson;
    const data = $<HTMLTextAreaElement>('f-data').value.replace(/\s+/g, '');
    if (data !== '') e.data = data;
    const sig = $('f-signature').value.trim();
    if (sig !== '') e.call = { signature: sig, args: args($<HTMLTextAreaElement>('f-args').value) };
    return e as Expected;
  }
  function args(text: string): unknown[] {
    const t = text.trim();
    if (t === '') return [];
    if (t.startsWith('[')) { try { return JSON.parse(t) as unknown[]; } catch { /* fall through to one per line */ } }
    return t.split('\n').map((x) => x.trim()).filter((x) => x !== '');
  }

  function fill(e: Expected, n: Notes): void {
    (doc.getElementById('expect') as HTMLFormElement).reset();
    resetList();
    for (const f of FIELDS) if (e[f] !== undefined) $(`f-${f}`).value = String(e[f]);
    const k = e.to === null ? 'create' : e.to !== undefined ? 'call' : '';
    (doc.querySelector(`input[name="kind"][value="${k}"]`) as HTMLInputElement).checked = true;
    $('f-to').value = typeof e.to === 'string' ? e.to : '';
    $('f-toName').value = n.toName ?? '';
    if (Array.isArray(e.accessList) && e.accessList.length > 0) {
      listFromJson = e.accessList;
      listBox().append(Object.assign(doc.createElement('option'), { value: 'json', textContent: `As in the pasted JSON (${e.accessList.length} entries)` }));
      listBox().value = 'json';
    }
    listChosen = e.accessList !== undefined;
    $<HTMLTextAreaElement>('f-data').value = e.data ?? '';
    $('f-signature').value = e.call?.signature ?? '';
    $<HTMLTextAreaElement>('f-args').value = e.call ? JSON.stringify(e.call.args) : '';
  }

  function readings(): Reading[] {
    const text = $<HTMLTextAreaElement>('payload').value;
    const rs = text.trim() === '' ? [] : readPayloadText(text);
    const count = $('count');
    if (text.trim() === '') count.textContent = 'Nothing pasted yet.';
    else if (rs.length === 0) count.textContent = `${grp(text.replace(/\s+/g, '').length)} characters, not readable as hex or base64.`;
    else count.textContent = rs.map((r) => `${grp(r.bytes.length)} bytes (read as ${r.encoding})`).join(' or ');
    const box = $<HTMLFieldSetElement>('choose');
    box.hidden = rs.length < 2;
    const opts = $('choose-options');
    opts.replaceChildren(...rs.map((r, i) => {
      const l = el('label', '', 'inline');
      const input = Object.assign(doc.createElement('input'), { type: 'radio', name: 'encoding', value: String(i), checked: choice === i });
      input.addEventListener('change', () => { choice = i; run(); });
      l.append(input, ` ${r.encoding}`);
      return l;
    }));
    return rs;
  }

  function show(rep: Report | null, message?: string): void {
    last = rep;
    const v = $('verdict');
    const t = rep ? verdictText(rep.result) : null;
    v.className = `verdict ${t?.tone ?? (message ? 'red' : 'grey')}`;
    v.replaceChildren(el('p', t?.headline ?? message ?? 'Waiting for a payload', 'headline'));
    if (t) for (const line of t.detail.split('\n')) v.append(el('p', line));
    $('warnings').replaceChildren(...(rep?.decoded?.warnings ?? []).map((w) => el('p', `Warning: ${w}`, 'warning')));
    $('decoded').replaceChildren(...(rep ? decodedRows(rep) : []).flatMap(([k, x]) => [el('dt', k), el('dd', x)]));
    $<HTMLButtonElement>('copy').disabled = rep === null;
    $('copy-status').textContent = '';
    $('record').hidden = true;
    $('nonce-chain1').hidden = !(rep?.parsed.ok && rep.parsed.tx.chainId === 1);
  }

  function run(): void {
    const rs = readings();
    const text = $<HTMLTextAreaElement>('payload').value;
    if (text.trim() === '') return show(null);
    if (rs.length === 0) return show(null, "CANNOT VERIFY: br-verify can't read this text as hex or base64. Reject unless the ticket explains why.");
    if (rs.length > 1 && (choice === null || choice >= rs.length)) return show(null, 'Choose the encoding above. Nothing was compared yet.');
    notes = { ...notes, toName: $('f-toName').value.trim() || undefined, accessListDefault: listBox().value === 'empty' && !listChosen };
    show(verify(rs[rs.length > 1 ? choice! : 0]!, expected(), notes));
  }
  const soon = () => { win.clearTimeout(timer); timer = win.setTimeout(run, 120); };

  $<HTMLTextAreaElement>('payload').addEventListener('input', () => { choice = null; readings(); soon(); });
  doc.getElementById('expect')!.addEventListener('input', soon);
  doc.getElementById('expect')!.addEventListener('change', soon);
  listBox().addEventListener('change', () => { listChosen = true; });
  $('paste').addEventListener('click', async () => {
    try {
      $<HTMLTextAreaElement>('payload').value = await win.navigator.clipboard.readText();
      choice = null; run();
    } catch {
      $<HTMLTextAreaElement>('payload').focus();
      $('count').textContent = 'This browser blocked reading the clipboard. Long-press the box and choose Paste.';
    }
  });
  $('clear-payload').addEventListener('click', () => { $<HTMLTextAreaElement>('payload').value = ''; choice = null; run(); });
  $('clear-form').addEventListener('click', () => { (doc.getElementById('expect') as HTMLFormElement).reset(); resetList(); notes = {}; run(); });
  $('json-use').addEventListener('click', () => {
    try {
      const r = readExpected(parseJsonText($<HTMLTextAreaElement>('json').value));
      notes = r.notes;
      fill(r.expected, r.notes);
      $('json-status').textContent = `Read as ${r.format}.${r.format === 'metaData' ? ' Its "digest" is ignored: only the payload counts.' : ''} Check the form against the ticket.`;
      run();
    } catch (e) {
      $('json-status').textContent = `Not used: ${e instanceof Error ? e.message : String(e)}`;
    }
  });
  $('copy').addEventListener('click', async () => {
    if (!last) return;
    const text = record(last, new Date());
    const pre = $('record');
    pre.textContent = text;
    try {
      await win.navigator.clipboard.writeText(text);
      $('copy-status').textContent = 'Copied. Paste it into the Linear ticket.';
    } catch {
      pre.hidden = false;
      $('copy-status').textContent = 'Copying was blocked. Select the text below and copy it.';
    }
  });
  $('nonce-check').addEventListener('click', async () => {
    const out = $('nonce-result');
    if (!last?.parsed.ok) { out.textContent = 'Paste a payload that decodes first.'; return; }
    out.textContent = 'Checking…';
    const r = await checkNonce($('rpc').value, $('f-from').value, last.parsed.tx.chainId, last.parsed.tx.nonce);
    out.textContent = `Nonce check (separate from the verdict): ${r.text}`;
  });
  run();
}

/* c8 ignore next 3 */
if (typeof document !== 'undefined' && document.getElementById('payload') && !(globalThis as { __BR_TEST__?: boolean }).__BR_TEST__) {
  mount(document);
}
