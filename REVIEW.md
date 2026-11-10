# Reviewing br-verify

This is for the reviewer, **Marelize Kriel**. The key policy requires someone other than the author to review br-verify before approvers rely on it. Peter Munnings built this version (BRA-420, 10 Nov 2026), with Claude Code.

What br-verify must do is in `README.md`. In short: take the payload from the Authorization App's DETAILS tab, check that it is a canonical unsigned EIP-1559 transaction, compare it with the fields the approver entered, and show one verdict. MATCH appears only after a full comparison.

## 1. Read the core

`src/core/` holds every decision. It imports only `viem` and its own files (a test enforces this). It has no DOM, no Node APIs and no network.

| File | Lines | What it does |
|---|---|---|
| `src/core/payload.ts` | 90 | Reads the pasted text (hex, base64, base64 of hex). Classifies the bytes: empty, bare hash, EIP-712, EIP-191, other types. Parses with `parseTransaction`, refuses signed transactions, and requires the parsed fields to re-serialise to exactly the same bytes (the canonical check). |
| `src/core/compare.ts` | 133 | Validates the expected fields. Compares them field by field. Builds calldata from a signature and arguments. Gives the verdict, and rebuilds the whole transaction with `serializeTransaction` before any MATCH where the data bytes are known. |
| `src/core/decode.ts` | 72 | Chain names, kind, call decoding with the approver's signature, sizes, hashes and warnings. |
| **Total** | **295** | The brief aimed for under 250. I kept it readable rather than packing lines. |

The rest only presents or reads:

| File | Lines | What it does |
|---|---|---|
| `src/view/report.ts` | 125 | The verdict wording, the decoded view, the result record. Shared by the page and the CLI. |
| `src/adapters/index.ts` | 60 | Maps `metaData` and facility-book bundles onto the expected fields. Field names only, no hashing or encoding. It ignores `metaData.digest`. |
| `src/rpc/nonce.ts` | 39 | The optional nonce check: `fetch` JSON-RPC, three read-only calls. |
| `src/web/main.ts`, `page.html`, `style.css` | 174, 112, 62 | The page. Plain DOM. Every value is written with `textContent`. |
| `src/cli/main.ts`, `initcode.ts` | 135, 87 | The CLI, and the init-code and forge-artifact checks. |
| `scripts/build.mjs` | 60 | The deterministic build. |

## 2. The checklist

Tick each one yourself. Don't take the tests' word for it.

- [ ] **No network by default.** The only `fetch` is in `src/rpc/nonce.ts`. It runs only from the "Check the nonce" button or the CLI's `--rpc`. The page's CSP is `default-src 'none'`, and `connect-src` allows only `https:`, `http://localhost:*` and `http://127.0.0.1:*`. A typed URL is needed because the approver chooses it.
- [ ] **No storage and nothing external.** No cookies, `localStorage`, analytics, fonts, CDNs or external scripts. The CSP allows the one inline script and the one inline style by sha256 only, with `base-uri 'none'`, `form-action 'none'` and `img-src 'none'`.
- [ ] **No Braided Rivers code or data.** Nothing is imported, copied or vendored from any Braided Rivers repo. The braided-rivers and facility-book checkouts were read for field names and facts only. `test/fixtures/` holds made-up values in the bundle and `metaData` formats. No bundle data, init code or real key address is in the repo. The only real values are the BRA-687 pins for deployer-1 and D1–D3 (addresses and hashes), which the tests check.
- [ ] **One runtime dependency.** `viem` only, pinned exactly. No hand-written RLP, ABI or hashing code.
- [ ] **Fail closed.** Anything unparsed or unsupported gives CANNOT VERIFY, and so does invalid input in the expected fields or an internal error (`compare.ts` catches everything). A 32-byte payload gives BARE HASH.
- [ ] **The canonical check.** `parsePayload` requires `serializeTx(parsed) === payload`. That catches trailing bytes, leading zeros and any non-canonical RLP.
- [ ] **The verdict rules.**
  - MATCH needs all nine transaction fields entered and equal, with no difference anywhere.
  - Where the data bytes are known (`data` or `call`), the rebuilt transaction must also equal the payload byte for byte. If the field comparison and the byte comparison ever disagree, the verdict is CANNOT VERIFY.
  - A missing field gives PARTIAL (listed). Nothing entered gives NOT COMPARED. Neither is ever MATCH.
  - `expectedAddress` without `from` is listed as not compared.
- [ ] **Never trusts `metaData`'s digest.** The adapter drops it. The page and CLI say so.
- [ ] **The sender.** `from` is labelled everywhere as "as entered, not part of the payload". The approver checks `signKeyName` in DETAILS.
- [ ] **Chain ID 1.** It is labelled as the fork, with the warning that br-verify can't tell the fork from real mainnet.

## 3. Dependencies

Node **24.22.1** (`.nvmrc`, `engines`). Every version is exact. Install with `npm ci --ignore-scripts` (`.npmrc` also sets `ignore-scripts=true`).

**Runtime** (`npm ls --omit=dev --all`): `viem@2.57.17`, published on 8 Nov 2026 and the latest 2.x on 10 Nov.

**Decision (Peter, 10 Nov 2026):** keep viem 2.57.17. This is a demo with test data. The dependency review (including the release's age, and the tree below) is deferred to **BRA-695**, after London. Until then, don't treat this build as reviewed for production keys.

| Package | Version | In the shipped files? | Lockfile integrity |
|---|---|---|---|
| viem | 2.57.17 | yes | `sha512-yIMqNoKoVAMwX+zVbqkxfqq7qbGHmKXZidh/xfVpiPTJlAbbDDdDIMH5dDQWxhZcj56L8tPOwsIIxF618P+TOg==` |
| abitype | 1.2.3 | yes | `sha512-Ofer5QUnuUdTFsBRwARMoWKOH1ND5ehwYhJ3OJ/BQO+StkwQjHw0XyVh4vDttzHB7QOFhPHa/o413PJ82gU/Tg==` |
| @noble/hashes (viem's copy) | 1.8.0 | yes (keccak256) | `sha512-jCs9ldd7NwzpgXDIf6P3+NrHh9/sD6CQdxHyjQI+h/6rDNo88ypBxxz45UDuZHz9r3tNz7N/VInSVoVdtXEI4A==` |
| @noble/curves (viem's and ox's) | 1.9.1 | no (tree-shaken) | `sha512-k11yZxZg+t+gWvBbIswW0yoJlu8cHOC7dhunwOzoWH/mXGBiYyR4YY6hAEK/3EUs4UpB8la1RfdRpeGsFHkWsA==` |
| ox | 0.14.63 | no | `sha512-TSKYN151boL1Aq/vsFrd8Buvd7v+oTQr8V7z4f4QQTSMB+ohD8cbNbHCtKRLI0Gs8LuYKirf5qvElTKVIFe2jw==` |
| @scure/bip32 | 1.7.0 | no | `sha512-E4FFX/N3f4B80AKWp5dP6ow+flD1LQZo/w8UnLGYZO674jS6YnYeepycOOksv+vLPSpgN35wgKgy+ybfTb2SMw==` |
| @noble/curves (@scure/bip32's) | 1.9.7 | no | `sha512-gbKGcRUYIjA3/zCCNaWDciTMFI0dCkvou3TL8Zmy5Nc7sJ47a0jtOeZoTaMxkuqRo9cRhjOdZJXegxYE5FN/xw==` |
| @scure/bip39 | 1.6.0 | no | `sha512-+lF0BbLiJNwVlev4eKelw1WWLaiKXw7sSl8T6FvBlWkdX+94aGJ4o8XjUdlyhTCjd8c+B3KT3JfS8P0bLRNU6A==` |
| @scure/base | 1.2.6 | no | `sha512-g/nm5FgUa//MCj1gV09zTJTaM6KBAHqLN907YVQqf7zC49+DcO4B1so4ZX07Ef10Twr6nuqYEH9GEggFXA4Fmg==` |
| @noble/ciphers | 1.3.0 | no | `sha512-2I0gnIVPtfnMw9ee9h1dJG7tp81+8Ob3OJb3Mv37rx5L40/b0i7djjCVvGOVqc9AEIQyvyu1i6ypKdFw8R8gQw==` |
| @adraffy/ens-normalize | 1.11.1 | no | `sha512-nhCBV3quEgesuf7c7KYfperqSS14T8bYuvJ8PcLJp6znkZpFc0AuW4qBtr8eKVyPPe/8RSr7sglCWPU5eaxwKQ==` |
| eventemitter3 | 5.0.1 | no | `sha512-GWkBvjiSZK87ELrYOSESUYeVIc9mvLLf/nXalMOS5dYrgZq9o5OVkbZAVM06CVxYsCwH9BDZFPlQTlPA1j4ahA==` |
| isows | 1.0.7 | no | `sha512-I1fSfDCZL5P0v33sVqeTDSpcstAg/N+wF5HS033mogOVIp4B+oHC7oOCsA3axAbBSGTJ8QubbNmnIRN/h8U7hg==` |
| ws | 8.21.0 | no | `sha512-Vsp28b7DRcimFQvrqu2Wek3z1iYxDCWqHYB8Qsnk/S4RfaCQzPGPyBNuVjJV3cd6UiKtUtp6sNM77gWvzcCH+g==` |

Bytes in the page's script, by package (esbuild metafile): viem 51,197; abitype 13,999; @noble/hashes 8,390; br-verify's own code 22,875.

**Dev only, never shipped:** esbuild 0.28.2, vitest 5.1.0, @vitest/coverage-v8 5.1.0, typescript 5.9.3, @types/node 24.19.2, jsdom 27.4.0 (page tests), ethers 6.17.0 (the differential test). A test checks that ethers is in neither shipped file. All integrity hashes are in `package-lock.json`.

**Text-only URLs.** The page contains four URL strings: `https://viem.sh`, `https://abitype.dev`, `https://docs.soliditylang.org/en/latest/cheatsheet.html` and `https://4byte.sourcify.dev/`. They are inside viem's and abitype's error-message text. Nothing loads them, and the CSP would block any load. A test allows exactly these four and fails on any other.

## 4. Reproducing the build

```sh
git clone <repo> a && git clone <repo> b
(cd a && npm ci --ignore-scripts && npm run build)
(cd b && npm ci --ignore-scripts && npm run build)
diff a/SHA256SUMS b/SHA256SUMS && cat a/SHA256SUMS
```

The build has no source maps, timestamps or absolute paths. The version comes from `package.json` and the commit from `git rev-parse --short=12 HEAD`, with `-dirty` if tracked files changed. Outside a git checkout the commit is `uncommitted`.

`dist/` and `SHA256SUMS` are not committed, because the build embeds its own commit. The sha256 values for each commit are posted on BRA-420, with the result of this two-clone check.

## 5. Tests

`npm test` runs 124 tests offline in about 5 seconds. `npm run coverage` reports **98.8% line coverage** of `src/` (97.4% of statements, 92.2% of branches), and fails below 90%.

| File | What it covers |
|---|---|
| `test/core.test.ts` | 1 the known vector, both ways. 2 MATCH for a creation (bytes and hash) and a call. 3 MISMATCH for each field, each naming the right field. 4 PARTIAL and NOT COMPARED, including every subset of the fields short of all nine. 5 Every encoding. 6 Fail closed: signed, legacy, types 1, 3 and 4, 32 bytes, 66-byte `0x1901`, EIP-191, empty, odd-length hex, trailing bytes, a leading-zero integer, tip above fee cap, a 45 KB payload cut at nine points, invalid expected fields. 7 Creations: 44,545 bytes, the three CREATE addresses, both warning boundaries. 8 Calls: decode and re-encode, wrong selector, trailing bytes, tuples, arrays, booleans, signed integers. |
| `test/fuzz.test.ts` | 9 With seed 20261110: 1,500 random valid transactions round-trip and MATCH. Single-byte flips (every position in the first 20 cases, one random position in each other) never give MATCH. 10 ethers v6 `unsignedSerialized` equals viem for all 1,500. |
| `test/tools.test.ts` | Adapters against the real bundle format and `metaData` field names. The verdict wording, decoded view and result record. `initcode` and `--artifact`. 11 The nonce check with mocked `fetch`. The CLI's commands and exit codes. A 100 KB payload in under a second. |
| `test/web.test.ts` | The page in jsdom: a 45 KB paste, MATCH and MISMATCH, the form, the access-list default (and MISMATCH for a payload with an access list), `metaData` JSON, fail-closed states, Paste and Copy (with fallbacks), and the nonce check sending nothing until asked. |
| `test/build.test.ts` | 12 It builds, then checks the shipped page: the CSP and its hashes, nothing loaded from outside, the URL allow-list, and the built page running in jsdom. Also: SHA256SUMS, ethers not shipped, viem the only runtime dependency, `src/core` importing only viem, and nothing in `src` importing from outside. |

## 6. Known behaviours worth a second look

- **A valid 32-byte transaction gives BARE HASH.** The rule is "exactly 32 bytes means bare hash". A tiny contract creation can serialise to exactly 32 bytes, and br-verify refuses it. This fails closed, and no real request is that small.
- **Ambiguous hex and base64 can't occur.** Hex that doesn't start with `0x02` can't parse as EIP-1559. The base64 of any `0x02…` payload has its second character in `g`–`v`, and base64 of hex text starts `MD` (or `MH` with a `0x` prefix), so neither is ever all hex digits. The "choose the encoding" path is kept as a guard, and a fuzz test shows the property.
- **A max priority fee above the max fee gives CANNOT VERIFY, not a warning.** viem refuses to parse such a transaction.
- **The access list defaults to "Empty (default)" in the form** (Peter, 10 Nov). A payload with an access list then gives MISMATCH. The result record says "expected empty (the form's default)" when the approver didn't choose it. A side effect: a payload pasted with nothing else entered gives PARTIAL, not NOT COMPARED. The CLI and `metaData` have no default (`metaData` has no access-list field), so there the approver must give `"accessList": []`.
