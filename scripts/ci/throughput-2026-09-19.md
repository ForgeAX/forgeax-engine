# CI workloads above twelve minutes: 2026-09-19

> [!IMPORTANT]
> Optimize the work performed inside the slow jobs. Keep the complete roster,
> real GPU backends, 60-frame smoke policy, falsifiers and metric thresholds.
> Local measurements below are diagnostic samples, not P95 or full-CI results.

## Baseline

The complete successful baseline is Engine `8983454a6456fe6c3d5c0b5a0d462b63bc7dbb9c`,
[CI run 35429770947](https://github.com/ForgeaX-Games/forgeax-engine/actions/runs/35429770947)
and [SDK run 35429770933](https://github.com/ForgeaX-Games/forgeax-engine/actions/runs/35429770933).
These are the final checks of PR #3254, before this follow-up.

| Job | Job duration | Work inside the job |
|:--|--:|:--|
| coverage-pnpm | 724 s | Coverage: 587 s. Shader plugin and public-surface test files: 247 s and 85 s. |
| vitest-dawn | 1,168 s | Dawn command: 1,103 s. VFX mesh lighting: 75 s; barrel output: 35 s; repeated renderer fixtures also pay manifest decoding. |
| vitest-browser-shard-0 | 1,150 s | Browser command: 827 s. Barrel output: 107 s; SSAO room: 104 s; rendering recovery: 83 s. Multiplayer reconnect: another 85 s. |
| sdk-build | 1,959 s | SDK build: 1,304 s; npm consumer: 68 s; archive/browser verifier: 529 s. Build and verifier previously hid their internal stages behind buffered commands. |

These job durations are not additive critical-path savings. Baseline Actions
latency was 39m40s for CI and 32m43s for SDK.

## Work removed and evidence preserved

| Owner | Redundant work removed | Acceptance retained |
|:--|:--|:--|
| Dawn manifest fixtures | Percent-encoding the entire 142,518,109-byte shader manifest and decoding a large data URL for every renderer. Nineteen fixtures now use a Blob URL with suite cleanup. | Identical complete JSON, real fetch/parser/validation, all material variants and GPU assertions. Tiny malformed/data-URL contract fixtures stay independent. |
| Barrel GPU precision | Constructing full 1080p and 4K renderer fleets for a compute-only coordinate oracle. | The exact production WGSL runs on a real device with both dimensions, every strength/center/sample and the unchanged 0.25-pixel threshold. No texture allocation is needed; low texture limits no longer omit the 4K arithmetic case. |
| Barrel browser output | Reconstructing a device, renderer and complete shader fleet between three scenes in one output comparison. | Separate Worlds and leases, every baseline/disabled/off-center/white-source screenshot and pixel assertion. Wait for the submitted mapping when the renderer retains its previous graph during pipeline compilation. Dedicated lifecycle/recovery tests remain. |
| SSAO room | Reading 64 settling-frame images that no assertion consumes. | All 140 updates/submissions/completions, 76 pixel captures including all 60 stationary-frame comparisons, every light/occluder/camera restore and GPU-driven check. The browser gate asserts both counts. |
| Shader plugin unit fixture | A complete extra source compilation used only to inspect the material roster. | Inspect the existing source-built point-shadow/SSAO manifest. Default SSAO and standalone builder paths still execute separately. |
| SDK shaders | Compiling the exact point-shadow/SSAO profile again after `build:engine`. | The shared producer checks compiler/source/profile identity, payload path and exact bytes per requested profile. The other three profiles still compile; missing/stale/corrupt acceleration still rebuilds. |
| SDK declarations | Forcing another transitive TypeScript declaration build after the complete Engine declaration graph. | `build:engine` includes DevKit, Tool Runtime and Project; exact-archive source and consumer checks remain mandatory. |
| SDK inventory | Rereading package/skill files for sizes and hashing source files a second time. | Counts derive from the authoritative final artifact inventory; the independent exact-ZIP verifier still checks every digest and size. |
| SDK package selection | Repeated workspace discovery in 59 separate `pnpm pack` processes. | One recursive pack selects the exact same public non-WASM roster and uses concurrency 1. WASM staging remains separate. |
| SDK carrier | Copying the offline store only to delete it; creating a gzip tarball, extracting it and compressing it again for normalization. | Filter the store while copying; use the same canonical tar/gzip writer directly on the staged carrier. Byte-equality regression includes a long PAX path. ZIP still contains its full offline store. |

The manifest has 832 Standard variants and 416 Skin variants. Those variants
account for about 119 MB of WGSL before JSON overhead. They are real capability
combinations, so this change keeps them; removing variants is not a safe test
optimization without a separate capability contract analysis.

## Local measurements

Linux x64, Node 24.19.0, Mesa 25.2.8 / LLVM 20.1.2 for Dawn and Chrome 155
SwiftShader for browser qualification. Other work was running on the shared
host, so these are individual diagnostic observations.

| Same input / acceptance | Before | After | Limit |
|:--|--:|--:|:--|
| Complete manifest fetch plus JSON parse, mean of three reads | data URL: 3,636 ms | Blob URL: 721 ms | Transport microbenchmark; not renderer or job duration. URL creation separately cost 1,147 ms vs 309 ms. |
| Nine barrel Dawn assertions with Blob transport already enabled | 64.03 s | 49.92 s | Removing full-resolution renderers from the precision case; separate processes. Vitest reported native worker termination warnings in both samples. |
| Five barrel browser output assertions | 43.18 s | 33.58 s | Separate fresh processes; identical screenshots and pixel assertions. |
| Serial packing of 59 ordinary public packages | 80.88 s | 23.58 s | One workspace discovery; concurrency stays at 1. All 59 normalized tarballs were byte-identical. |
| Forced declaration rebuild after Engine declarations | 50.77 s | Removed | The initial complete declaration graph and exact-archive checks remain. |
| Four release shader profiles after the Engine build | 981.87 s | One matching profile compilation removed | Baseline stage timing; the other three configurations remain required. |
| Clean Engine build inside the SDK baseline | 333.63 s | Not a full-build comparison | Shared shader producer: 243.52 s; declaration preflight: 50.36 s. The repeated canonical-kit call was only 64 ms and is retained because its SDK variant differs. |

The removed matching SDK shader build is one complete producer invocation.
Its expected time saving is approximately one producer duration on that host,
not a measured end-to-end SDK saving. Final CI must measure the actual result.

The complete shader plugin suite passed all 82 tests with
`FORGEAX_ENGINE_SHADER_SOURCE_BUILD=1` (772.63 s total). The earlier baseline
passed in 768.87 s under different shared-input/host-load conditions; these
samples do not demonstrate a wall-clock improvement. The removed duplicate
producer invocation is established by the fixture change, pending final CI.

## Diagnostics and recovery

The supplemental `ci-runtime-bounds.test.mjs` source-text audit passed 31 checks
and failed 10 historical workflow-shape assertions on the baseline layout. It
is not a required CI command. These failures concern old job dependencies,
artifact unpack commands and retry/timeout spellings, not this change's runtime
results; do not treat that audit as current full-CI evidence.

SDK build and verification emit stage start/completion and elapsed milliseconds
to stderr while preserving the final stdout JSON. Asynchronous stages report
progress every 30 seconds. Failures retain the original error, exit code/signal
and bounded stdout/stderr tails. Carrier packing and browser/source verification
have explicit stage names. Synchronous compression may block heartbeat delivery;
its start and completion still identify the work.

A real failed child-command regression checks that exit code 7 and the missing
input diagnostic survive. The profile CLI regression verifies four requested
profiles perform only three source builds when one matching projection exists,
and continues to exercise missing, malformed, stale, mismatched and corrupt
inputs. Archive tests compare direct and normalized package bytes.

During local verification, three existing SDK source-text assertions were stale:
the `project package` command, multiline empty-template arguments, and the
Dev/CPU-profile inspection guard. They now check the current contracts instead
of rejecting formatting or the retired invocation shape.

## Remaining measured costs

| Work | Next useful investigation |
|:--|:--|
| Three remaining SDK profile builds | Determine whether identical per-entry compiler inputs can share composition safely across profiles. Preserve every profile and source validation; do not substitute one profile for another. |
| VFX mesh lighting | Separate its point-shadow source compilation from real lighting/depth/replay work before changing the fixture. |
| Browser rendering recovery | Preserve the device-loss cycles and all recovered-state assertions. Measure stage costs rather than collapsing recovery events. |
| SSAO shadows | Four 2048-square cascades and all stationary pixel checks remain real GPU work. The unused captures were removable; the stability evidence is not. |
| Full CI latency | Record exact final PR SHA, attempt, complete roster, queue and execution separately. A local sample or one green run cannot establish P95. |
