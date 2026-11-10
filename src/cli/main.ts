// The Node CLI. Reads files and stdin only. No network, except an explicit --rpc for the nonce check.
// Exit codes: 0 for MATCH only; 1 for MISMATCH; 2 for everything else.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { readExpected, type Read } from '../adapters/index.js';
import { readPayloadText, type Encoding, type Reading } from '../core/payload.js';
import { checkNonce } from '../rpc/nonce.js';
import { COMMIT, decodedRows, FOOTER, grp, parseJsonText, record, verdictText, verify, VERSION, type Report } from '../view/report.js';
import { initcode, type InitcodeResult } from './initcode.js';

const USAGE = `br-verify ${VERSION} (commit ${COMMIT})

  br-verify decode <file or ->                      the decoded view of a payload
  br-verify compare --payload <file> --expected <json file or JSON text>
  br-verify initcode --data <file> [--from <addr> --nonce <n>] [--expect-hash <0x…>] [--expect-address <0x…>] [--artifact <json>]
  br-verify initcode --bundle <bundle.json> [--expect-hash <0x…>] [--expect-address <0x…>] [--artifact <json>]

Options: --json (machine-readable), --record (the text block for the Linear ticket),
         --encoding hex|base64 (if the payload text reads both ways), --rpc <url> (optional nonce check),
         --from <addr> (for the nonce check and the CREATE address; not part of the payload).
Exit codes: 0 MATCH; 1 MISMATCH; 2 anything else.`;

export interface Io { out: (s: string) => void; err: (s: string) => void; readFile: (p: string) => string; now: () => Date; fetch?: typeof fetch }
const defaultIo: Io = {
  out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n'),
  readFile: (p) => readFileSync(p === '-' ? 0 : p, 'utf8'), now: () => new Date(),
};

const exitFor = (v: string) => (v === 'MATCH' ? 0 : v === 'MISMATCH' ? 1 : 2);
const json = (o: unknown) => JSON.stringify(o, (_, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? undefined : x), 2);
const pad = (rows: [string, string][]) => { const w = Math.max(0, ...rows.map(([k]) => k.length)); return rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`); };

export function pick(rs: Reading[], encoding?: string): Reading | string {
  if (rs.length === 0) return "the text is neither hex nor base64";
  if (rs.length === 1) return rs[0]!;
  const r = rs.find((x) => x.encoding === (encoding as Encoding));
  return r ?? `the payload text reads as both ${rs.map((x) => x.encoding).join(' and ')}; choose with --encoding`;
}

function printReport(io: Io, rep: Report, opts: { json?: boolean; record?: boolean }, nonce?: string): number {
  if (opts.record) io.out(record(rep, io.now()));
  else if (opts.json) io.out(json({ version: VERSION, commit: COMMIT, verdict: rep.result.verdict, encoding: rep.reading.encoding, result: rep.result, decoded: rep.decoded, tx: rep.parsed.ok ? rep.parsed.tx : null, payloadHex: undefined, nonceCheck: nonce }));
  else {
    const t = verdictText(rep.result);
    io.out([`br-verify ${VERSION} (commit ${COMMIT})`, '', t.headline, ...t.detail.split('\n').map((l) => `  ${l}`), '',
      ...(rep.decoded?.warnings ?? []).map((w) => `WARNING: ${w}`), ...pad(decodedRows(rep)), ...(nonce ? ['', `Nonce check (separate from the verdict): ${nonce}`] : []), '', FOOTER].join('\n'));
  }
  return exitFor(rep.result.verdict);
}

function printInit(io: Io, r: InitcodeResult, opts: { json?: boolean; record?: boolean }): number {
  const created = r.createAddress ? `${r.createAddress} (from ${r.from}, nonce ${r.nonce}, as entered)` : 'not computed (needs from and nonce)';
  if (opts.json) io.out(json({ version: VERSION, commit: COMMIT, ...r }));
  else if (opts.record) {
    io.out([`br-verify ${VERSION} (commit ${COMMIT}), ${io.now().toISOString().replace(/\.\d+Z$/, 'Z')}`,
      `Verdict: ${r.verdict}${r.verdict === 'MATCH' ? ' (init code compared by keccak256)' : ''}`,
      `Init code: ${grp(r.bytes)} bytes, keccak256 ${r.hash}`, `CREATE address ${created}`,
      ...(r.artifact ? [`Artifact ${r.artifact.contract}: creation code ${grp(r.artifact.creationBytes)} bytes, keccak256 ${r.artifact.creationHash}`] : []),
      ...r.checks.map((c) => `${c.ok ? 'OK' : 'DIFFERS'}: ${c.name} (${c.source}): expected ${c.expected}; actual ${c.actual}`),
      ...(r.reason && r.verdict === 'CANNOT VERIFY' ? [`Reason: ${r.reason}`] : []),
      `Not compared: ${r.notCompared.length ? r.notCompared.join(', ') : 'none'}`, ...r.warnings.map((w) => `Warning: ${w}`)].join('\n'));
  } else {
    io.out([`br-verify ${VERSION} (commit ${COMMIT})`, '', `${r.verdict}: ${r.reason}`, ...r.warnings.map((w) => `WARNING: ${w}`), '',
      ...pad([['Init code', `${grp(r.bytes)} bytes`], ['Init-code hash', r.hash], ['CREATE address', created]]), '',
      ...r.checks.map((c) => `${c.ok ? 'OK     ' : 'DIFFERS'}  ${c.name} [${c.source}]\n         expected ${c.expected}\n         actual   ${c.actual}`),
      ...(r.notCompared.length ? [`Not compared: ${r.notCompared.join(', ')}`] : []),
      ...(r.artifact ? ['', `Artifact ${r.artifact.contract}`, ...pad([['Creation code', `${grp(r.artifact.creationBytes)} bytes, keccak256 ${r.artifact.creationHash}`],
        ...r.artifact.args.map((a): [string, string] => [`  ${a.name} (${a.type})`, a.value])])] : []), '', FOOTER].join('\n'));
  }
  return exitFor(r.verdict);
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      payload: { type: 'string' }, expected: { type: 'string' }, data: { type: 'string' }, bundle: { type: 'string' },
      from: { type: 'string' }, nonce: { type: 'string' }, 'expect-hash': { type: 'string' }, 'expect-address': { type: 'string' },
      artifact: { type: 'string' }, encoding: { type: 'string' }, rpc: { type: 'string' }, json: { type: 'boolean' }, record: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    } });
  } catch (e) { io.err(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`); return 2; }
  const { values: o, positionals: [cmd, file] } = parsed;
  if (o.version) { io.out(`br-verify ${VERSION} (commit ${COMMIT})`); return 0; }
  if (o.help || !cmd) { io.out(USAGE); return cmd || o.help ? 0 : 2; }
  try {
    if (cmd === 'decode' || cmd === 'compare') {
      const path = cmd === 'decode' ? file : o.payload;
      if (!path) throw new Error(cmd === 'decode' ? 'decode needs a file, or - for stdin' : 'compare needs --payload');
      if (cmd === 'compare' && !o.expected) throw new Error('compare needs --expected');
      const read: Read = o.expected ? readExpected(parseJsonText(o.expected.trim().startsWith('{') ? o.expected : io.readFile(o.expected))) : { format: 'expected', expected: {}, notes: {} };
      if (o.from) read.expected.from ??= o.from;
      const reading = pick(readPayloadText(io.readFile(path)), o.encoding);
      if (typeof reading === 'string') {
        const t = `CANNOT VERIFY: br-verify can't verify this payload (${reading}). Reject unless the ticket explains why.`;
        if (o.json) io.out(json({ version: VERSION, commit: COMMIT, verdict: 'CANNOT VERIFY', reason: reading })); else io.out(t);
        return 2;
      }
      if (read.format !== 'expected' && !o.json && !o.record) io.err(`Expected fields read as ${read.format}.${read.format === 'metaData' ? ' Its digest is ignored: only the payload counts.' : ''}`);
      const rep = verify(reading, read.expected, read.notes);
      let nonce: string | undefined;
      if (o.rpc && rep.parsed.ok) nonce = (await checkNonce(o.rpc, read.expected.from ?? '', rep.parsed.tx.chainId, rep.parsed.tx.nonce, io.fetch as never)).text;
      return printReport(io, rep, o, nonce);
    }
    if (cmd === 'initcode') {
      let data: string | undefined; let from = o.from; let nonce = o.nonce === undefined ? undefined : Number(o.nonce);
      let bundle: Parameters<typeof initcode>[0]['bundle'];
      if (o.bundle) {
        const b = JSON.parse(io.readFile(o.bundle)) as Record<string, unknown>;
        const r = readExpected(b);
        if (r.format !== 'bundle' || r.expected.to !== null) throw new Error('--bundle needs a contract-creation bundle');
        data = r.expected.data; from ??= r.expected.from; nonce ??= r.expected.nonce === undefined ? undefined : Number(r.expected.nonce);
        bundle = { initCodeHash: r.expected.dataHash, expectedAddress: r.expected.expectedAddress, payloadBytes: b.payloadBytes as number | undefined, creationCodeHash: r.notes.artifact?.creationCodeHash };
      } else if (o.data) {
        const rd = pick(readPayloadText(io.readFile(o.data)), o.encoding);
        if (typeof rd === 'string') throw new Error(`--data: ${rd}`);
        data = `0x${Buffer.from(rd.bytes).toString('hex')}`;
      }
      if (!data || !/^0x([0-9a-fA-F]{2})*$/.test(data)) throw new Error('initcode needs --data <file> or --bundle <file> with hex init code');
      if (nonce !== undefined && !(Number.isSafeInteger(nonce) && nonce >= 0)) throw new Error('--nonce must be a whole number');
      const artifact = o.artifact ? { json: JSON.parse(io.readFile(o.artifact)) as unknown, name: basename(o.artifact) } : undefined;
      return printInit(io, initcode({ data: data.toLowerCase() as `0x${string}`, from, nonce, expectHash: o['expect-hash'], expectAddress: o['expect-address'], bundle, artifact }), o);
    }
    throw new Error(`unknown command ${cmd}`);
  } catch (e) {
    io.err(`CANNOT VERIFY: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

/* c8 ignore next 3 */
if (process.argv[1] && /br-verify(\.mjs)?$|cli[\\/]main\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
