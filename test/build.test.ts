// 12. Build checks: the shipped files are self-contained, carry the CSP, and the core stays independent.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';
import { KNOWN_PAYLOAD } from './helpers.js';

let html = '';
let mjs = '';
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'pipe' });
  html = readFileSync('dist/br-verify.html', 'utf8');
  mjs = readFileSync('dist/br-verify.mjs', 'utf8');
}, 60_000);

const sha = (s: string, enc: 'base64' | 'hex') => createHash('sha256').update(s).digest(enc);

// URL text inside viem's and abitype's error messages. Never fetched; the CSP blocks any load anyway.
const URL_TEXT_ALLOWED = ['https://viem.sh', 'https://abitype.dev', 'https://docs.soliditylang.org/en/latest/cheatsheet.html', 'https://4byte.sourcify.dev/'];

describe('dist/br-verify.html', () => {
  it('has the strict CSP, with hashes that match the inline script and style', () => {
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
    expect(csp).toBeDefined();
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
    const style = /<style>([\s\S]*)<\/style>/.exec(html)![1]!;
    expect(csp!.split('; ')).toEqual([
      "default-src 'none'",
      `script-src 'sha256-${sha(script, 'base64')}'`,
      `style-src 'sha256-${sha(style, 'base64')}'`,
      'connect-src https: http://localhost:* http://127.0.0.1:*',
      "img-src 'none'", "base-uri 'none'", "form-action 'none'",
    ]);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html.match(/<style/g)).toHaveLength(1);
  });
  it('loads nothing from outside: no src, href, link, import, url() or external script', () => {
    expect(html).not.toMatch(/<(link|iframe|img|object|embed|base)\b/i);
    expect(html).not.toMatch(/\s(src|href|srcset|action|poster)=/i);
    expect(html).not.toMatch(/@import|url\(/i);
    expect(html).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|sendBeacon|WebSocket\(|XMLHttpRequest|importScripts/);
  });
  it('contains no external URL, other than the allowed error-message text', () => {
    const urls = new Set(html.match(/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}(\/[a-z0-9./_-]*)?/gi) ?? []);
    expect([...urls].filter((u) => !URL_TEXT_ALLOWED.includes(u))).toEqual([]);
  });
  it('runs as built: decodes a pasted payload in a browser-like page', () => {
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
    const doc = dom.window.document;
    const box = doc.getElementById('payload') as HTMLTextAreaElement;
    box.value = KNOWN_PAYLOAD;
    box.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(doc.getElementById('count')!.textContent).toBe('24 bytes (read as hex)');
    return new Promise<void>((done, fail) => dom.window.setTimeout(() => { try {
      expect(doc.querySelector('#verdict .headline')!.textContent).toBe('PARTIAL: only the access list was compared');
      expect(doc.getElementById('decoded')!.textContent).toContain('0x3e0439a8c03f175b15faa919d8bd271e056f0427502cbe9b4fbc091dff37ca40');
      expect(doc.getElementById('commit')!.textContent).not.toBe('');
      dom.window.close();
      done();
    } catch (e) { fail(e); } }, 300));
  });
  it('SHA256SUMS matches the files', () => {
    const sums = readFileSync('SHA256SUMS', 'utf8');
    expect(sums).toBe(`${sha(html, 'hex')}  dist/br-verify.html\n${sha(mjs, 'hex')}  dist/br-verify.mjs\n`);
  });
});

describe('dependencies', () => {
  it('ethers is not in the shipped files', () => {
    for (const f of [html, mjs]) {
      expect(f).not.toMatch(/ethers\/|ethers\.js|"6\.17\.0"|unsignedSerialized/);
    }
  });
  it('the only runtime dependency is viem, pinned exactly', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(Object.keys(pkg.dependencies)).toEqual(['viem']);
    for (const v of Object.values({ ...pkg.dependencies, ...pkg.devDependencies }) as string[]) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('src/core imports nothing but viem and itself', () => {
    for (const f of readdirSync('src/core')) {
      const text = readFileSync(`src/core/${f}`, 'utf8');
      const from = [...text.matchAll(/^(?:import|export)\s[^;]*?from\s*'([^']+)'/gm)].map((m) => m[1]);
      expect(from.length, f).toBeGreaterThan(0);
      expect(text).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
      for (const m of from) expect(m === 'viem' || /^\.\/[a-z]+\.js$/.test(m!), `${f} imports ${m}`).toBe(true);
      expect(text).not.toMatch(/\b(fetch|document|window|process|require)\b/);
    }
  });
  it('nothing in src imports from a Braided Rivers package', () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
    for (const f of walk('src')) {
      const from = [...readFileSync(f, 'utf8').matchAll(/^(?:import|export)\s[^;]*?from\s*'([^']+)'/gm)].map((m) => m[1]!);
      for (const m of from) expect(m === 'viem' || m.startsWith('.') || m.startsWith('node:'), `${f} imports ${m}`).toBe(true);
    }
  });
});
