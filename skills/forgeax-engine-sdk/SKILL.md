---
name: forgeax-engine-sdk
description: >-
  ForgeAX SDK release maintenance. Use when recovering an earlier installation or
  working with a sealed SDK release Candidate.
---

# Earlier ForgeAX SDK releases

[Simplified Chinese](SKILL.zh-CN.md)

For an existing archive, start with the [original archive guide](SDK-README.md).
For current npm packages, use the [Engine authoring guide](../forgeax-engine-authoring/SKILL.md).

## SDK production and publication

For PR preflight, inspect the selected archive profile and the exact consumer
receipts before diagnosing missing work. Compact ZIP proof requires 60
completed ready frames from Empty, and the single npm lane installs and runs
Game 3D. Expanded qualification additionally checks the installed diagnostics
and live and cold JavaScript View paths, the independent source result, and
both template seeds. Follow the
[Core validation policy](../../scripts/ci/README.md#core-validation-policy)
for compact admission, full fallback and release boundaries.

For a PR seed canceled during `build:engine`, inspect its live stage output.
The same-head Core compiler admission runs before the unchanged 30-minute seed
window. Verify the original WASM/glue pair and its source provenance before
the clean JS rebuild. Candidate and installed SDK consumers carry Engine
templates and the portable compiler. Keep the 40-minute independent source job
and its clean build and real source template launch in expanded preflight.
Release verification owns the separate full CLI lifecycle.

Material example shader links are resolved from the selected commit inside
the SDK source archive. Preserve the contributor checkout's source link and
validate that the packaged copy has the exact archived shader bytes as a
regular file. Archive checks continue to reject other symbolic links.

When seed preparation changes, run its complete source-export contract. The
public policy verifies source acceptance, Core compiler adoption, provenance
and SDK production in order. For a cold heap failure, identify the failing
package, declaration or archive child and confirm its runner-derived budget.

PR packaging uses `--reuse-core-build` to read the verified Core archive's
Three program strings and warm declaration resolution. Verify fresh package
JavaScript, semantic declarations and maps, and installed consumer runs.
Candidate and public-source builds prepare their own Three programs and
declarations.

For SDK carrier path failures, compare canonical download and resolver-selected
Engine roots at the existing containment owner. Qualify aliased parents and
out-of-download package redirects through the same installer; retain version,
digest, writable-output and empty-target checks. Follow
[SDK consumer diagnostics](../../scripts/ci/README.md#sdk-consumers).

Both SDK transports include editable `source/engine/` with the same release's
prebuilt package outputs. For a focused Engine change, install source dependencies,
rebuild the changed owner and bind through `project engine use-local`; unchanged
owners reuse their delivered builds. Follow the local-Engine guide
for binding and the SDK README for the partial rebuild commands.

Archive and post-consumer integrity stages reread byte counts and SHA-256 through
the existing bounded file-I/O owner. A canceled integrity tail is unverified;
retain every artifact and the SQLite-only mutable-store exclusion. See
[SDK consumer diagnostics](../../scripts/ci/README.md#sdk-consumers).

The Empty project verifier reads its authored scene through the installed
SDK's Pack v3 source parser and direct projection. Verify the scene owner's
GUID, empty entities and empty references there. Keep the published Runtime
Pack and browser checks on their existing routes.

When changing shared transport imports, keep the Candidate consumer and seal
on their single trusted sparse checkout list. Validate its actual module closure
with `pnpm ci:focus --kind node --select scripts/forgeax/__tests__/sdk-candidate-native-inputs.test.mjs`.

For a source-consumer job cancellation, compare complete stage timings first.
PR archive consumers explicitly use `--profile core`: keep the single-module
edit through the embedded View Host, independent cold Engine build, both source
templates and complete integrity checks. The second cold View tool build and
diagnostic journey are deferred because installed View and the Engine/View
integration matrix already exercise those routes. Default `--profile full`
retains the extra source View build/journey for release qualification. Receipts
name their profile and deferred validation; never label core as full evidence.

If a source consumer with precompiled Rapier unexpectedly requests Rust, compare
its `SDK_SOURCE_WASM` closure with the complete producer receipt, including the
3D SIMD glue and declarations. Follow [native artifact admission](../../scripts/ci/README.md#native-rapier-artifact-admission);
repair missing exported files without bypassing source, inventory or digest checks.

For an explicitly requested Engine/SDK change, SDK archive verification or SDK
publication, read SDK production. Its exact-ZIP
subject is the SDK distribution. Game ZIP packaging belongs to the game's release
route; ordinary game creation does not enter Candidate, Promotion or SDK consumers.
For channel/source and publication ordering, read the
release contract: `main` publishes `next`,
the weekly `rc` test line publishes `rc`, and `stable` publishes `latest`. GitHub
and npm publish independently after source qualification of mirrored channels;
the source mirror retains its formal GitHub Release identity check and advances
public `main` (development) or `stable` (stable). Stable Promotion then copies the
original verified Release assets to the public repository through `sdk-release-public.yml`;
use that workflow with an existing stable version to backfill or retry. Delivery
requires the public Release and every other enabled stage.

On Linux x64, the complete development Candidate and Promotion can run on the
local machine with `node scripts/forgeax/local-sdk-release.mjs --stage all`
(`pnpm sdk:release:local -- --stage all` is the installed-workspace alias). It
pins the selected version and source SHA in
`artifacts/sdk-local/<version>/local-release-state.json` and resumes that exact
Candidate after interruption. RC and stable continue to use the GitHub Actions
release route. See the repository's
[local release procedure](../../packages/engine/RELEASING.md).

After Candidate gates pass, `--stage preflight --version <locked-version>` checks npm access and
source-mirror prerequisites without publishing; `--stage promote` resumes that same locked
Candidate and performs publication.

> [!IMPORTANT]
> Every SDK publication starts with
> Select the release flow first:
> name the flow (development, rc cut/fix, rc promotion or stable hotfix), version,
> source SHA and npm tag before pushing a release branch or dispatching a workflow.
> If the user's request leaves any of them open, ask the user to choose the
> channel and version.
