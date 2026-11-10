// Deterministic build: dist/br-verify.html (one self-contained page), dist/br-verify.mjs (the CLI)
// and SHA256SUMS. No source maps, no timestamps, no absolute paths. Version and commit are embedded.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const root = new URL('..', import.meta.url).pathname;
process.chdir(root);
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

function commit() {
  if (process.env.BR_VERIFY_COMMIT) return process.env.BR_VERIFY_COMMIT;
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'uncommitted';
  }
}
const define = { __BR_VERSION__: JSON.stringify(version), __BR_COMMIT__: JSON.stringify(commit()) };
const common = { bundle: true, write: false, sourcemap: false, legalComments: 'none', charset: 'utf8', define, logLevel: 'warning' };
const sha256 = (s) => createHash('sha256').update(s).digest();

// The page.
const web = await build({ ...common, entryPoints: ['src/web/main.ts'], format: 'iife', platform: 'browser', target: 'es2020', minify: true });
const script = web.outputFiles[0].text.trim();
const style = readFileSync('src/web/style.css', 'utf8').trim();
if (/<\/script/i.test(script) || /<\/style/i.test(style)) throw new Error('inline code contains a closing tag');
const csp = [
  "default-src 'none'",
  `script-src 'sha256-${sha256(script).toString('base64')}'`,
  `style-src 'sha256-${sha256(style).toString('base64')}'`,
  // Only the optional nonce check connects anywhere, and only to the RPC URL the approver types.
  'connect-src https: http://localhost:* http://127.0.0.1:*',
  "img-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
const page = readFileSync('src/web/page.html', 'utf8');
for (const marker of ['__CSP__', '__STYLE__', '__SCRIPT__']) {
  if (page.split(marker).length !== 2) throw new Error(`page.html must contain ${marker} exactly once`);
}
const html = page.replace('__CSP__', () => csp).replace('__STYLE__', () => style).replace('__SCRIPT__', () => script);

// The CLI.
const cli = await build({
  ...common, entryPoints: ['src/cli/main.ts'], format: 'esm', platform: 'node', target: 'node20', minify: false,
  banner: { js: '#!/usr/bin/env node' },
});
const mjs = cli.outputFiles[0].text;

mkdirSync('dist', { recursive: true });
writeFileSync('dist/br-verify.html', html);
writeFileSync('dist/br-verify.mjs', mjs, { mode: 0o755 });
const sums = ['dist/br-verify.html', 'dist/br-verify.mjs']
  .map((f) => `${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${f}`).join('\n') + '\n';
writeFileSync('SHA256SUMS', sums);
process.stdout.write(`br-verify ${version} (commit ${define.__BR_COMMIT__.slice(1, -1)})\n${sums}`);
