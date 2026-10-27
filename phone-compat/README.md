# OFM phone compatibility

`runtime.mjs` and `../scripts/build-ofm-compat.mjs` are the maintained inputs. The generator writes the two APK assets `dsh-ofm-compat.mjs` and `dsh-ofm-compat-data.json`; do not hand-edit generated assets.

The exact reviewed releases are 2.5.1, 2.5.3, and 2.5.7, plus the previous local 2.1.0 source shape. Unknown versions or modified protected functions are refused before any write. Version-specific recipes are deliberately separate: a function shared by 2.5.3 and 2.5.7 may need different surrounding code. New 2.5.7 manual-test budgets/results, managed-update restrictions, signed outlet, upstream desktop/Tauri support, manifest, and channel pack are not replaced with older logic.

Retained local behavior: independent Android EAC popup/manual fallback and strict private-app launch gate (server GitHub/Star authentication still required), shared host account pool/RPC routing, honest anonymous/Kilo availability, opaque phone settings, one optional SSE across tabs, and compatibility before explicit hot reload. No account files or user memories are read by the adapter. Changes stage/syntax-check all program files and allocate backups before replacement; failed commit restores exact original bytes.

## Provenance

- Official source: [Ebony-Vinyl/dsh-our-free-model v2.5.7](https://github.com/Ebony-Vinyl/dsh-our-free-model/releases/tag/v2.5.7), published 2026-10-20.
- Official release archive `dsh-our-free-model-2.5.7.tgz`, 1,363,041 bytes, SHA256 `3304095a38a40085a71bfa81f798001759d992817c1595211465fd9c95542a12`, checked against the GitHub release digest and published SHA256SUMS.
- `fixtures/upstream-2.5.7.json.gz` stores only six public program files from that archive, not an account/profile snapshot. `legacy-compatible-data.json.gz` freezes the previously reviewed 2.5.1/2.5.3 transformations so new source cannot silently change those recipes.
- Upstream MIT license and channel-pack attribution remain in `../our-free-model/`.

## Verification

```
node scripts/build-ofm-compat.mjs
node --test phone-compat/ofm.test.mjs phone-compat/ofm-257.test.mjs
(cd our-free-model && node scripts/test-all.mjs --mode contributor)
```

The fixture suite covers all three reviewed releases, reactive shared RPC and genuine error propagation, correct 2.5.7 signed outlet/manual-test budget, idempotence, unknown version/function rejection, and mid-commit rollback/retry. `our-free-model` keeps the official offline suites plus the existing local phone/shared-channel/SSE tests. On SDK rc.2, the source-channel test uses the real public durable-stream accumulator/reader and assembler, not the removed old `dsh-llm/invariant` export. Offline tests do not certify real provider login or live inference. Actual phone installation and full core/profile transaction are separate release checks.
