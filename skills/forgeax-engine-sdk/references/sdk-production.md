# SDK production and publication

Use for Engine/SDK maintainers producing or verifying an SDK distribution.
For game creation, return to [the SDK skill](../SKILL.md) and the generated game
AGENTS delivery scope. All commands below run from the Engine repository root.

> [!IMPORTANT]
> A successful build is not acceptance. Verify the exact ZIP that will be distributed; the verifier creates a project, installs from the bundled pnpm store with networking disabled, and runs `new`, `skill verify`, `doctor`, `test`, `build`, `dev`, and `preview`.

If full archive verification fails while a source build is still active, follow
[SDK source preparation ownership](../../../scripts/ci/README.md#sdk-consumers),
retain the failed consumer and run the process regression before repeating the
complete archive gate.

For a Codec content-key miss during SDK seed preparation, follow
[Codec source recovery](../../../scripts/ci/README.md#codec-payloads-before-native-factory-builds).
Retain the pinned compiler, source and complete payload admission before rerunning
the seed and all consumers.

SDK PR preflight and Candidate use one seed and four consumer jobs: archive
Project, archive Source, npm diagnostics and npm JS. The archive
Project owns the independent-input regression and offline TS/Game 3D journey.
Npm owns diagnostic pages and the JS publication/reopen chain. Each
cold replay stays with its live publication. The former archive View job is
removed because it repeated npm-owned diagnostics and JS verification.

On a shared host, set `FORGEAX_LOCAL_GPU_LEASE=1` on each normal consumer.
Do not wrap a whole consumer in another GPU lease: Source Preview owns its
per-template leases, while the SDK verifier admits the other complete GPU
commands individually. Source preparation and npm installation remain outside
admission. See [local GPU ownership](../../../scripts/ci/README.md#sdk-consumers)
for bounded process coordination and queue accounting.

The seed runs delivery contracts after `sdk:build` generates the facade. Every
consumer verifies its transported bytes, and aggregation requires every retained
receipt with matching identity. Upload the producer-written npm result; wrapper
stdout is not its authority. Archive and source bytes remain immutable. A green
PR workload is not a sealed release Candidate. See the
[CI operating guide](../../../scripts/ci/README.md#sdk-consumers).

## Preflight

Run from the Engine repository root:

```bash
git status --short
node --version
pnpm --version
command -v zip
command -v unzip
```

| Check | Required state | Recovery |
|:--|:--|:--|
| Git | Clean checkout for a distributable archive | Commit the intended Engine state; do not use `--allow-dirty` for Release assets |
| Node | `>=22.13.0` | Select a supported Node installation |
| pnpm | Available to the SDK builder | Enable the repository-declared package manager with Corepack |
| ZIP tools | `zip` and `unzip` on `PATH` | Install the platform ZIP tools |

For CI timing, measure all preparation and terminal work, with queueing reported
separately. Reuse shader inputs only after compiler/source/profile and payload
verification; rebuild missing inputs. The [CI guide](../../../scripts/ci/README.md#measurement)
keeps execution, resource occupation and derived paths distinct.

## Build and verify

```bash
pnpm sdk:build -- --version 1.2.3
pnpm sdk:verify -- --archive artifacts/sdk/forgeax-sdk-v1.2.3.zip
```

> [!NOTE]
> SDK PR preflight builds the exact seed before running Engine delivery
> contracts because those tests import generated facades. The suite runs once
> on the seed lane; separate consumers install the same uploaded bytes and run
> the project or archive route.

`pnpm build:engine` (and the CI package-artifact lane) scans every built public package's JavaScript imports and fails if an `@forgeax/engine-*` runtime import is absent from `dependencies`, `optionalDependencies`, or `peerDependencies`. Treat that check as part of SDK production, not as a consumer-side workaround.

Read `artifacts/sdk/sdk-build-result.json` and `artifacts/sdk/sdk-verify-result.json`. Both must contain `"ok": true`; the `engineCommit` values must equal `git rev-parse HEAD`, and the verify result must list all seven commands: `new`, `skill.verify`, `doctor`, `test`, `build`, `dev`, and `preview`.

## Select the release flow first

> [!IMPORTANT]
> Before any branch push or workflow dispatch, state the exact flow, version,
> source SHA and npm tag you are about to publish. If the request does not fix
> every row below, **ask the user and wait**. Never infer a channel from words
> such as "release", "publish" or "ship", and never pick a version yourself.

| Request | Flow | Branch action | Dispatch | Result |
|:--|:--|:--|:--|:--|
| Development release | One green `main` commit | None | `gh workflow run engine-development-release.yml [-f source_sha=<main-sha>]` | `x.y.z-dev.N.sha12` on `next`, public `main` mirror; promotes automatically |
| Weekly test cut | `main` tree onto `rc` | Cut commit on `rc` ([commands](../../../packages/engine/RELEASING.md#test-cycle)) | Candidate `version=<latest+1 patch>-rc.1` | `rc` tag only, no mirror; promotes automatically |
| Test fix | Fix lands on `main`, cherry-picked to `rc` | Push `rc` | Candidate `version=<same core>-rc.<n+1>` | Next rc on the same core |
| Promote rc to stable | Tested rc commit | Fast-forward `stable` to that exact rc SHA | Candidate `version=<rc core>` `source_sha=<rc-sha>`, then explicit Promotion | `latest`, public `stable` mirror |
| Urgent stable hotfix | Fix on `stable` | Push `stable`; then merge `stable` into `rc` and port to `main` | Candidate `version=<latest+1 patch>`, then explicit Promotion | `latest`; an open rc line moves up one patch |

Confirm these facts with the user when any is missing or ambiguous:

- **Channel**: development (`next`), test (`rc`) or stable (`latest`). Only stable
  changes what users install by default.
- **Version**: read the current tags with `npm view @forgeax/engine dist-tags`.
  An rc core is exactly one patch above `latest`. A promotion reuses the rc core.
  A hotfix that takes the open rc's number means the rc line continues one patch
  higher; confirm that with the user before publishing.
- **Source**: the exact SHA on its channel branch. Releases do not wait for
  branch push CI; the Candidate gates are the release proof. For a promotion, it must be the tested rc commit, not a newer one.
- **Hotfix porting**: an urgent hotfix is also merged into `rc` and ported to
  `main`. The next weekly cut takes `main`'s tree and would otherwise drop it.

Stop and ask instead of improvising when a precondition fails: an rc source that does not contain `stable`, a non-fast-forward `stable` update,
or a publisher error such as `release-rc-not-above-stable`. These errors are policy
decisions, not transport failures to retry.

## Allocate an official release

> [!IMPORTANT]
> Do not create or push `sdk-v{version}` before verification. A formal tag is an immutable published identity, not a release-candidate trigger. The old quick/unverified route is retired.

Select a version and source through [the Engine release contract](../../../packages/engine/RELEASING.md). Stable versions resolve `stable`, test versions (`x.y.z-rc.n`) resolve `rc`, and development versions resolve `main`. Dispatch the maintained controller from current `main`:

```bash
gh workflow run sdk-release-candidate.yml \
  --ref main \
  -f version=1.2.3
```

To release an already CI-verified commit on the selected source branch, pin its full ancestor SHA while dispatching from current `main`:

```bash
gh workflow run sdk-release-candidate.yml \
  --ref main \
  -f version=1.2.3 \
  -f source_sha=<40-character-source-branch-ancestor-sha>
```

The source checkout, SDK ZIP, npm tarballs, and source snapshot all use the
pinned SHA. For a development Candidate, the collision gate may run the current workflow commit's Preview
smoke script as its witness only when the pinned source already contains that
script's Preview-disposal handshake; otherwise it keeps the source-owned smoke
script. The source commit, actual witness commit, and script blob are recorded
in the gate report. This repairs a test timeout without introducing a new
lifecycle contract into older release bytes. The source must belong to its channel branch; a current-main witness is restricted
to development Candidates.

The Candidate workflow resolves one channel-branch source SHA, builds the SDK seed once, runs npm-consumer and exact archive/browser gates against it while the reproducibility and collision lanes rebuild the same commit in parallel, compares their evidence with the exact seed (npm-tree byte inventory, version/tag collision) in `seal`, then seals `sdk-candidate.json` with per-file SHA-256 and npm integrity. The reproducibility lane keeps full Git history because `sdk:build` validates the feature-catalog baseline ancestry; a depth-1 checkout can falsely reject a valid main commit. Record the successful workflow run ID; only a sealed Candidate is promotable.

Candidate prepares and source-verifies its Rapier payload once before the seed,
independent JavaScript rebuild and collision jobs. Each receiver verifies the same
transported bytes against the pinned source recipe; a mismatch fails rather than
rebuilding a different native input. Independent Rust/Binaryen compilation
reproducibility remains a separate native producer concern.

Candidate sets no consumer matrix concurrency cap after the source-producing
gates pass, retaining each owner's existing deadline. Its four receipts,
runner scheduling and seed-byte manifest are documented in the [Candidate
critical path guide](../../../scripts/ci/README.md#sdk-consumers).

Promotion starts npm publication, the GitHub Release and public-source preflight
together. `publish-npm` uploads under `candidate` and proves the public bytes with a
fresh consumer; `promote-npm` moves the channel tag only after it and (for mirrored
channels) preflight succeed, so npm visibility overlaps qualification. Npm work is
locked per channel: stable `latest`, test `rc` and development `next` do not block
each other, and a development and an rc release can run at the same time. Never cancel an active npm publisher
to advance another release: immutable units may already have been submitted.

The collision lane's `game-3d` Preview smoke reuses the exact
`shared-build-inputs/manifest.json` produced by `pnpm build:engine` and selects
only the template-owned Pack closure. This keeps Vite startup bounded by the
collision scene instead of recompiling unrelated Preview materials and fixture
roots; a missing shared manifest is a preparation failure, not a reason to
increase the startup timeout.

Failed Candidate runs retain their existing seed and successful receipts within
their declared artifact retention. For an external transport failure on unchanged
source, inspect all required artifacts and rerun the completed Candidate with
`gh run rerun <candidate-run-id> --failed`; successful producers and consumers
remain authoritative. The earliest expiry limits recovery, normally one day for
native inputs and owner reports. Missing/expired artifacts, source or controller
repairs require a new complete Candidate. Cancelled Candidates are cleaned by
the backstop. Successful sealed Candidates retain their payload and seal for
Promotion retries until expiry.

Candidate transports small metadata, the ZIP and npm payloads separately. Each
consumer verifies only its transported closure against the complete producer
manifest; the seal job downloads every payload once, verifies all four owner
receipts, performs reproducibility/collision comparisons and seals all bytes in
that same job. Receipt transport/aggregation runs from the trusted controller
SHA, so a stable source does not need newer workflow helper code. Archive and
npm runtime verification still execute the selected source's actual verifiers.

Promote that exact Candidate:

```bash
gh workflow run sdk-release-promote.yml \
  --ref main \
  -f candidate_run_id=123456789 \
  -f version=1.2.3
```

Promotion downloads the sealed artifact and revalidates every byte and identity.
For stable and development versions, the original source exporter first
qualifies the complete public snapshot and target branch without remote writes. This mandatory admission runs
even when mirror synchronization is paused; its Candidate-bound proof is required
by the npm publisher. See [public-source admission](../../../scripts/forgeax/EXPORT.md#mirrored-publication)
for coverage and local recovery commands. Promotion creates or completes the
GitHub Release idempotently and publishes npm products independently after this
shared source qualification. The enabled source mirror follows GitHub
publication to validate the formal Release/tag identity, using the same export
manifest and Git tree as preflight. Its public CI and final tree must pass for
complete delivery, but npm does not wait for GitHub or mirror completion. A paused
mirror still requires mandatory source qualification before npm publication.
Each mirrored channel advances only its own public branch (development to
`main`, stable to `stable`). The rc test line skips the source stages.

The three existing npm tarballs upload concurrently under `candidate` without
rebuilding. One joint gate verifies public metadata and exact downloaded bytes;
a fresh registry consumer must pass before each package's `latest`, `rc` or `next`
advances. These channel tags remain separate registry writes. Candidate cleanup
requires every enabled publication stage to succeed. GitHub publication may be
complete while npm is still pending. After a failed Promotion completes, verify
its artifacts remain available and run `gh run rerun <promotion-run-id> --failed`.
This reuses the successful source qualification and independent publishers under
the original controller SHA instead of dispatching the complete workflow again.
A changed source needs a new Candidate. A same-version different-integrity
response is terminal and must never be overwritten.

## Archive surfaces

Every SDK archive contains both of these surfaces:

| Surface | Archive path | Contract |
|:--|:--|:--|
| Built use (full ZIP) | `bin/`, bare `packages/`, `templates/`, `skills/`, `store/pnpm/` | The CLI requires `empty` or `game-3d`, installs project-local Engine skills, and creates games without registry access. |
| Built use (npm carrier) | `bin/`, bare `packages/`, `templates/`, `skills/` | The carrier deliberately omits `store/pnpm/` to stay publishable; `new` and `init` use the exact lockfile against the npm registry. |
| Source development | `source/engine/` | Tracked Engine source and guidance, plus the pinned wgpu source expanded under `third_party/wgpu/`; private binary assets remain excluded. |
| Prebuilt WASM | `source/engine/packages/{wgpu-wasm,fbx,codec}/pkg/` and `toolchain/wasm/` | Checked glue and binary outputs remove the default Rust/Emscripten hydration prerequisite. |

The source snapshot is not a nested Git checkout and intentionally excludes
`forgeax-engine-assets`. It carries `.forgeax-public-distribution`, which makes
`pnpm install`, `pnpm build:engine`, and `bun fx setup` avoid internal repository
hydration. The non-code resource closure is the preview package's explicit
`assets/canonical-kit/{sky.hdr,sky.hdr.meta.json,cook-receipt.json}` allowlist in
`scripts/forgeax/sdk-lib.mjs`. The `game-3d` template needs no copied binary
closure because its analytic sky, materials, meshes, and scene are generated by
tracked `*.pack.ts` sources. The builder copies only the package allowlist into
the source snapshot, and the verifier checks exact equality. The source
project may still install ordinary JavaScript dependencies from its configured
registry; the bundled WASM outputs only remove the separate WASM fetch/compile
step. `sdk-manifest.json` records both resource allowlists, every root skill's
file/byte closure, source file/byte counts, explicit exclusions, and checked WASM paths, while `artifacts` remains
the single per-file inventory.

Before building from a contributor checkout, initialize the Engine-pinned wgpu
source with `node scripts/ci/prepare-source-checkout.mjs`. Source export fails if it
is missing. Verify `source.gitDependencies` in the manifest and the corresponding
ordinary source directory in the extracted SDK; users must not need Git access.
Maintenance and Rust rebuild commands are in `third_party/README.md`.

The verifier covers both product surfaces: it explicitly creates a `templates/empty` project through `new`, `skill verify`, `doctor`, `test`,
`build`, `dev`, and `preview`, and creates a
`game-3d` project through explicit template selection.
It then separately checks the source snapshot's public resource closure and real Preview-host template smoke. The standalone host
consumes the project's build-time producers declared in `*.pack.ts`; `forgeaxShader` owns WGSL compilation,
and game plugins own the corresponding runtime loaders.

The exact source-distribution smoke proves renderer health, UI, pointer lock,
mouse look, W/D movement, animation, projection, and FixedTick from the unpacked
source snapshot. It records the long `game-3d` collision journey as exactly
`{ status: 'omitted', reason: 'sdk-source-distribution' }`; any other omitted or
missing state fails verification. Collision acceptance remains owned by the
default full `@forgeax/preview smoke:templates` gate. The Candidate workflow runs
that complete `game-3d` collision journey through the exact archive/browser
lane before sealing.
That lane must fetch the content-keyed private `wgpu-wasm` release with
`GHA` and pass `verify-current.mjs` before building Engine; best-effort WASM
hydration is not release evidence.
The collision lane keeps `FORGEAX_TEMPLATE_SMOKE_DIR` absolute (`${{ github.workspace
}}/artifacts/sdk-release-template-smoke`) because pnpm's filtered Preview script
runs from `apps/preview`; the root combine step reads the report from that same
workspace path.

Pointer-lock carrier selection is page-local: every fresh `game-3d` browser
process probes native acquisition and Escape release on a dedicated same-origin
blank document in the same Playwright Page before navigating that Page to the
real game. The blank document must not boot a second Preview/game instance, and
a different or discarded browser must not donate a stale native-capability
result. When that exact Page cannot carry native lock, the smoke records the
failed native probe and installs its explicit test-only Host-input shim before
navigation; UI, relative mouse look, movement, animation, projection, and
FixedTick assertions remain mandatory.

Hosted Chrome/Lavapipe may lose its external GPU Instance while the unpacked
source journey is running. The source-distribution route accepts at most one
exact `A valid external Instance reference no longer exists` event only when it
is ordered before `journey-complete`, the complete UI, pointer, mouse-look, W/D,
animation, projection, and FixedTick evidence is still present, and the old
renderer's real terminal state remains `device-lost`. The verifier then starts a
new Chrome/GPU process and requires an `alive` renderer with a submitted frame;
that fresh-process viability is not described as survival of the lost renderer.
The report records the event sequence, journey-completion sequence, old terminal
health, and fresh frame as `sdk-source-host-gpu-instance-loss`. Every different,
duplicate, late, page, response, or console error remains fatal. Source
verification reports `passed-with-omissions`, preserving both bounded omissions
in the release evidence instead of presenting them as full Preview/physics
acceptance.

The full ZIP treats pnpm package payloads under `store/pnpm/` as immutable distribution content. The verifier recomputes those payloads after creating and exercising both templates; `sdk-consumer-mutated-store` blocks content drift. pnpm 12 may hydrate its SQLite `index.db` runtime cache during the first install, so that cache is the only post-extraction digest exception and carries no package authority. The npm carrier intentionally has no store: `findSdkContext()` detects that absence and the bootstrap path runs a frozen, registry-backed install.

Release these sibling files together:

```text
forgeax-sdk-v{version}.zip
SHA256SUMS
forgeax-sdk-v{version}.spdx.json
forgeax-sdk-v{version}.provenance.json
sdk-verify-result.json
sdk-candidate.json
```

The build also emits `npm/packages/*.tgz` and
`npm/forgeax-engine-sdk-{version}.tgz`. Run the local contract gate before any
network publication:

```bash
pnpm sdk:publish:npm -- --version 1.2.3 --check-only
```

The check-only gate serves the exact staged tarballs from a local registry and
proves umbrella `dlx` → carrier install → SDK init → both template
new/doctor/test/build/dev paths without publishing.
Its registry is passed through `pnpm_config_registry` for pnpm 12 and
`npm_config_registry` for SDK metadata fetches; it does not require template
`.npmrc` files. If an unpublished check version reaches the public registry,
repair this verifier configuration before assessing the carrier.
The verifier also uses pnpm 12 script argument forwarding, `project package`,
and the `dev start` endpoint lifecycle described in the CI operating guide.
It stops a discovered daemon even when startup fails and retains the failed
consumer directory so cleanup cannot erase the original diagnostic.

The Promotion workflow publishes only complete Engine, View tool and SDK carrier
tarballs with `NPM_TOKEN`. Focused Engine modules and their transitive runtime
requirements are inside the Engine tarball. Source package boundaries remain
available in the SDK's bare `packages/` inventory.

Promotion submits each unit under `candidate`, waits for its public metadata and
actual downloaded SHA-512 bytes, and then proceeds to dependent delivery units.
It exercises a fresh registry consumer through SDK installation, initialization,
both templates, typecheck, tests, build, package and dev HTTP lifecycle before
updating the derived `latest` or `next` tag. The workflow serializes promotions;
the publisher rejects channel regression. Tags across separate products are
individual npm writes; an interrupted tag update is completed by retrying the
same sealed Candidate. Because the repository and its Releases are private,
public install paths require no GitHub token.

`npm-publication-not-visible` leaves the existing channel unchanged. Preserve the
sealed bytes; wait for npm validation and rerun only the failed Promotion jobs. A previously
staged conflict is a pending identity, not permission to allocate a new version.
`npm-published-integrity-mismatch` is terminal. Source repairs require a new
Candidate and version. Development releases are explicit:
`gh workflow run engine-development-release.yml [-f source_sha=<main-sha>]`
continues the published `next` sequence and submits a Candidate; successful development and rc Candidates promote automatically. Stable Candidate promotion remains explicit.

## Reproducibility check

Build twice from the same clean commit into separate output directories:

```bash
pnpm sdk:build -- --version 1.2.3 --output artifacts/sdk-a
pnpm sdk:build -- --version 1.2.3 --output artifacts/sdk-b
shasum -a 256 artifacts/sdk-a/forgeax-sdk-v1.2.3.zip artifacts/sdk-b/forgeax-sdk-v1.2.3.zip
```

The ZIP digests must match. The Candidate workflow independently compares a
sorted SHA-256 inventory of both `npm/` trees, including the complete Engine, View and SDK carrier tarballs. The rebuild lane uploads its inventory and `seal`
compares it with the exact seed. A mismatch in either evidence set blocks
publication. Critical-path timing and its measured/estimated split live in
`scripts/ci/README.md` §SDK Candidate critical path.

## Failure routing

Build and verifier stage progress is written to stderr, including elapsed time,
child exit code/signal and bounded error-output tails. Start with the last
`[sdk] start` / `[sdk] running` stage when a command stalls. Profile preparation
reuses only a source/compiler/profile and byte-verified shared projection;
missing acceleration rebuilds. The stored roster is `base-ssao` plus `point-ssao`;
consumer projection disables the independent SSAO utility without duplicating
material compilation or package bytes. See the [SDK/Dawn workload evidence](../../../scripts/ci/sdk-dawn-workload-2026-09-19.md).

| Signal | Owning input | Action |
|:--|:--|:--|
| `selectedBrowser.playerRead` or inspection-list stage times out | SDK browser observation / game-owned read | Retain the failing stage and real execution diagnostics; keep the original observation budget and drain the owned page, browser and daemon before retrying. A progress heartbeat is not completion. |
| `Pack service worker preparation timed out during ...` | Pack native module delivery | Inspect the reported registration lookup, registration or page-control phase in `packages/pack/src/program-browser.ts`, then the DevKit runtime delivery host. Keep the actual native Pack execution gate; do not block service workers or replace the program with static content. |
| `Unable to replace auth placeholder in .git/config` or `could not migrate git directory` during recursive checkout preparation | Persistent standalone View Git metadata, possibly with a stale absorption destination | Repair the pre-checkout absorption route in the [CI guide](../../../scripts/ci/README.md#sdk-consumers), then dispatch a new Candidate with the same verified source SHA. |
| `sdk-dirty-checkout` | Git source identity | Inspect the named paths. Disposable CI source producers use recursive submodule reset and cleanup before preparation, per [failure recovery](../../../scripts/ci/README.md#failure-recovery); contributor checkouts commit or preserve their changes. |
| `sdk-package-*` | Bare public package directories | Repair package visibility, exports, wrapper removal, or file closure; rebuild |
| `package-runtime-dependency-closure` | Built package JavaScript plus package manifests | Move every external `@forgeax/engine-*` runtime import out of `devDependencies` and into `dependencies`, `optionalDependencies`, or `peerDependencies`; rebuild |
| `npm-publication-not-visible` | Public npm metadata, dist-tag, or tarball propagation | Inspect the named package reason and npm status; preserve the version and retry only absent bytes |
| `npm-published-integrity-mismatch` | Immutable registry bytes versus staged tarball | Stop; never overwrite or retag the version |
| `sdk-candidate-*` / `sdk-npm-version-conflict` / `sdk-tag-conflict` | Sealed Candidate identity, artifact, or collision gate | Keep the version unallocated; repair the source/gate and create a new Candidate |
| Other `npm-*` | Exact-version npm package set or SDK carrier | Repair version projection, umbrella closure, or carrier bytes; never publish a partial mismatched version |
| `sdk-artifact-mismatch` / `sdk-unmanifested-artifact` | Archive manifest generation | Repair the SDK builder; do not edit the staged archive |
| `sdk-manifest-schema` | `schemas/sdk-manifest.schema.json` contract | Repair the producer or schema in one change |
| `sdk-source-file-count` / `sdk-source-byte-count` / `sdk-source-unportable-tree` | Source snapshot materialization | Repair source archival or exclusion rules; rebuild |
| `sdk-source-private-dependency` / `sdk-source-exclusions` | Public source sanitization | Remove submodule metadata or private asset paths from the staged source; rebuild |
| `sdk-resource-allowlist-missing` / `sdk-resource-allowlist-drift` / `sdk-resource-package-drift` | SDK resource closure | Repair the allowlist or the package-owned resource; rebuild and rerun the verifier |
| `sdk-template-resource-missing` / `sdk-template-resource-allowlist-drift` | Full template resource closure | Repair the template allowlist or its package-owned inputs; rebuild and rerun the verifier |
| `sdk-skill-*` / `skill-verify-failed` | SDK root `skills/` or project-local mount projection | Repair the skill source/manifest or rerun `forgeax project skill install`; never patch mount copies |
| `sdk-consumer-mutated-store` | SDK-backed pnpm package payloads | Repair package-content mutation; SQLite `index.db` hydration is the only cache exception |
| `npm-sdk-carrier-store-*` | npm carrier surface | Remove `store/pnpm/` from the carrier; keep it in the full ZIP and rebuild |
| `sdk-source-wasm-path` / `sdk-source-wasm-unmanifested` | Prebuilt source WASM closure | Restore the owning package `pkg/` outputs and rebuild; missing Blitz UI inputs use `prepare-ui-blitz` in every Candidate source producer, per [Host build inputs](../../../scripts/ci/README.md#cross-platform-host-build-inputs). |
| `project-target-inside-sdk` | SDK and game ownership boundary | Choose a sibling directory or an absolute path outside the SDK; never turn the distribution into a game workspace |
| `sdkUpdate.status=available` | Public npm selected channel tag | Consider a separate newer SDK install; review release notes and explicitly migrate/test each pinned game before changing Engine versions |
| `project-create-failed` | Offline store/template closure | Repair lockfile/store generation and rerun the verifier |
| `doctor`, `test`, `build`, or `preview` failure | External consumer path | Fix the owning Engine/DevKit layer, rebuild a new ZIP, verify that ZIP |

Do not publish an archive verified before its final bytes were produced. Do not substitute a workspace-linked project for the verifier's extracted offline project.

SDK PR browser owners use the existing Runner CPU-affinity envelope for independent inputs and all npm/archive qualifications. Diagnose quota and inherited mask through the [CI guide](../../../scripts/ci/README.md#sdk-consumers); retain full consumer execution and measure its effect on the final commit.
