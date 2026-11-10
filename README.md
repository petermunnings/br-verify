# br-verify

br-verify answers one question for an HSM approver: **are the bytes the HSM is about to sign the transaction I think I'm approving?**

Each approver runs it on their own device before approving a 2-of-3 request in the Securosys Authorization App. It:

1. **decodes** the payload from the app's DETAILS tab, and shows it in plain terms;
2. **rebuilds** the transaction from the fields you expect, and **compares** it with the payload, byte for byte;
3. shows one verdict.

It holds no keys and no credentials. It never talks to the HSM, the TSB or any Braided Rivers service. It sends nothing over the network, unless you type an RPC URL and press "Check the nonce".

**Why the payload, and not `metaData`?** The requester's machine writes `metaData`, the description approvers see. `metaData` is not part of what you approve, and it is not sent to the HSM (Securosys, Q6). If the requester's machine is compromised, `metaData` can describe a harmless call while the payload is something else. The payload is what the HSM signs. Under key policy K13 it is the full unsigned EIP-1559 transaction, `0x02 ‖ rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList])`, and the HSM signs `keccak256(payload)`. br-verify checks the payload. It never trusts the `digest` written in `metaData`.

## Where it is hosted

The source is at `github.com/PeterMunnings/br-verify`, under Peter's personal GitHub account (decided 10 Nov 2026). Peter controls who can write to it. The requester's tooling must never have write access. Where the built page is served from is posted on BRA-420.

## What it is not

- It doesn't judge whether the transaction is a good idea. It proves only that the payload is the transaction you entered.
- It can't see the sender. The unsigned payload carries no sender. **Check that the key named in DETAILS (`signKeyName`) is the key the ticket names.**
- It can't tell chain ID 1 on the Braided Rivers fork from real Ethereum mainnet. The same signed bytes would be valid on both.
- It doesn't verify typed-data (EIP-712) or signed-message (EIP-191) payloads yet. It detects them and refuses them.
- It trusts viem and the device it runs on.

## On a phone (the web page)

The page is one file, `dist/br-verify.html`, with everything inline. It works hosted over HTTPS or opened from a local file, and it works offline.

1. **Check the page first.** The header shows the version and commit. Compare them with the ones posted on BRA-420.
2. In the Authorization App, open the request, go to **DETAILS**, and copy the whole **payload**.
3. In br-verify, press **Paste** (or long-press the box and paste). The byte count appears at once. A D1–D3 creation is about 41,000 to 45,500 bytes. **If the count is smaller than the ticket says, the paste was cut short.**
4. Under **What you expect**, enter the fields from the Linear ticket: chain ID, nonce, "contract creation" or the `to` address, value, gas limit and both fees. The access list is already set to **Empty (default)**: the signing flow never sets one, so a payload with an access list gives MISMATCH. The result record says when the default was used. Then enter the data as one of:
   - the **init-code hash** (contract creations; this is the hash you pre-verified);
   - the **function signature and arguments** (calls), for example `mint(address,uint256)` and `["0x…", "7000000000000000000000"]`;
   - the **data** as hex.

   Or open **Paste expected JSON** and paste the expected fields, the request's `metaData` (JSON or base64), or a facility-book bundle. Then check the form against the ticket.
5. Read the verdict. Then read the decoded view and any warnings.
6. Press **Copy result** and paste the text block into the Linear ticket.

## On a laptop (the CLI)

Node 24.22.1 (see `.nvmrc`). No install is needed to run the built file:

```sh
node dist/br-verify.mjs decode payload.txt                # or - for stdin
node dist/br-verify.mjs compare --payload payload.txt --expected expected.json
node dist/br-verify.mjs initcode --data initcode.txt --from 0x… --nonce 0 --expect-hash 0x… --expect-address 0x…
node dist/br-verify.mjs initcode --bundle 01-D1.json --expect-hash 0x… --expect-address 0x… [--artifact out/X.sol/X.json]
```

- `--json` gives machine-readable output. `--record` prints the text block for the ticket.
- `--expected` takes a file or inline JSON: the expected fields, a `metaData` object, or a facility-book bundle.
- `--artifact` takes a forge artifact. br-verify checks that `data` starts with its creation code, decodes the constructor arguments by name, and requires them to re-encode to the same bytes. A `bytes` argument longer than 64 bytes is shown as its length and keccak256.
- `--rpc <url>` runs the optional nonce check. It is the only way the CLI touches the network.
- Exit codes: **0** for MATCH only; **1** for MISMATCH; **2** for everything else.

### Pre-verifying D1–D3 (Tuesday)

In the facility-book checkout, with the hashes and addresses from BRA-687:

```sh
B=build/mfsol/ceremony/plan-three
node /path/to/br-verify/dist/br-verify.mjs initcode --bundle $B/01-D1.json \
  --expect-hash 0xaa17140c58576a6839d9aab4f0356ad91376a23b6c9b427dc077adcf5c706e9f \
  --expect-address 0x06Fbac10db58E960Aa3D6Ff94554426e6c1AbE50 \
  --artifact out/MfsolImplBootstrap.sol/MfsolImplBootstrap.json
```

Then D2 (`02-D2.json`, `MfsolInfraBootstrap`) and D3 (`03-D3.json`, `MfsolSuiteBootstrap`). The bundle's own `initCodeHash` and `expectedAddress` are written by the requester's tooling, so br-verify shows them as "[bundle]" checks. Only your `--expect-hash` gives MATCH.

## The expected fields

```json
{
  "chainId": 1, "nonce": 0,
  "maxPriorityFeePerGas": "1000000000", "maxFeePerGas": "2000000000", "gas": "11878178",
  "to": null, "value": "0",
  "data": "0x…", "dataHash": "0x…",
  "call": { "signature": "mint(address,uint256)", "args": ["0x…", "7000000000000000000000"] },
  "accessList": [],
  "from": "0x…", "expectedAddress": "0x…"
}
```

- Every field is optional. A missing field is "not compared". It is never treated as zero.
- On the page, the access list starts as "Empty (default)". Choose "Not entered" to leave it out. The CLI has no default: give `"accessList": []`.
- `to: null` means a contract creation. A missing `to` means "not entered".
- Give `data`, `dataHash` or `call`. If you give more than one, each is compared with the payload, so they must agree.
- Amounts are whole numbers in wei, written in decimal. Never decimals or floating point.
- `from` is **not part of the payload**. It is used only for the CREATE address and the nonce check. Check that the key named in DETAILS (`signKeyName`) has this address.

## The verdicts

| Verdict | Meaning | What to do |
|---|---|---|
| **MATCH** (green) | Every transaction field was entered and every one is equal. The data was compared as bytes, or by keccak256 if you gave only the hash (the verdict says which). | Check `signKeyName` in DETAILS. Then approve if the ticket agrees. |
| **MISMATCH** (red) | A field you entered differs. Each one is named, with the expected and actual values. | Reject the request. |
| **PARTIAL** (amber) | Every field you entered matches, but some weren't entered. They are listed. | Check those fields against the ticket yourself. |
| **NOT COMPARED** (grey) | The payload decoded, but you entered nothing. | Check every field against the Linear ticket. |
| **CANNOT VERIFY** (red) | br-verify can't parse the payload, doesn't support it, or found it isn't canonically encoded. | Reject unless the ticket explains why. |
| **BARE HASH** (red) | The payload is 32 bytes: a bare hash, which can't be checked. | Reject (key policy). |

The verdict word is always shown as text, never by colour alone.

**Warnings** don't change the verdict. They appear when the value isn't 0, the access list isn't empty, the gas limit is 16,777,216 or more, the init code is longer than 49,152 bytes, the chain is unknown, or `to` is the zero address.

Because the access list defaults to empty, a payload pasted with nothing else entered gives PARTIAL (the access list was compared), not NOT COMPARED.

**The nonce check** is optional and separate. It never changes MATCH or MISMATCH. For chain ID 1, the fork isn't reachable from a phone: compare the nonce with the pre-flight posted on the ticket.

## Checking the checksum

The file's own sha256 can't be inside the file. The page shows its version and commit. The checksum is in `SHA256SUMS`, here, and on BRA-420.

```sh
sha256sum dist/br-verify.html          # Linux
shasum -a 256 dist/br-verify.html      # macOS
```

On a phone, compare the version and commit in the header with BRA-420, and use only the copy at the agreed location.

`dist/` and `SHA256SUMS` are build output and are not committed: the build embeds the commit it was built from, so a committed copy could never match its own commit. Build them from the commit posted on BRA-420, and compare with the sha256 values posted there.

## Building

```sh
nvm use                       # Node 24.22.1
npm ci --ignore-scripts
npm test                      # all tests, offline
npm run coverage              # with line coverage (90% or more required)
npm run build                 # dist/br-verify.html, dist/br-verify.mjs and SHA256SUMS
```

The one runtime dependency is **viem 2.57.17**, pinned exactly. It was the latest 2.x on 10 Nov 2026, published two days before. Peter accepted this pin for the MFSOL demo, which uses test data only. The dependency review is deferred to **BRA-695** (after London). Every other package is a dev dependency, and none of them is in the shipped files. See `REVIEW.md` for the full list, the lockfile hashes and how to reproduce the build.
