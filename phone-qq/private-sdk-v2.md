# Private SDK closure migration

`core-migration.js` uses a fixed utility file URL from the **new shipped tree** to
acquire `node-addon-system`'s nonblocking native `flock`. It does not start an
Agent, import a profile plugin, or resolve this lock API through a private SDK.
The empty lock inode is permanent: closing the descriptor or killing its owner
releases the OS lock, and the inode must not be unlinked while another process
might use it. Unsupported/missing native locking fails before migration.

## Build-time v2 plan

Call `buildPrivateSdkPlan` from `private-sdk-plan.js` after the final distribution
has been hydrated and trimmed, not against a development npm installation:

```js
await buildPrivateSdkPlan({
  tree: distributionRoot,
  baselineFiles: [baselineManifestPath],
  variantsDirectory: maintainedPrivateVariantsRoot,
  preservations: testedPreservationReceipts,
  outputFile: `${distributionRoot}/node_modules/dsh-phone-qq/private-sdk-patches.json`,
  targetPlatform: 'android', targetArch: 'arm64',
});
```

The baseline contains only relative code paths and SHA-256 hashes, never
`current.json`, registration/configuration bodies, credentials or account data.
Every known running delta requires a receipt with `relative`, `beforeSha256`,
`afterSha256`, `disposition` (`merged` or `maintained-upstream`) and `verification`.
The build refuses missing receipts. Receipts attest the maintainer's tests; the
migration independently verifies the exact bytes but does not rerun those tests.

The builder walks the actual required/peer dependency graph and present optional
packages applicable to Android/arm64. Distinct nested dependency versions remain
nested. It never runs npm hooks or imports package code. Maintained variants are
stored as `private-sdk-patches/v2-<sha256>.dat`; old hash-named `.js` artifacts are
not rewritten. Target package manifests must remain byte-identical to the new
shipped version. Do not prune a generated closure afterward.

## Runtime transaction

1. Take the native lock, recover unfinished journals, validate shipped versions.
2. Match **all** private code bytes against a known baseline or exact new closure.
   Unknown edits, added files, escaping links and special files fail closed.
3. Require each known semantic delta's tested receipt. Check available space for
   the full staging copy plus 64 MiB reserve. Files/bytes are bounded.
4. Copy the complete new closure into an app-home staging directory. Verify each
   source hash, fsync files/directories, and validate package identity, versions
   and required dependency presence. Emit bounded, data-free stderr progress.
5. Persist the complete transaction journal before moving originals. Directory
   exchange at the **same token path** and ordinary profile SDK projections use
   one transaction. `current.json` and registered file URLs are not rewritten.
6. On failure restore originals in reverse order. New directories are retained
   under `displaced/`, not deleted. Restart recovery inspects hashes and actual
   paths rather than trusting a last-written row counter. A concurrent edit or
   changed owner-state guard is preserved and reported, not overwritten.

The source directory and backups must remain within the phone home/deployment;
no hard links are used. Original SDK files, including old `.dshpurge.bak` copies,
remain in the transaction backup. They are not installed into the new closure:
old apply/recover code must not replay alpha patches over a newer SDK.

The v1 alpha-only file patcher is retained for the validated old deployment. A
new core is deployable only after a complete **v2** plan has been generated and
its actual installed-entry graph has passed isolated upgrade tests.

## Verification boundary

Mac tests cover actual native flock contention/process death, real `SIGKILL`
after directory exchange, actual permission failure and whole-transaction
rollback, same-path file-URL imports, closure failure, unknown edits and
concurrent-change refusal. Separate real host-Cordis/private-closure fixtures
exercise cold none/zstd storage and an actual Agent with a controlled local model.
They do **not** establish Android flock/decoder execution, full active profile
startup, APK deployment, or preservation of every third-party plugin; those need
the final distribution and isolated Android validation before activation.

## Independent community package

A conditional `compatibilityPackages` row for the already-installed `dsh-purge`
uses a **complete installed-package inventory fingerprint**, not a package/lib
subset. It first recognizes every ordinary file and validates the sole optional
`node_modules` symlink resolves to the shipped tree. It clones the installed
package from hash-checked bytes, replaces only the five maintained manifest/guard
files, and exchanges the directory in the same SDK transaction. All other root
clients, bundle patches, binaries, docs, presets, scripts, skills and local code
remain unchanged. Extra or edited unknown files refuse the entire upgrade.

Only five public replacement files and bound before/after inventory digests/counts
ship. Private extra filenames and bytes need not enter the plan or public APK.
The complete private baseline is a build input; the generated bound fingerprints
can reproduce later identical builds without that private list. A changed public
replacement invalidates the old target fingerprint and requires a fresh verified
baseline. Missing plugins are not installed, no bundles are enabled automatically,
and the installed independent package version/author fields are preserved.
