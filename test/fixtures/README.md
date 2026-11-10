# Test fixtures

Data only, never code. Every address and value here is made up. No facility-book bundle data, init code or real
key address is in this repo.

- `bundle-call.json` and `bundle-message.json`: made-up requests in the facility-book bundle format
  (`docs/mfsol-bootstrappers.md`, "A request"), to test the bundle adapter against the real field names.
- `metadata-mint.json`: a `metaData` object with exactly the fields that braided-rivers'
  `supabase/functions/_shared/signer/flow/metaData.ts` (`buildMetaData`, at `fc433eb`) writes, for a
  `mint(address,uint256)` call. Its `digest` is deliberately all zeros, to show that br-verify ignores it.
