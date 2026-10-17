---
name: forgeax-engine-debug
description: >-
  ForgeaX troubleshooting router with RHI Debug first for difficult rendering failures.
  Use when rendering is wrong, CI is slow or flaky, tests fail, asset hot reload fails,
  or a clean worktree behaves differently.
---

# forgeax-engine-debug

Package READMEs and AGENTS.md own design contracts. Diagnose current source and
actual failure evidence; historical lane numbers and old run narratives are not
operating instructions.

For a blank MCP View with React error #527, run its emitted frontend startup gate
through the View contracts owner. The MCP builder resolves React and React DOM
from View's installed dependencies; inspect that owner before changing startup
deadlines. Continue through the full game-3d/Play/Stop gate after repair.

For a View startup Host disconnect, read the failed probe's Backend diagnostics
under `artifacts/view-integration/<probe>/` before assigning a renderer cause.
The CI owner matches native daemon spawn records to the failed child and retains
its stderr after cleanup. Preserve the original timeout and failed exit; follow
the [failure recovery route](../../scripts/ci/README.md#failure-recovery).

For repeated app builds, slow metric aggregation or successful diagnostic uploads,
follow [one build and one metrics execution owner](../../scripts/ci/README.md#one-build-and-one-metrics-execution-owner).
Check the disjoint App/Bevy source roster and actual metric consumers before
adding a cache or scheduler rule. Keep all retained Bevy cases at 60 completed
frames and preserve metric producer failures through the required aggregate.
For Bevy input tails that stop before release, use the existing ready-receipt
frame driver; RAF callbacks are not completed App frames. Preserve authored
simulation horizons when reducing ECS fixture submissions.
Measure complete Runner minutes and the critical path without queue time.
For compiler `sourceContentKey` mismatches during input restoration, compare the
actual wgpu/Blitz checkouts with the Engine gitlinks before rebuilding. The shared
input entry must synchronize existing public source checkouts too; `Cargo.toml`
presence is not pin admission. Retain compiler source and byte verification.

Basic source initialization and ordinary tests do not require Dawn. `pnpm test`
retains its DevKit browser journeys; Dawn GPU testing is a local opt-in. For a missing
carrier on macOS/Windows, explicitly run
`pnpm --filter @forgeax/engine-dawn-node build:native` before `pnpm test:dawn`;
follow the [carrier contract](../../packages/dawn-node/README.md). Do not add
native compilation to installation or ordinary builds, skip missing GPU evidence,
or substitute Dawn for the native wgpu Ray Query backend.

On Windows, run `pnpm test:browser` / `pnpm test:dawn` through the
[Node suite entry](../../scripts/ci/README.md#concurrent-local-sessions-and-the-gpu-lease).
It preserves the full roster and owner deadlines while passing environment
values directly; no POSIX assignment or package-manager upgrade is required.
For Smoke roster drift or exit-zero shell controls without a receipt, inspect
the [Windows repository shell route](../../scripts/ci/README.md#windows-repository-shell-commands).
Retain the real child assertions and canonical frame evidence; exit zero alone
does not qualify the command.
For a Windows multi-project Vitest failure, verify that CLI exclusion globs reach
the resolved project with forward slashes. The actual workspace regression in
`scripts/ci/__tests__/run-vitest-projects.test.mjs` requires ordinary tests and
rejects the excluded file; retain the separately leased DevKit native groups.

For the Windows Nightly `Build opt-in Dawn native carrier` step, separate CMake
generator/configuration from the later MSVC source compile. A CMake log that
selects `Visual Studio 18 2026` proves generator selection only; the native
build must finish and publish its verified output. Check the build worker cap
when MSVC is still compiling DXC/LLVM at the cold-build deadline. The CI guide
owns the cold-build budget and content-keyed output cache; never cache or
restore the CMake build tree.

Package-script environment prefixes use the workspace's pnpm `shellEmulator`;
direct child launchers must use `pnpmCommand`, including composite Smoke gates.
Do not install an extra shell or replace a failed child with an exit-zero receipt.
For workflow ShellCheck failures, follow the [CI shell transport contract](../../scripts/ci/README.md#ci-code-ownership)
and retain the original file roster and preparation failure exits.
For a leaked Windows Vite port, use the shared owned process-tree cleanup and
its actual TCP regression; never terminate unrelated Node processes. For Import
sidecar `EPERM`, compare the actual destination bytes: only an equivalent
publication succeeds; mismatches retain the structured failure and rollback.
For SSR recovery compilation near its 20-second deadline, inspect the actual
pipeline labels and admitted specs. Standard uses the material cache and exact
LKG recovery requests; do not reintroduce the generic bootstrap matrix or widen
the deadline. The tree-shake owner builds missing production output through
the maintained source builder and still fails if the actual bundle is absent.
For Node paths containing spaces, that builder starts Node directly without a
shell; preserve its actual hello-cube production-bundle regression.
For cold bundle preparation under coverage, verify that the tree-shake test
forwards `FORGEAX_SHARED_APP_INPUTS_MANIFEST` to the maintained app builder.
Keep the source-key admission and original timeout; repeated shader preparation
inside the fixture is not a reason to widen its deadline.
If Windows Rapier preparation stalls after compilation, inspect the declaration
producer and its exact tsup entry; retain the real junction-mounted regression in
`scripts/__tests__/rapier-wasm-declarations.test.mjs` before rebuilding the payload.

For Runtime Pack's Windows `wgpu-webgl2` assertion, follow [Windows Runtime Pack WebGPU admission](../../scripts/ci/README.md#windows-runtime-pack-webgpu-admission). Keep the backend, pixel and sixty-frame assertions.
For Mesh I/O `adapter-unavailable` on Windows CI, check whether Linux-only
Vulkan/SwiftShader flags reached Chromium. For its sRGB source-color oracle,
inspect the real linear readback and RHI live/replay/missing-draw triptych;
native format conversion precision is separate from the unchanged authored
linear HDR budget. Retain the twenty cases and gamma/UV falsifiers.

For native artifact producer scheduling, follow [Windows native Ray Query artifact producer](../../scripts/ci/README.md#windows-native-ray-query-artifact-producer). Windows hosted producers use explicit maintainer dispatch in the nightly lane; daily PR and post-merge checks retain self-hosted runners and strict artifact admission.
For the upstream Linux Naga producer, a Vulkan SDK `tar` failure naming missing
`xz` belongs to archive-tool setup. Install `xz-utils` before the pinned SDK action
and rerun the original WGSL/SPIR-V snapshots; setup failure is not a snapshot pass.

For slow isolated native GI imports, prepare the source-bound shared shader inputs and pass `FORGEAX_SHARED_APP_INPUTS_MANIFEST` through the ordinary shader builder, as the native CI group does. Retain the full GPU roster and its falsifiers; never point the consumer at an unchecked old manifest.
For late Preview or Capability Lab readiness, follow [failure recovery](../../scripts/ci/README.md#failure-recovery).
Keep the actual failed frame and distinguish Browser evidence from diagnostic
Dawn replay. Separate Catalog preparation, payload decoding and completed-frame
readiness before assigning a renderer cause. Source-byte reuse must retain digest
and size admission; a faster decoder alone does not qualify startup.

For SDK contracts that cannot import built Engine subpaths on a clean runner,
inspect [build inputs](../../scripts/ci/README.md#build-inputs) and the seed's
production outputs before its producer-owned contracts. For a missing native
binding after npm installation, reproduce with the exact package bytes and
installation flags. Preserve the published bundle layout and external peer edges
in DevKit run snapshots; a successful install is not a successful native run.
Compact shader source fragments and receipt tables must survive transport and
materialization without replacing source identity with table indices.

For `ERR_PNPM_TASK_CYCLE`, inspect the exact producer build closure. Preserve an
existing deliberate-cycle setting only on the owning build step; other filtered
commands must continue to reject unexpected cycles.

For Preview Catalog timeouts or Windows DDC publication `EPERM`, inspect the
producer-readiness option, native watcher and destination bytes before assigning
a shader or renderer cause. For template startup failures, preserve native Error
fields through console transport and inspect the named cause. Follow the
[SDK failure route](../../scripts/ci/README.md#failure-recovery): visible terminal
errors fail promptly, healthy startup retains its allowance, and backend stop
requires its own retirement evidence. Preview keeps separate Catalog and
completed-frame deadlines; an inspection connection or capture is not readiness.

For Screen Probe motion, noise or receiver-sequence failures, follow
[RHI Debug](../forgeax-engine-rhi-debug/SKILL.md) and inspect actual probe and pixel
work before changing history budgets. Keep whole-scene quality and physical
timing separate from kernel controls. Download current-source motion tapes,
pixel bytes and typed replay reads while CI artifacts remain available; metadata
or older tapes cannot qualify missing current evidence. Native Ray Query remains
a separate backend from Dawn. Diagnostic uploads never admit a failed gate.

For VFX Mesh lighting failures, inspect `artifacts/ci-focus/vfx-mesh-lighting/`.
An in-flight frame retains its unavailable-capture result; diagnose its recorded
renderer/device owner before requesting a later frame. For WebSocket status 1009
or `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`, preserve the original error, tape bytes
and transport budget. For Topology Browser failures, read
`artifacts/ci-focus/topology/failure.json`: Catalog startup belongs to its named
producer; frame or PNG failures use RHI Debug. Follow [failure recovery](../../scripts/ci/README.md#failure-recovery)
and retain the original oracle and timeout.

For Dawn partition roster drift, compare actual Vitest titles with the
case-sensitive patterns in `scripts/ci/run-dawn-partitions.mjs`. VFX depth's
standalone Player MeshFilter belongs to the mesh partition in both modes;
follow the [Dawn gate roster](../../scripts/ci/README.md#dawn-gates) and retain
unique coverage, original assertions, and failed-result rejection.

For run `38488147135` at `9ef74f951`, follow
[artifact sharing and adopted Play readiness](../../scripts/ci/README.md#artifact-sharing-and-adopted-play-readiness).
Separate live WeakRef sharing from collection/refetch, and distinguish hidden
fatal markup from an actual startup failure. MCP Backend logs belong to the
spawning CLI child; keep the original 120-second readiness/cleanup bound.

For `7a25ead8e` initial MCP connection or mobile input failures, use
[first workspace connection and concurrent validation](../../scripts/ci/README.md#first-workspace-connection-and-concurrent-validation).
Inspect the owned Backend stages and complete pointer-event evidence. A reduced
compiler invocation count does not qualify the original Browser deadlines.

For Snake late-join `ACK retry budget exhausted`, follow
[multiplayer startup and baseline ACK admission](../../scripts/ci/README.md#multiplayer-startup-and-baseline-ack-admission).
Keep initial polling with the World receive system and reproduce delayed Host
activation on the real browser path without expanding the game ACK budget.

## Rendering: RHI Debug first

For difficult or unexplained rendering failures, use
[forgeax-engine-rhi-debug](../forgeax-engine-rhi-debug/SKILL.md) before speculative
shader or material changes. Capture the real failing frame and inspect its work,
bindings, resources and pixels. This covers missing output, wrong lighting or
shadows, flicker, post-processing artifacts and backend divergence. A concrete
startup, asset or schema error goes directly to its named owner. If capture is
unavailable, preserve the structured failure and use the RHI Debug recovery path.

A broken demo may expose an Engine gap. Trace the owner instead of introducing
placeholder assets, manual frame loops or demo-side fetch workarounds.

A camera-free World is valid. Do not add a Camera to repair `empty` startup:
trace any `render-system-no-camera` event to the renderer owner. Template Browser
smokes reject that event rather than exempting empty scenes from console checks.

## CI diagnosis and iteration

For a manual run that rejects evidence already on the PR target branch, inspect
the guard's comparison base. Follow [manual CI comparison base](../../scripts/ci/README.md#manual-ci-comparison-base)
and dispatch with the actual target comparison SHA through `comparison_base`.
Keep new-evidence rejection and the complete product checks; do not delete
unrelated baseline files to compensate for a missing PR event base.

For a synthetic merge that schedules eight Dawn lanes while checked-out product
source accepts four, align the workflow and executable selectors during main
integration. SDK ZIP/npm groups and their receipt aggregate must likewise match
the four consumers. When native owner arrays are shortened, map retained cost
samples by their original files before assigning the new numeric group labels. Preserve original native, pixel, lifecycle and seed identity
checks; a selector failure before execution is not a backend failure.

For CI code reduction, follow [CI code ownership](../../scripts/ci/README.md#ci-code-ownership).
A sudden roster or fixture-cost increase after a merge may restore retired work.
Check deletion history and retain the shared budgets and four-job matrices while
keeping genuine new feature and lifecycle coverage. Follow the
[SDK consumer mapping](../../scripts/ci/README.md#sdk-consumers): the npm
diagnostics install must also run the shipped Game 3D Play helper, while ZIP
project retains TypeScript live/cold coverage. A local Engine View success does
not qualify the installed Play snapshot. Inspect the failing owner's stage log
before changing a deadline or splitting the four-consumer matrix again.
Use `pnpm ci:focus --kind <kind> --select <selector>` (also `bun fx ci`) for source reproduction;
the local Actions emulator and workflow-string snapshot suites are retired.
Actionlint checks workflow syntax and complete final-head CI checks execution.
Artifact bytes and source admission remain enforced at their actual consumers;
do not recreate `timingRoster` or a second expected workflow graph.
Smoke schema 3 has scalar oracles and manifest-owned commands; retain exact gate
membership and reject mixed-schema receipts. Bun consumes core/shared artifacts
directly and tests its own install/build/runtime path; repeat source scans stay
with the primary owner. The optional real-GPU timing workflow validates the
producer report in one job; its retired host-contention admission report is no
longer a qualification claim.
The workflow and executable rosters are the scheduling authority. Do not restore
the retired terminal-SLO projection, cost ledger, DDC relay or feature-branch
attestation jobs. Node/pnpm setup has one shared Action; Smoke receipt validation
remains with its required aggregate. Inspect that job's log after success and the
original shard evidence after failure.

Use the [CI operating guide](../../scripts/ci/README.md). It owns the current
four Browser lanes, four Dawn lanes, core Smoke roster and four SDK consumers.
Every matrix stays within four actual jobs, including platform entries.
For measured Browser roster coverage failures, refresh missing costs from completed
process receipts using the [Browser cost formula](../../scripts/ci/README.md#browser-gates).
Keep source-run provenance, distinguish amortized group costs from independent
file timings, and preserve the coverage threshold without counting startup twice.
The suite deliberately retains representative core coverage. Keep unique browser
transport, Worker, media and recovery cases; shared numerical fixtures can have
one real-backend owner. Do not restore deleted duplicate tests or historical
scheduling guards just to reproduce the former inventory.
For a Dawn job cancelled after native process PASS, inspect its job annotation,
complete owner costs and runner variation through the [Dawn cost table](../../scripts/ci/README.md#dawn-gates).
Preserve the cancelled receipt and qualify the refreshed placement with full final-head CI.
Refresh the existing file/owner table from multiple completed native rosters.
For a cancelled run, admit only individually completed owners and ordinary-file
receipts; never treat a partial owner or an unstarted tail as complete. Retain
per-file observation counts in the investigation artifact: three observations
use their median, one or two use their largest observed cost, and unobserved
files keep the sequencer's conservative fallback. Include each ordinary file's
share of native process overhead and each fixed owner's complete child-process
and cleanup costs. Ordinary work automatically moves when costs change. Replay
actual current discovery across all four lanes before moving complete groups,
show missing historical costs as forecasts, and keep job setup and runner
variation separate from new CI measurements. Preserve all four jobs, the
27-minute deadline, frame windows and backend assertions. When upstream removes
duplicate wrappers, reconcile explicit owners against actual discovery and remap
heavy-group cost samples by file identity rather than their old numeric labels.
Account for complete transmission, shadow, Screen Probe and multi-view GI owners
rather than concentrating their serial native processes on one lane. Separate
Surface, VFX depth and Direct Light too; updated ordinary costs must share that
same placement. Core flow self-tests belong to the existing
primary regression batch; keep source admission and actual output production
on the core producer.
For a slow shared-input producer, separate cache admission, cold shader
compilation and catalog preparation. It uses the existing heavy pool with the
shared cgroup capacity check; never size workers from the physical host count.
Compare identical cold outputs and CPU work before attributing gains to resource
allocation, and keep cache-hit timing separate from compilation speed.
For `ERR_INPUT_TYPE_NOT_ALLOWED` in a declaration Worker, reproduce with the
actual Dawn preload. Start the fixture from a file instead of forwarding an
eval-only argument into tsup Workers; retain declaration content assertions.
For a slow Coverage tail, inspect [coverage execution](../../scripts/ci/README.md#coverage-execution):
ordinary children must fill available slots before the exclusive phase. Refresh
existing project costs from complete runs rather than adding worker exceptions.
Render and Vite Pack retain independent ordinary children; avoid binding their
large import costs to unrelated packages.
Include type preflight and each exclusive owner in the complete lane estimate;
stale exclusive costs can concentrate the serial tail on one shard.
Type-test roots retain selected tests, imported source and ambient declarations;
core/primary own ordinary source checks. For the runtime-vase browser tail, verify
the shared canvas budget applies before UI edits, while full UI screenshots and
both 60-frame execution routes remain intact. A View diagnostic resume must wait
for the real buffer resize as well as frame completion; an old-size completion
is not resize evidence.
Coverage placement estimates its parallel phase and serial exclusive tail separately;
keep that shared plan independent of each Runner's execution resource limit.
For Browser placement, use complete child costs (including startup/cleanup) from
`browser-file-seconds.json` and measured serial tails. Do not add another fixed
startup surcharge to those costs; validate longest-lane forecasts in complete CI.
For a group timeout after several passing files, inspect the complete serial
batch cost. Ordinary batches use the same measured table with a 150-second
target inside the unchanged five-minute deadline; keep isolated owners intact.
For large capture transfers, reuse the shared lossless `compactTape` fixture.
Keep the seeds, events, pixel checks and real replay falsifiers; omit duplicate
work/resource JSON only when it is reconstructible from the retained tape and
has no downstream consumer.
Smoke placement uses current complete gate times plus post-roster tails; remove
retired work from estimates as well as execution. For an idle App build slot,
inspect start order: the existing input inventory prioritizes larger closures
without adding another cost table or increasing concurrency. Live-sync uses the
shared disposable-project reducer; retain the real CLI/daemon/browser journey
and report fixture size reduction separately from measured elapsed-time effects.
Mesh keeps sixteen distinct routes and all real capture/replay/falsifier checks.
Successful CI retains every offline analyzer input while omitting duplicate
control tapes, geometry dumps and previews. Run the full Mesh `verify` package
command; the browser script alone does not qualify its source numeric oracles.
For GI load, use the shared ray budget and the smaller two-level multi-view grid.
Edit/rebuild convergence, movement signal/noise, Screen Probe history and multi-view
fairness keep 64-ray overrides on both backends. Validate shared reductions on Dawn
and native Ray Query; a failed lower-sample oracle never justifies looser thresholds.
Volumetric fog has one required Smoke owner; its removed Dawn wrapper repeated
that same script and its extra byte-difference assertion now belongs to the script.
For Dawn duration, distinguish static setup from temporal acceptance. Reuse
`render-quality.json`'s static frame count in unchanged material/color fixtures;
Surface optical/MSAA, Forward/Deferred parity, clipping, lighting-channel
baselines, material MRT and framebuffer preparation use that same budget.
Shadow-field comparisons also use its map size and a distinct half/twice-size
pair; retain all twelve assertions, fresh hosts and varied/held pixel controls.
Keep cube-face completion, recovery windows and every pixel/replay falsifier.
Lens samples override the default to six frames and retain their composition
window to preserve the 60-frame fixture lifetime. Keep convergence, asynchronous
readiness and canonical 60-frame smoke budgets.
Remove report-only GPU benchmarks without a cost bound. GI pass-presence checks
reuse `renderer-irradiance-field.fixture.ts`'s consecutive-frame observation;
keep per-frame absence checks, numerical thresholds, replay and falsifiers.
Direct-light regression and HDRP producer scopes are disjoint: `pnpm test:dawn`
owns regressions, required color-lighting metrics owns the four native captures
joined with Browser URP. For a producer failure, run
`FORGEAX_DAWN_PARTITION_SCOPE=producer node scripts/ci/run-direct-light-dawn.mjs`;
reuse each live capture for artifact checks instead of rendering it again.
Mesh interchange keeps distinct format/material/camera/skin routes; repeated
OBJ/GLB performance samples belong to its opt-in fidelity benchmarks. Optional
Mesh, lighting-channel/GI and Wave 1 captures upload only after failure. Inspect
the successful check logs rather than treating an absent optional artifact as
missing acceptance; required producer artifacts and receipts remain mandatory.

Read the failed head's logs and separate preparation, execution, teardown and
transport. Reproduce with the owning package or `pnpm ci:focus`. Keep the real
backend and failure assertion. Fix the owner, run its relevant checks, then
qualify complete CI and SDK on the final commit. Retained 60-frame smokes, pixel
thresholds, negative controls and coverage thresholds remain unchanged.

Missing outputs require [source build or verified producer artifacts](../../scripts/ci/README.md#cross-platform-host-build-inputs).
CI artifact consumers restore and verify first; only a real source-build miss
provisions the wgpu, Rapier, Blitz UI and Codec owners through the shared
preparation Action. A clean
worktree needs pinned submodules before frozen installation. A retained assets
`shallow.lock` routes to `prepare-assets-checkout.mjs`: only an exclusive matching
Actions workspace may recover a lock older than the current source checkout.
Keep local/current-job locks and the foreign-Git-directory rejection intact.
Native payloads must pass their source/recipe and byte checks. CI Focus prepares Rapier before the
Engine build even for browser selectors. Chromium always runs sandboxed. Use
the local GPU lease and existing process cleanup rather than adding retries,
longer deadlines or per-test scheduler exceptions.
For simultaneous input-preparation failures, inspect the core producer first.
Its upload must succeed before fanout. The shared `prepare-ci-inputs` Action
verifies restored bytes before provisioning wgpu/Rapier for a genuine source miss.
Keep native preparation off the successful restoration path. A filtered pnpm
install still runs root lifecycle hooks unless `--ignore-scripts` is set; inspect
Harness-clone postinstall costs before blaming Rust or the package cache.
Distinguish action-download stalls from actual artifact transfer using the last
executed producer log entry.
If `Getting action download info` stalls before a composite starts, its unused
cold-path actions can still be the cause. The wgpu fallback uses the same GitHub
cache Action as its payloads, avoiding a separate Rust-cache Action resolution.
For cold dependency installation, compare downloaded package platforms with the
actual host. Ordinary CI keeps `PNPM_CONFIG_SUPPORTED_ARCHITECTURES` consistent
across install and run/exec; one-off install flags cause pnpm 12 to reinstall
the broad closure. `prepare-pnpm-workspace.mjs --install` avoids `--force` and
root postinstall hooks. SDK publication
still requires its complete installed platform closure; keep that preparation
with the distribution owner rather than changing the global workspace policy.
For Snake browser ACK exhaustion, check that the process fixture disables the
server's automatic clock before owning its ACK-paced World updates. Two clocks
bypass backpressure; retain real socket recovery and the original retry bounds.
For cold Rapier preparation stalls after Rust finishes, inspect `wasm-opt` and
cgroup `cpu.stat`. The shared Rapier Action derives `BINARYEN_CORES` from
`runnerResources()` with a four-thread ceiling; Cargo's worker limit does not
control Binaryen. Reproduce with an actual CPU quota, not only affinity, and
compare payload hashes while keeping the existing optimizer flags.
Shared catalog/shader preparation does not need Runtime or Rapier: its empty
Vite entry never loads Runtime's dev transport. Keep Runtime and both Rapier
dimensions outside its production build selection and native preparation with
actual runtime owners. Codec remains in that closure and needs preparation.
Use `--filter-prod` for both positive and negative selectors; mixed selector
families can unintentionally include unrelated workspaces.
For LOD `FORGEAX_E03_INPUTS_DIR` failures, check the CI step's existing importer
producer preparation against the hydrated app shader manifest.

For DevKit native unit queues, keep `new-project-workers` CPU preparation outside
an outer GPU lease; its `native-unit-owner` acquires the lease for prepared work.
`scene-bootstrap` uses WebGPU directly and retains its outer lease. The split-unit
runner schedules both complete journeys last from one shared file-set definition.

For Windows GPU timing lifecycle child imports, convert the built fixture path
with `pathToFileURL` before passing it to ESM import. Retain the real-device
receipt GC, destroy count, child-exit assertions and their original deadlines.

CI resource detection and concurrency budgets belong to
[`runner-resources.mjs`](../../scripts/lib/runner-resources.mjs); ordinary fixture
sizes belong to [`render-quality.json`](../../scripts/test/render-quality.json).
For Coverage contention, compare child compiler budgets with container capacity:
parallel children share CPU/memory; exclusive work retains the full budget.
Never derive shard membership from a particular Runner's quota.
For multiplayer Browser ACK stalls, inspect the session error, drawing-buffer
size and presentation viewport. `browser-canvas-budget.mjs` bounds App canvases;
Snake also derives its presentation and screenshot size from that shared budget
to bound software Chromium composition. Keep the real network journey and finite
ACK policy. Startup admission waits for App's first completed frame before the
next client, not only the join command. Keep each client's Chromium process
independent: separate contexts still share a GPU process, so one device's startup
can stall another client's frame-driven ACKs. For Pack inventory coverage
timeouts, keep the oversized-cache boundary but use the existing small-input
snapshot owner for mutation checks.
Reuse these owners and the CI guide's disposable-project reducer when fixing
overload instead of introducing another probe or per-consumer patch.
For Dawn import costs, use the builder's prepared JSON serialization through the
shared manifest URL fixture. Do not expand and republish already verified blocks
or replace source validation with a path-only cache. Preserve native isolation;
passing assertions followed by worker termination warnings do not qualify a
shared-module experiment. The CI guide names the retained Browser/Dawn owners
for expensive shared fixtures and the explicit high-quality subsurface control.
For core upload stalls, distinguish CreateArtifact retries from blob transfer.
The CI guide owns the bounded PR upload and source recovery; retain independently
verified shared inputs when only core transport fails. Core transfer maps omit
embedded source text, not JavaScript mappings needed for coverage attribution.
Declarations are built from source without a remote declaration cache.
Lighting-channel Browser files use ordinary bounded batches; the Dawn
shadow-fields owner retains its twelve assertions in three native processes.
For Browser startup stalls, inspect Pack and authored material preparation: explicit groups
use their workspace owners and declared shared source roots, including material
contracts imported through shared test fixtures. Keep the original
deadline and first failure; do not restore whole-group automatic retries.
For core/shared-input stalls, inspect the shared native shader steps in `ci.yml`,
profile fingerprint and portable receipt before comparing cold compilation with
cache reuse. Cache restore/save have one-minute step deadlines; the segment
download timeout does not bound metadata lookup. A cache timeout must still reach
mandatory source/byte verification and source fallback, and must not start another
save request. Shared catalog timing must include the preceding profile preparation;
its explicit shader input is admitted before reuse and rebuilds when missing. The source producer
validates restored bytes and rebuilds misses; do not restore a second local receipt
or skip admission on an Actions cache hit. The CI guide names the retained
single-texture and standalone-manifest coverage owners.
Coverage prepares both base-SSAO and point-SSAO from admitted core/shared products.
If standalone SSAO or Vite manifest assertions recompile the full fleet, inspect
that preparation before changing their assertions. Cold source production and
worker lifecycle retain their focused owners.
SDK package verification owns the default production build; the custom-base
empty-project build retains direct CLI coverage. Do not rebuild the same unchanged
project immediately before packaging it.
For SDK subprocess failures, run `pnpm test:sdk:contracts` before the installed consumers.
For SDK packing, compare the shared archive writer's compression time and bytes;
its deterministic level 6 policy is shared by every npm carrier. Source build
work is serial and uses ordinary process priority inside the Runner's cgroup.
SDK doctor, tests, build and Browser share one disposable consumer copy; its
256-square shadow map retains the authored three cascades. The archive stays unchanged. Installed View retains JS/TS publication and cold reopening;
Game 3D build/input/rendering belongs to SDK Project and its complete Play/restart
journey belongs to Engine/View integration, without a second installed View run.
View Game 3D imports the reducer from the paired Engine checkout.
For its preparation Stop timeout, follow
[Play preparation cancellation](../../scripts/ci/README.md#play-preparation-cancellation).
Retain the real Play gesture, matching request cancellation and original
30-second recovery; a previously observed Preparing label cannot classify a
later adopted Stop. Keep native readiness and cleanup as separate required evidence.
If an adopted Play is hidden before its document arrives, inspect presentation CSS:
Chromium suspends native iframe rAF under `visibility:hidden`. Keep it transparent
and pointer-inert until Engine cleanup acknowledgment; preserve the 120-second
bound and real frame/cleanup assertions.
MCP Host response contracts wait for actual query admission and drain native response events under the existing 500 ms reply bound. Preserve the three blocked queries, four exact successful replies and asynchronous service work when diagnosing timing failures.
For View tail latency, use the per-owner timings from `run-view-integration.mjs`.
Keep four shards and complete JS/TS publication chains; diagnostics and plugin
each own a shard, TS shares contracts/Game 3D, and Engine-only/JS share lifecycle/workspace. Preserve the real
post-profile game-state assertion and failure capture when removing redundant
diagnostic observations. Run the projectless no-WebGPU probe after backend restart,
before any project intent can start another GPU-owning game.
Diagnostics use the shared canvas budget; distinguish CSS layout from drawing
buffer size, and retain a real reallocation across hidden/resumed presentation.
After deliberate View target retirement, assert the lost state and use guarded
workspace reopen before mounting Scene on the new target. Do not navigate the
retired target and try to drain its asynchronous notices before tab clicks.
Select the RHI Debug tab explicitly after reload or service restart; the default
page is Scene. Preserve guarded target identity and the independent-run checks.
For replay device-limit failures, compare the capture and replay browser channels
and adapter limits. View's Linux default follows the shared browser configuration.
For Learn Render observation stalls, measure the complete quiet window with the
monotonic clock and restart it on new errors within the existing five-second
bound. Nine-light uses the existing exclusive Browser admission. Boss Lightning's
baseline/field and SDF commands keep separate Smoke receipt owners. See the
CI guide's Browser and managed VFX sections for these shared boundaries.
Full SDK Candidate consumers wait for source-producing jobs and run sequentially;
retain their full-scene profile window and require a complete seal. An isolated
consumer pass cannot qualify Promotion.
For Candidate seed transport failures before verification, follow the
[SDK consumer guide](../../scripts/ci/README.md#sdk-consumers): reuse the bounded
downloader, keep exact artifact counts and source/byte checks, and qualify a new
complete Candidate. An unsealed failed run is never publication authority.

For an external transport-only failure, rerun failed jobs only. A passing test
prefix, cancelled tail or missing artifact is not success. Compare measured job
time and total runner occupation; queue time is reported separately. Keep new
run evidence in the delivery PR, not appended to this skill.

Multithread frame-p95 comparison is an explicit `bench:production` diagnostic;
ordinary CI retains capability, Worker recovery and raw-kernel speedup in
`shared-inputs-browser`, reusing its setup without changing build dependencies.
GPU timing refusal, null-backend and artifact-validator unit assertions belong
to Render coverage; do not recreate their duplicate standalone job. Keep short
consumer probes out of core/shared, artifact and metrics producers. Use stable
benchmark conditions for end-to-end performance claims. CPU capacity and affinity
alone do not qualify them, and raw-kernel success is narrower evidence.
Copy timestamp envelopes include marker and synchronization overhead. Use the existing
60-frame `gpu-pass-timing-copy.dawn.test.ts` for ordering, bytes, query retirement and
recovery; a larger independent copy need not have a longer envelope. Do not restore
the duplicate copy-size comparison as a correctness gate.
Specular AA keeps its image reference and G-buffer replay falsifier. Do not restore
its deleted repeated cost report, which had no performance threshold. For a Dawn
lane cancellation, compare completed processes and the unfinished tail; an equal
container CPU budget does not establish equal runner speed or a passing estimate.

For managed scene-SDF failures, use the [CI guide](../../scripts/ci/README.md#managed-vfx-scene-sdf)
and its linked real-carrier evidence. Missing Pack indexes or field/program
artifacts belong to app-shard preparation; prepare them before GPU admission.

For SDK dirty-source errors, inspect the named paths. Post-checkout cleanup of
retired submodules belongs only in disposable CI workspaces before preparation;
never clean a contributor checkout or disable source admission. For backend-stop
deadlines, keep the owner log and native disposal trace; a healthy game or complete
replay does not prove retirement. Follow the CI guide's build and recovery routes.
The textures bootstrap retains its existing exclusive short-renderer owner and
original deadlines; an isolated passing run cannot replace complete CI.

For native startup overhead or Preview first-frame timeouts, use the
[CI guide](../../scripts/ci/README.md#failure-recovery). Inspect real frame
resources before reducing a smoke fixture. CI uses bounded native batches and
the shared [test workload](../../scripts/test/render-quality.json) and
[project reducer](../../scripts/test/reduce-test-project.mjs) for ordinary fixtures.
Check captured dimensions when a scene omits quality fields: shared test reduction
must also bound engine defaults. Keep explicit overrides for quality/capacity
owners, complete assertions and the original deadlines.

For native Host failures, follow the CI guide's
[build-input](../../scripts/ci/README.md#cross-platform-host-build-inputs),
[Rapier](../../scripts/ci/README.md#native-rapier-artifact-admission), and
[Codec](../../scripts/ci/README.md#codec-payloads-before-native-factory-builds)
owners. Check explicit Host initialization, the `forgeax-native` condition,
source identity and complete generated inventories before runtime diagnosis.
Preserve retryable initialization and real native tests; never intercept global
WebAssembly to hide a missing Host boundary. Actual simulator/device evidence
remains separate from Node qualification. UI fixtures without external Packs
use explicit Browser source selection while mixed selection retains its closure.
For compact manifest failures, inspect v4 source fragments and resolved receipt
facts; matching numeric indices are not matching ABI values. Frame-based probes
wait for the submitted receipt's completed-frame signal, not animation callbacks.

## English-only guidance gate

Run `python3 scripts/forgeax/check-agent-docs-english.py` after changing agent
instructions. Preserve command/API identifiers and update links when headings
change. Localized ordinary README files remain permitted.

## Symptom index

| Symptom | Likely cause | Reference |
|:--|:--|:--|
| Textured demo shows a white square without texture or lighting gradient | Texture paramValues contain unresolved GUID strings instead of Handles. | [White textures](references/assets-and-ci.md#white-textures) |
| spawn-data-unknown-field or invisible/gray entities | Misspelled/stale data field, such as MeshRenderer.material instead of materials. | [Spawn fields](references/assets-and-ci.md#misspelled-spawn-data-fields) |
| register MaterialAsset reports shader not registered | Stale shader identifier in pack.json. | [Shader identifiers](references/assets-and-ci.md#stale-shader-identifiers) |
| CI fails despite all assertions passing | Unhandled rejection during teardown sets exit 1. | [Exit status](references/assets-and-ci.md#passing-assertions-with-exit-1) |
| Fresh worktree alone fails with ENOENT/unresolved package | Submodule initialization or build missing. | [Worktree setup](references/assets-and-ci.md#fresh-worktree-environment-failures) |
| Texture disappears after warm HMR | vite-plugin-pack DDC loses sourcePath or writes to source tree. | [Pack HMR](references/assets-and-ci.md#vite-plugin-pack-ddc-hot-reload) |
| Windows-only failures or CRLF diffs | Missing LF attributes or path-separator handling. | [Windows](references/assets-and-ci.md#windows-compatibility) |
| Upside-down cubemap | Redundant V-flip in skybox.wgsl. | [Skybox V-flip](references/lighting-and-materials.md#skybox-v-flip) |
| All CSM shadows fully lit despite valid matrices and running cascades | Negative viewZ compared to positive splitPlanes selects the near cascade; distant projections leave the tile and return 1.0. | [CSM depth sign](references/lighting-and-materials.md#csm-shadows-fully-lit) |
| Meshes do not cast shadows although castShadow is enabled | Hand-authored materials omit ShadowCaster and never enter the shadow depth pass. | [ShadowCaster](references/lighting-and-materials.md#missing-directional-shadows-castshadow-and-shadowcaster) |
| Standard material black during cold startup or without IBL | Asynchronous Skylight cubemap is the only ambient source. | [Ambient readiness](references/lighting-and-materials.md#ambient-black-until-ibl-loads) |
| Multi-mesh glTF nodes bind every mesh's materials | Bridge fails to filter by meshIndex. | [glTF materials](references/lighting-and-materials.md#gltf-bridge-mixes-mesh-materials) |
| pbr-skin pipeline fails with missing binding/vertex slot 5 | Skin shader reuses standard PBR layout; JOINTS_0/WEIGHTS_0 are not uploaded. | [Skin pipeline](references/skinning-and-fbx.md#pbr-skin-pipeline-build-fail) |
| Browser skin black but Dawn passes; VBO 768 instead of 1152 bytes | Break in parser, bridge, mesh-loader, render-data, pipeline context, or extraction. | [Attribute chain](references/skinning-and-fbx.md#skin-vertex-attribute-chain) |
| hello-skin dev Fox black with asset-not-imported while smoke passes | Missing build/submodule or sibling using the port. | [Fox dev loading](references/skinning-and-fbx.md#fox-development-loading-asset-not-imported) |
| Skin remains in bind pose while clip/world matrices advance | Palette allocator/dynamic-offset/extract wiring, MAX_JOINTS overflow, or async instantiation before SkinAsset registration. Skin.joints.length=0 and JointCountMismatchError identify the latter; e5e68b35 added SceneAsset.skinGuids and fail-fast skin-asset-unresolved. | [Static skin](references/skinning-and-fbx.md#skin-entity-stays-static) |
| Distorted/flipped FBX skin animation in historical SDK implementation | Removed binding.cc misread Euler degrees as quaternions and sampled one axis; ufbx bridge.c uses ufbx_evaluate_transform. | [Historical FBX deformation](references/skinning-and-fbx.md#historical-fbx-skin-deformation) |
| FBX parity snapshot fails | bridge.c drift in axis conversion, material classification, node filtering, or animation extraction. | [FBX parity](references/skinning-and-fbx.md#fbx-parity-snapshot-differences) |
| FBX WASM ENOENT | Contributor checkout lacks generated pkg payloads. | [FBX WASM](references/skinning-and-fbx.md#missing-fbx-wasm-payload) |
| FBX WASM initializes in browser but fails in Node | ENVIRONMENT flags or Node version mismatch. | [Node WASM](references/skinning-and-fbx.md#fbx-node-wasm-initialization-failure) |
| SkinPaletteOverflowError needs=16384 cap=16320 at first frame | MAX_JOINTS=256 exceeds the pbr-skin group-2 binding-1 capacity established by PR #361. | [Palette overflow](references/skinning-and-fbx.md#skinpaletteoverflowerror-needs-16384-b-exceeds-16320-b) |
| Edge adapter-unavailable and black output | Browser settings disable hardware GL. | [Edge configuration](references/backends-and-ci.md#edge-webgpu-disabled) |
| Startup/release reports only WebGPU, adapter-unavailable, or object Object | Flattened diagnostics or only one backend channel observed; insufficient to declare the machine unsupported. | [Capability diagnosis](references/backends-and-ci.md#webgpu-messages-do-not-decide-whole-machine-support) |
| WebGL2 fallback validation panic: storage/uniform mismatch or VIEW_FORMATS | Missing capability gates in variant keys, graph viewFormats, or texture reinterpretation. | [Fallback gates](references/backends-and-ci.md#wgpu-wasm-webgl2-fallback-cap-gates) |
| WebKit reports mesh SSBO ceiling 0 B and black scene | Downlevel defaults report maxStorageBufferBindingSize=0, incorrectly consumed as a real ceiling. | [SSBO ceiling](references/webkit-and-lifetimes.md#webkit-mesh-ssbo-ceiling-0) |
| WebKit black/GPU loss after submit without onError | wgpu error-sink failures never reach JS. | [Submit errors](references/webkit-and-lifetimes.md#webkit-black-output-after-submit) |
| WebKit probe panics Surface does not exist while hello-triangle works | Probe main returns after a finite loop without retaining Renderer; GC finalizes the WASM Surface. | [Probe lifetime](references/webkit-and-lifetimes.md#webkit-probe-renderer-gc-finalize) |
| CI job, cache or skip behavior differs from old troubleshooting notes | Workflow layout has changed; verify the failing commit before applying historical advice | [CI operating guide](../../scripts/ci/README.md) |
| GPU buffer/texture/cubemap counts grow throughout long sessions | Missing symmetric release in store eviction, instance buffers, transient resize, or handle-keyed WeakMaps. | [Resource growth](references/webkit-and-lifetimes.md#monotonic-gpu-resource-growth) |

Open the relevant linked recipe; verify its hypothesis against the current
failing frame or process. Package contracts remain the design authority.

For `release-source-not-on-main` or `release-source-not-on-stable` after a successful resolve step, follow [shallow release ancestry](../../scripts/ci/README.md#release-source-ancestry-from-shallow-checkouts). Compare complete branch history before assigning source drift; the release-policy owner must fetch sufficient history and still reject outsiders. Keep the sealed Candidate bytes and all publication guards.

For explicit Dawn preparation on a shared host, set `CMAKE_BUILD_PARALLEL_LEVEL=1` to cap native compilation without changing the pinned source, device lease or gate budgets; see the Dawn carrier contract.

For green MCP checks with a black Scene or fatal Play screenshot, follow the
[consumer acceptance gate](../../scripts/ci/README.md#optional-mcp-app-consumer).
Inspect the real screenshots, visible native fatal details and console errors;
old completed-frame counters and an empty `pageerror` array are insufficient.
Preserve the failing frame through RHI Debug. For local Vite cold-start delay,
check and prepare the packaged shader inputs after the last package build before
retrying the original browser deadline.

For a minimum-limit WebGPU PBR `pbr-view-bgl` binding mismatch, retain the first
native validation message before its invalid-bundle/submit cascades. Compare the
selected cooked program context with the actual View topology; storage buffers
do not imply the extended sampled-texture budget. Re-cook obsolete publications
through the Shader compiler owner, then verify the same browser and pixels.

For a required Runtime Pack plugin stuck in dependency retention, compare the same
publication through native HTTP and the actual MCP iframe bridge. Preserve the
first blocked stage and cancellation cause. Inspect resource sizes, MIME-independent
wire compression and chunk counts before changing startup deadlines. A fast native
read is an isolation control, not an MCP or GPU acceptance pass.
For incompressible resources, verify the broker's 192 KiB window and the shared
document/Worker/Node decoder: stride comes from the first actual chunk, with at
most four reads in flight. Preserve full byte comparisons and response/cache
bounds; rerun the nested consumer under the maintained runner CPU affinity.
When raw artifact-cache misses repeat already installed material reads, inspect
the existing material artifact owner before adding another cache or shrinking
the publication. Capture may borrow its bytes by the frozen artifact digest,
but must still verify the complete publication and reject altered bytes.

For an embedded Runtime Pack failure mentioning CacheStorage or ServiceWorker,
read the structured game-operation error and inspect the native frontend's
borrowed PackProgramHost capability. Preserve the sandbox and the executing
Engine namespace identities. Reuse the real template interaction/recovery probe;
frames and a healthy startup barrier do not prove the operation succeeded.

For an MCP renderer crash during Runtime Pack module import, preserve CDP crash
evidence and native browser stderr. Check `runtime-import.mjs` before attributing
heap growth to assets: remote compilation must not rewrite the adapter's captured
native importer into itself. Local UI generation must use ordinary button events
with native input validation; opaque documents have no form-navigation permission.

For a first Host timeout with a restoring-project header, inspect the recorded
`nativeViewConnected` value. Test native transport connection within 60 seconds;
project restoration shares the first Editor's 180-second frame deadline. Do not
measure the two owners through one temporarily overridden header label.
