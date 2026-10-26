# Engine contributor reference

> Read only the section needed for the current task. This reference is not an automatic instruction import. Keep new package details in the owning README; the root AGENTS.md stays concise.

Material resource previews optionally expose App's native
`engine.preview.material.get/set/rotate/reset`. Their Fiber owns generated
primitive geometry and object rotation, restoring borrowed bindings on removal.
Consumers own mouse mappings; camera pan/dolly use existing camera transactions.
Authored materials, canonical thumbnails and games retain their current owners.
See App/DevKit READMEs and the paired View material preview design.

AI-first TypeScript game engine. Target: surpass Three.js. **AI is the primary user** — when AI-friendly conflicts with human-friendly, AI wins. See the [AI-first contract below](#design-axiom--compression--intelligence); the current closed-loop skill is supplied by the checkout's `.agents/skills/forgeax-closed-loop/SKILL.md` mount.

## Public SDK source mode

When `.forgeax-public-distribution` exists, this checkout is the source surface of a
public SDK archive: no `.gitmodules` or private asset submodule, `pnpm build:engine`
is the source-build gate, and `bun fx setup` skips all submodule operations. Checked
WASM payloads live under package `pkg/` directories, and the pinned wgpu source is
expanded under `third_party/wgpu/` for native Rust rebuilds (see
[`third_party/README.md`](../../third_party/README.md)). Asset-heavy demo and browser
fixtures stay contributor-only and must never become a hidden dependency of the
public build; use a public project asset or the Preview canonical fallback.
Contributor-only worktree, asset, and submodule notes below do not apply here.

## Design axiom — compression == intelligence

> [!IMPORTANT]
> **Metric: concepts a reader holds to follow any single piece — not LoC.** Judge every diff by Δ-concept-count. A phantom field / overload / wrapper generic / ledger is a loss even when tests pass; a removed duplicate / SSOT-collapse / union-shrink is a win even when LoC grows. Mechanism: remove one reader question per principle (SSOT "which copy?", Derive "in sync?", closed unions "other states?").

**Human awkwardness is the anti-entropy signal AI cannot self-generate** (AI defaults to **add** over **remove**). When a human sweep yields "this is awkward / does this duplicate something", surface it **as a question, not a prescription**; let AI re-derive. Batch signals. (PR #370, #376.) §Change stance · §Error model · §Component naming apply this to API / failures / types.

Repository-family routing SSOT: `.agents/rules/delivery-workflow-routing.md`. Intake gate (task-shape routing + Direct-edit signals) SSOT `.agents/skills/forgeax-closed-loop/SKILL.md` §Intake gate. Direct edit must run relevant gates (typecheck / unit / lint / smoke) before commit.

View Pack parameter work follows [the asset authoring recipe](../../skills/forgeax-engine-assets/SKILL.md#view-pack-parameters). Start from the selected project's Pack/Inspector context and the Engine serving that View; `asset inspect <file.pack.ts> --parameters-only --json` checks declarations without running generation. Use the implemented contract and actual preview results to establish support.

### Rendering diagnosis: RHI Debug first

> [!IMPORTANT]
> For difficult or unexplained rendering failures (black/missing output, wrong
> lighting or shadows, flicker, browser/backend divergence), start with
> [`forgeax-engine-rhi-debug`](../../skills/forgeax-engine-rhi-debug/SKILL.md): capture the
> real failing frame, inspect its work items and resources, then fix the owner the
> evidence identifies — before speculative shader/material edits.

A concrete startup, asset, or schema error goes directly to its named owner. If
capture is unavailable, keep the structured failure and follow the skill's recovery
path; missing evidence is never a rendering pass.

### CPU diagnostics without a GPU: WebGPU stub

> [!IMPORTANT]
> On a host without a usable GPU (or to remove GPU cost on one), observe CPU-side
> Engine/game cost with the WebGPU stub: `?forgeax-gpu-stub=1` in generated hosts,
> `createApp({ gpuStub: profile })` in custom hosts. It keeps `rhi-webgpu`,
> `backendKind: 'webgpu'`, the profiled caps and the Worker topology, and installs
> in every App realm. Do not substitute software WebGPU (SwiftShader /
> `--enable-unsafe-webgpu` adapters), which spends CPU emulating the GPU, or
> `rhi-null`, which changes backend kind, caps and render branches.

- Missing: GPU execution, browser WebGPU/Dawn validation and IPC, readback contents
  (zero-filled), GPU back-pressure. Results are CPU attribution and same-host A/B
  only; never pixel, GPU-time, FPS or cross-machine acceptance evidence.
- Details: [`packages/rhi-webgpu/README.md`](../../packages/rhi-webgpu/README.md#webgpu-stub)
  and the [performance skill](../../skills/forgeax-engine-performance/references/measurement.md#cpu-only-measurement-with-the-webgpu-stub).

### Bug-fix stability loop

> [!TIP]
> Reproduce before fixing whenever practical. A reproducible bug is a stability asset:
> encode it as the smallest regression gate on the same path, confirm it is red, fix the
> owning subsystem, and keep iterating until every relevant gate is green.

- The gate must exercise the same engine or user-visible path when feasible; never replace a
  runtime, browser, Dawn, or smoke failure with a weaker mock to get green.
- A red reproducer is a checkpoint, not a finished change. For engine, RHI, and `hello-*`
  changes, follow the Smoke gate below.
- If reproduction is blocked by an external dependency or environment, preserve the evidence,
  state the blocker, and add the strongest deterministic unit/contract test for the invariant.
- Ship the regression test with the fix in the same change.
- A blocked required check stays unverified. Diagnose its owner and attempt supported
  recovery or an available equivalent observation path. If it remains blocked, report
  the exact failure, attempted remedies, passed checks and missing evidence to the user;
  never report completion or an all-clear from a weaker green aggregate.

### Dependency vulnerability remediation

> [!IMPORTANT]
> A scanner path under `node_modules`, `.bun`, a quarantine directory, or a build output identifies an installed artifact and its observed package version; it is not the source fix location. Trace that instance through the containing package, workspace importer, manifests, lockfiles, and published package source. Correct the owning dependency declaration or version policy and regenerate the affected lockfiles. For cross-repository findings, inspect Engine, View, Voxel, voxel-game, and extension manifests and lockfiles, then change only repositories with a proven dependency or publication path. Verify the fixed version from a fresh consumer install rather than a pre-existing `node_modules` tree.

### Runner container targeting

> [!IMPORTANT]
> `skills/forgeax-github-runner/runner-inventory.md` lists the runner target environments. When the user identifies a listed environment as the container, inspect that environment itself. Use the complete SSH command supplied by the user as the current user/host/port tuple; do not connect to the listed container and search for another container unless live evidence shows nested containerization.

### Chromium sandboxing

> [!IMPORTANT]
> Every Playwright Chromium launch in CI, tests, and verification scripts must set
> `chromiumSandbox: true`. Playwright defaults this option to `false`, which
> launches with `--no-sandbox`. Do not pass `--no-sandbox`,
> `--disable-setuid-sandbox`, or `--single-process`, including for headless or
> WebGPU probes. Run as an unprivileged user with usable user namespaces or a
> trusted Chrome sandbox helper; repair runner setup when sandboxing is unavailable.

### Smoke gate

Basic source initialization, `pnpm build:engine` and `pnpm test` do not compile
or load Dawn and require no Dawn native toolchain. Dawn GPU tests are opt-in for
local developers: prepare the carrier with
`pnpm --filter @forgeax/engine-dawn-node build:native`, then run `pnpm test:dawn`.
The complete rendering acceptance below remains a maintainer/CI delivery gate;
it is not a prerequisite for a developer's basic initialization or CPU tests.

Engine / RHI / hello-* changes must pass the maintained core hello-* / learn-render dawn-node smokes (60 frames) + `pnpm test:browser` + `pnpm test:dawn`. Core roster: `scripts/ci/dawn-smoke-roster.json`. Per-demo criteria (structural-only vs pixel readback ε≤0.05, FALSIFY): `packages/runtime/README.md` §structural-only smoke. Main red ≥24h → `post-merge-monitor`.

PR, push and local acceptance all use **60 completed frames**; longer soaks are opt-in
diagnostics, not a delivery gate. Preserve real backends, core lifecycle transitions,
pixel thresholds and falsifiers. Redundant tutorial and cross-backend fixture
executions may be removed when their core owner remains.

> [!IMPORTANT]
> **dawn-node smoke is necessary-but-not-sufficient** — it skips the dev-server pack path (`JSON.stringify → fetch → JSON.parse`) AND WebGPU validation. Browser-path-only bugs (typed-array survival, BGL shape mismatch, vertex-attr presence) need a Playwright e2e probe (`apps/hello/skin/scripts/smoke-browser.mjs`).

### CI efficiency and recovery

Keep approximately **80% core validation** (user direction, 2026-10-11), removing
duplicate journeys, obsolete checks and scheduling machinery. Every matrix has
at most **four actual jobs**, including platform entries (user direction, 2026-10-11);
limiting concurrency alone does not satisfy this bound. Reduce both test
work and total runner occupation; target a **30-minute** execution path with
queueing reported separately. Keep retained 60-frame smokes, real backends,
coverage thresholds and unique lifecycle/pixel falsifiers.
Reproduce failures locally, iterate with `pnpm ci:focus`, then run complete CI on the final
PR commit; diagnostics never replace required evidence and missing build artifacts rebuild
from source. Details live in [the CI operating guide](../../scripts/ci/README.md); diagnose via
[forgeax-engine-debug](../../skills/forgeax-engine-debug/SKILL.md), runners via
`forgeax-github-runner`. CI command/scheduling changes update that guide and skill routes in
the same change; label estimates separately from measurements.

Generated performance evidence belongs in `packages/<owner>/reports/` or the floating
harness. The root `docs/**` surface is retired. Before committing, run the existing
[staged-tree policy gate](../../scripts/ci/check-root-docs.mjs) with
`node scripts/ci/check-root-docs.mjs`.

## Change stance

> [!IMPORTANT]
> **Optimal > compatible.** Take the breaking change when the new surface is clearly better. No deprecation windows, shim packages, `v1/v2` dual-paths, or renamed-export compat — migrate in one cut.

- Rename / delete / reorder / narrow / pivot freely. "Painful to migrate" is not a veto; "the new shape is worse or equal" is
- Exception: external wire protocols with known consumers (published npm APIs, JSON-RPC inspector codes) — `*ErrorCode` unions add-only minor / free-form major
- **Demo failures route to engine fixes, not workarounds.** A demo that can't render the obvious thing surfaces a real engine gap — fix it; a demo-side workaround (1×1 stand-in, manual rAF, ad-hoc fetch) freezes it
- **`OOS-*` is a classifier, not a commitment** — out-of-scope tags reflect what a prior feat deferred; re-pick the optimal solution per feat

## Packages

Game authors install `@forgeax/engine`. Its root is the runtime surface, focused capabilities use `@forgeax/engine/<package-directory>`, and its `forgeax` bin is the single CLI. The `@forgeax/engine-*` packages remain physical owners. Official npm delivery bundles those owners (plus patched dependencies) into one `@forgeax/engine` tarball and declares registry dependencies at exact versions; focused packages are not separate publication units. Release channels and hotfix handling are defined in [`packages/engine/RELEASING.md`](../../packages/engine/RELEASING.md).

- **Directory naming** — suffix after `@forgeax/engine-` (`packages/runtime/` ↔ `@forgeax/engine-runtime`); `packages/engine/` is the umbrella + CLI facade.
- **Per-package contracts** — `packages/<pkg>/README.md` (until they gain one, `physics-rapier2d`, `physics-rapier3d`, `vite-plugin-rhi-debug` use manifest/source).
- **Task → skill routing** — `rules/forgeax-engine-usage.md` maps task shape to one focused `forgeax-engine-*` skill; project authoring tools and live-instance CLI inspection are separate routes

Entry `createRenderer(canvas, ...)`.

## Module design map — cognitive injection

This is the package-by-package change-time map: it answers **which boundary owns a concern and which invariant must survive a change**. Each named `packages/<pkg>/README.md` is still the detailed API/error/capability contract; do not infer an API from this map.

### World and host contract

| Package | Core design idea / invariant |
|---|---|
| `engine` | User-facing runtime and CLI: root forwards the runtime entry, generated subpaths forward focused exports, and the CLI delegates to DevKit. One npm tarball carries every Engine owner and exact registry dependency declarations while independent ESM modules and physical owners preserve code and browser bundle boundaries. The complementary SDK adds editable source and its private built View tool; Engine and SDK are the two npm publication units. |
| `types` | Shared WGSL scalar/vector byte layouts feed material, GPU Scene and VFX projections while each owner retains its vocabulary and struct padding. The main entry is the cross-package POD vocabulary: closed unions, `Result`, and phantom brands with no runtime constants or duplicated platform values. Its explicit Node-only `inspector-client` subpath owns the shared JSON-RPC wire client. |
| `math` | Pure, out-parameter-first, SoA-friendly transforms over branded `Float32Array`; allocation and semantic type safety are explicit rather than hidden in objects. |
| `ecs` | Schema-defined archetype World is the game-state and time authority. Token-scoped `Update`/`FixedUpdate` systems make mutation and scheduling explicit, and a domain (the renderer) runs its own `defineSchedule` phases with `world.run` on a separate World without advancing time; a same-token ordering reference brackets each execution, including every catch-up tick; `createWorldContext` adapts reversible contributions into one Cordis realm, and `World.components` leases plugin component vocabulary per World. World owns non-asset managed payload identity and generation-checked reads; asset fields validate and lease identities from the injected runtime asset owner, without another payload catalogue. Queries keep independent observation cursors and incrementally match only their dense-table or sparse-archetype storage route. World-owned mutable epoch indices identify changed entities without clean table/block discovery; steady writes allocate in proportion to changes. Derived numeric writes fence source observation until publication; unexpected partial writes poison the World, and physical mirror migrations re-resolve the source row before writeback. `QuerySpan` kernels add bounded data parallelism; structural work stays serial and partial-write failure poisons the World. |
| `path` | Ordinary SceneAsset controls and instance-local entity bindings prepare shared immutable world-space arc/frame tables. FixedUpdate followers own independent signed distance; Scene owns local TRS writes and physics motors consume transient desired poses. Pack/GUID, World time and native Cordis lifecycle remain authoritative. |
| `navigation` | Immutable graph/grid queries retain bounded optimal A*. Explicit NavMesh POD queries stay fixed; the NavigationCharacter companion holds one managed asset and adopts its current version at actual query or fixed-step boundaries. Changed content prepares one bounded BVH/graph; routes compare asset identity/revision during existing motor work, without asset or character propagation scans. The companion derives capsule dimensions from Scene/Collider, calls the existing PhysicsWorld once per fixed step, and advances from actual motion. Local point following excludes CharacterController entities; build-time Recast stays with Import. |
| `net` | Realm-neutral replication/session owner: `NetSession` owns logical `SessionId`, bounded concurrent endpoint admission (including unannounced peers), bounded ACK/retry/recovery with polling-driven per-peer retry and retirement (ACK exhaustion is transport loss for existing bounded recovery; protocol rejection remains terminal), protocol-v2 baseline/delta lifecycle, opaque application bytes admitted by the current peer/session/epoch after baseline acceptance, receiver-local visibility/signatures/ACK bounds and retirement; consumers never own socket reconnect or transport `PeerId` policy. |
| `state` | A typed state machine owns state-scoped entity lifecycle inside one World; one token resource owns current, previous and pending values, and request identity preserves callback-enqueued transitions. State transitions are scheduled ECS work, not a parallel object graph. |
| `platform` | Realm-neutral native clock, frame callback, display and lifecycle leases. App owns pacing and World owns game time; callbacks never imply GPU completion. |
| `platform-browser` | Concrete browser Window/canvas binding with native timing, CSS safe area and lifecycle cleanup; borrowed canvas identity remains native. |
| `platform-wechat` | Concrete Mini Game host binding with native operations, lifecycle leases, InputBackend touch acquisition, task-local binary NetEndpoint transport and lazy native audio reusing WebAudio graph ownership. Window resize and orientation share one validated native display projection. Packaged/remote PackageFetcher adapters feed the existing Catalog; bounded persistent bytes remain a disposable publication projection. Device qualification and domain policies stay with their owners. |
| `app` | App is the host and execution assembly seam: it owns one native Cordis Context per realm, composes Engine, Render, and shared Kernel Workers through independent policies that default to auto, owns bounded frame pacing with one retained overdue native tick and capability/report/rebuild control, applies the startup deadline to the first source frame before the steady admission deadline takes over, and keeps DOM input plus Web Audio on the Host without making World browser-aware. Two occupied source-to-GPU publication slots block the next World update; successful current-generation completion and buffer recycle release capacity, while submission alone does not. Source admission rechecks current Render Worker readiness and publication capacity together after every asynchronous wait, before advancing the World. GameHost exposes the current drawing-buffer input extent independently of canvas ownership; Engine Workers consume the dimensions in the accepted input frame before World update, without a parallel display transport or World resource. Host-owned physical Kernel Workers are siblings of the Engine Worker; its lazy pool dispatches POD through lane ports and retains World scheduling and atomic joins, while the Host retires native lanes on disposal or failure. Declared geometry rosters prepare through shared bounded mesh credits across Workers; existing in-flight preparations and release fences govern progress, while synchronous source admission stays atomic. Completed mesh-consumption evidence groups exact request and handle facts by entity without retaining a second publication history. An execution Host audio factory replaces the existing consumer per generation for native effect assembly; generated Worker Hosts project its borrowed current engine and resolve a synchronous native frontend factory on rebuild, without delaying App startup for frontend activation. Native audio is never Worker data. Browser debug capture is published only after App assembly binds its frame driver, so initial resource uploads cannot overlap a bare recorder snapshot. |
| `input` | One frame-start scan freezes a normalized `InputSnapshot`; systems consume snapshot/action semantics instead of acquiring DOM events independently. `CanvasInputBoundary` routes one producer through exclusive `preview` and `game` consumers without naming a UI mode. Its bounded POD gamepad feedback producer targets scan-derived attachment/connection identities; the Host input owner arbitrates native actuators and async results. |
| `plugin` | Exact-pinned Cordis 4.0.4 re-export with the workspace patch for async disposer ownership and structured error causes, Context service augmentation, deferred asset mount and external native startup observation. Pack definitions map to actual native Fibers; no Engine Group, Entry tree or parallel lifecycle. |
| `host` | Business-neutral native Cordis host pair. Protocol-v2 revisioned root projection and sessionGeneration control activation, capability transport, cancellation and disconnect; domain owners provide compiled resolution. FrontendPlatform owns realm capabilities and isolated document handles; its ordinary browser factory omits document navigation, which workspace consumers select explicitly, so standalone game builds retain no development-host navigation implementation; consumers own disposal, while panel placement only borrows the element. |
| `dsh` | Engine ↔ DeepSeek Harness federation connector: each side keeps its native Context/Fiber tree, bridge messages are versioned POD, attach owns only a lease, launch only its child instance. |
| `intelligence` | Optional provider-neutral Activity/Session boundary: bounded input, ordered polled POD output, cancellation and structured terminal failure keep async intelligence outside the ECS frame and World/Renderer authority. |
| `project` | Strict schema-v3 forge.json identity, plugin roots, authored `assetRoots` (default `assets`) and explicit read-only `assetLibraries` package specifiers. DevKit discovery and workspace metadata derive from those configured directories; libraries mount assets only, under `<specifier>/<path>` Catalog identities. Each build/host/frontend/engine root references one plugin asset GUID; configuration belongs to Pack and composition to native plugin code. |
| `devkit` | Node-only external-project CLI and build owner. Its optional FrontendPlatform augmentation borrows PackProgramHost factories and actual Engine module namespaces for embedded document realms; Host remains independent of Pack. Compiles plugin program tables and publication inventory, runs native build roots in isolated processes, projects their closed data-only `devkitAppOptions` service into generated hosts before App creation with Render-owned budget/profile validation and configures Worker-owned Renderers through the existing bootstrap hook, prepares source closure transfers and complete project delivery; generated games declare native VFX in each execution realm and attach its existing runtime through the World plugin lifetime; generated browser preparation, Hosts, App and Engine root activation derive one startup budget from project facts and the environment; admits frontend sources against the selected Host Engine byte identity and owns SDK tool inputs, never parallel plugin state. Plugin compilation follows declaration membership, compiler-resolved closures and configuration in one Pack snapshot; native filesystem readers retain conservative source admission. Live input observation derives from the accepted compiler scope and asset membership, without making external host state an Engine directory contract. |
| `tool-runtime` | Focused realm-neutral AI tool contract: descriptor/executor contributions, typed closed failures, lexical ToolRun terminal, snapshot/artifact refs, and operation timing. Provider retirement owns the executor-exit completion shared by revoke and API disposal. DevKit adapts it; it owns no filesystem, renderer, Editor, or second registry. |

Resource previews capture typed mesh/texture/material facts from their retained
assetBinding publication. Exact-target `preview.display.get/set` delegates to
the optional native mesh display Fiber in its per-preview isolated service
scope, which owns temporary wireframe, actual
cooked-collision and bounds geometry and restores borrowed bindings on removal.
Its optional `preview.display.get` UV channel query reads the exact bound mesh
and publication, returning real channel indices and on-demand base-LOD UV/index
data with an 8 MiB JSON limit. View owns the read-only overlay, framing and input;
it never unwraps assets or infers missing UV channels.
View owns menus, defaults and asset-specific statistics placement; this capability
does not write assets or install presentation policy on games or independent runs.
See `packages/app/README.md` and View Harness's 2026-10-15 asset statistics design.

Workspace target inspection optionally returns bounded asset-reference facts
from its realm's existing World and Registry, including held mesh defaults and
instance overrides. Consumers own primary-asset and navigation policy. Exact
asset-open results retain the returned owner and binding; retirement removes that
owner only after native cleanup succeeds and remains retryable on failure.
Saved Pack changes publish a new Catalog even when an authoring draft suppresses
its preview restart. Explicit Scene reopening adopts a changed saved publication
before instantiating retained runtime assets and capturing its binding.
DevKit resource previews use a contrasting opaque camera backdrop for meshes
whose slots all use Engine defaults, retaining canonical lighting and explicit
transparent output. Scene and game rendering keep their existing owners.
See `packages/app/README.md`, `packages/devkit/README.md` and View Harness's
2026-10-19 native asset inspection design and evidence.

DevKit's public CLI/SDK command client retains project-scoped operation receipts
without View. Existing ToolTerminal outcomes and artifact digests remain the
execution authority; Node-owned history stores bounded diagnostics and verified
PNG copies, publishes records atomically and exposes `engine.history.*` reads.
The optional View history plugin observes them without replaying commands or
starting a game; internal frame/transport activity creates no duplicate history.

Workspace tools query actual Worlds through ECS/Scene and compose existing
observation/input capabilities; panel labels, selection, clicks and navigation
preferences stay in the consuming UI, and World/App/Renderer stay free of Editor/Play
modes. Public operation IDs derive CLI paths and MCP names through ToolRuntime; the resident Host exposes callable owner descriptors for CLI discovery without plugin activation. DevKit `backend start` owns a browser-free workspace Host (it opens no project;
stopping a UI stops neither Host nor runs); a presentation plugin may provide
`devkitWorkspaceFrontend`, sampled on explicit project open. `target.pick` is an ordinary
query over the canvas-owned submitted frame — no parallel picked/error channel.
Synchronous queries of an existing target remain available during independent preview
initialization; lifecycle changes and writes retain their accepted order, and browser
disposal drains all accepted commands through result delivery.
Healthy browser refresh retains the project/session/target and accepted Catalog; DevKit fences replacement readiness behind actual preview/Play retirement, directs commands to the accepted connection, and advances browserGeneration once per browser realm. Guarded
`project.open` recovery validates the exact lost target, mints a new identity, and never
replays writes. A headed target samples a presentation lease on explicit project open; retirement of that native service marks the exact target lost for guarded recovery and leaves independent runs with their owner. Host workspace assembly resolves trusted frontend callers and explicit targets to independent ordinary single-project runtimes. A fresh View document opens its own target; healthy reload retains that session and only advances its browser generation. CLI workspace ownership stays independent, and one document's replacement never retires another session. Workspace camera pose math and continuous movement remain Engine-owned; a canvas-local presentation may lend the same public target operations to a native frontend, whose frame sampling carries semantic input without a second camera authority. The game document owns observer gestures over the canvas area, including DOM UI overlays; player input keeps its existing owner. The Engine workspace catalog owner provides bounded `assets.search` pages over its existing asset projection; View provides a separate bounded `summary.get` for project and target identities without serializing the UI snapshot or catalog. An adopted Play retains its server and presentation through initial readiness before Stop requests native cleanup; parent refresh retires the discarded child without waiting for readiness, and unpublished preparation still cancels directly. Generated document entry imports never wait for animation callbacks. The presentation retains native iframe frame scheduling until cleanup acknowledgment: an unselected Play is transparent and pointer-inert, since CSS visibility can suspend startup callbacks. When changing these ownership, query, assembly or lifecycle boundaries, update this consensus and the affected
package contracts in the same change.

### GPU abstraction and implementations

| Package | Core design idea / invariant |
|---|---|
| `rhi` | A math-free, spec-aligned, opaque-handle interface. Capability absence is data, not an exception; high-level code depends on this seam, never a backend kind. Borrowed same-device native textures and frame-scoped external video textures are capability-gated device imports that never transfer ownership. |
| `rhi-webgpu` | Browser-native WebGPU adapter preserving RHI shape and opaque handles. One physical-device pipeline library interns exact shader/layout/pipeline recipes, coalesces asynchronous completion, and exports the reachable recipe graph for startup preparation; renderer feature policy stays above this owner. Its opt-in WebGPU stub (`installWebGpuStub`) replaces a realm's `navigator.gpu` with a no-op `GPU` reporting a captured adapter profile, so the ordinary WebGPU path runs without GPU work for CPU diagnostics. |
| `rhi-wgpu` | Thin TypeScript shell over the wgpu WASM substrate; it provides the same RHI vocabulary while isolating Rust binding details. Native builds require an explicit Host initializer through the same module cache and exclude browser WASM loading; device resolution limits derive from the actual adapter. |
| `rhi-wgpu-native` | Native-wgpu owner. For desktop hosts, one crate keeps native device/surface lifetime, capability probes, the bounded Ray Query spike and opaque scene reference transport, so raw wgpu never leaks into Tauri apps. For Node, an opt-in synchronous napi addon exposes a W3C-shaped GPU and native window/Surface through the existing rhi-webgpu shim. The Host owns window lifetime, observed dimensions and resize requests; Surface capabilities drive composition, while the ordinary TypeScript World/Renderer owns commands, accepted submission and GPU completion. Presented images expire, device retirement releases their contexts, and recovery uses the same Renderer contract. An external same-process GUI host lends an opaque drawable and retains it until Surface retirement; RHI keeps the sole Surface/device path. The separate contributor Tauri/Wry fixture qualifies native TypeScript rendering and HTML/CSS interaction in one Linux window. Packaged native games remain unqualified. The addon is never a default-build dependency, ships no committed binary, and a missing addon yields `adapter-unavailable`. |
| `dawn-node` | Optional Node GPU test/replay carrier imported as `@forgeax/engine-dawn-node`. Installation and ordinary builds never compile it; `build:native` explicitly builds pinned official source with the Metal empty-compute timestamp correction on macOS or DXC and its digest-checked DLL closure on Windows x64. Linux retains the exact upstream provider as an optional peer that consumers opt into. Generated binaries are not committed, and original timestamp/60-frame/browser/Dawn gates remain maintainer/CI acceptance authorities. |
| `rhi-null` | A headless no-op RHI with structural bookkeeping for deterministic unit tests; it is a real backend boundary, not a test mock leaked into production code. It changes `backendKind` and caps, so it is never a performance proxy; use the WebGPU stub for that. |
| `net-websocket` | Browser WebSocket connection and Node ws listener implement the NetEndpoint contract; real-socket lifecycle, independent peer disconnect with no post-terminal messages, and binary frames without replication/profile/codec knowledge. |
| `wgpu-wasm` | The merged Rust `wgpu` + `naga` raw-binding substrate is intentionally below AI-facing packages; only its narrow RHI/shader shells expose it. |

### Rendering and shader construction

| Package | Core design idea / invariant |
|---|---|
| `three` | Experimental pinned Three CPU facade projects supported author objects into one ordinary World. Scene owns transforms, Render owns assets and submissions, and RHI Debug owns capture. Package builds cook native Unlit, Standard and Physical programs; Runtime host assembly admits them through the existing material loader and AssetRegistry before rendering. Its Forward graph contribution keeps native lighting and scene work, blends linear material output and applies camera output encoding once. Texture versions admit uploads through ordinary asset publications; loader failures retain a renderable placeholder or prior content, and update callbacks follow successful native submission. Authored shadow cameras and manual update requests project to Render-owned shadow resources. Runtime edits change values without a player compiler. Unsupported Three rendering behavior fails explicitly; feature parity never implies API or pixel compatibility. |
| `runtime` | Concrete renderer assembly: backend/service selection, factory invocation, lifecycle cleanup, and the bridge into extracted SoA frame data. Domain contracts live in focused scene/skinning/animation/render packages. |
| `render-graph` | Passes declare reads/writes and execution; the graph owns resource lifetime (including fence-released texture leases), validation, and barriers; caller-owned TLASes are imported with copy-pass builds and `caps.rayQuery`-gated reads. Pass-local view extents derive from compiled allocation and mip facts. RHI-pure; never imports runtime/ECS policy. |
| `scene` | Schema-checked author values and complete instance-local entity binding precede spawning. Scene identity, hierarchy, and world-transform propagation; Scene captures opted-in local TRS at each fixed boundary and supplies one presentation matrix to cameras and Render while GlobalTransform.world remains exact simulation state; owns `Transform`, `ChildOf`, `Children`, `Name`, `Mobility`, and `scenePlugin`. `Mobility` (absent = movable) is the author's motion commitment for rendering/baking, never derived from or into physics `RigidBody`; its closed diagnostic union and once-per-entity channel live here, while detection sits with the owner that sees both sides (scene: static moved, render: stationary mesh, physics: body conflict). |
| `skinning` | Renderer-independent `Skin` binding and joint-path resolution with a closed skinning error union. One pure four-influence CPU vertex kernel owns weighted XYZW; Picking and Render retain their output precision, projection and pose lifetimes. |
| `animation` | TypeScript-first control through existing PluginAsset-installed Update systems; an FSM is optional game-code specialization, never an animation-native DSL or required controller asset. Animation graph definition/evaluation, clip lookup, ordered bounded POD timeline effects and loop-safe rigid root-motion extraction, `AnimationPlayer`, explicit object/component property tracks, compiled 1D/explicit-triangle 2D weight solvers, reusable target masks, and playback systems; ordinary TypeScript systems own control and phase; compiled IK with reference-axis angular bounds, bounded Spline IK over the Path distance-table owner, and reference-pose retargeting read current Scene TRS and write local Transform without owning Skin or Renderer; offline retargeting reuses that transfer and the playback sampler to return an ordinary AnimationClip without mutating the World; managed fixed-step spring chains and independent physical bone bodies consume the same sampled pose, commit disjoint local writers, and retain ordinary Scene/Skin ownership; a pure import-time TRS enclosure kernel gives glTF/FBX producers conservative animated bounds without making runtime playback own import policy. |
| `render` | Skylight owns independent constant diffuse irradiance alongside image-based radiance; one native environment payload carries it through Forward/Deferred and reflection-probe selection. Standard local-light membership retains the same 96-byte records and complete CPU membership through storage buffers or a capability-selected `rgba32uint` texture. PointLight owns a finite non-negative distance decay exponent (default 2); its existing light slot carries the same fact through surface/capture/volume/ray consumers, and selected-volume history includes it. Surface direct-light channels belong to light/MeshRenderer author facts and the accepted scene projection; one integer matching predicate feeds Standard Forward/Deferred and captures, while independent shadow casting and GI/environment/volume lighting retain their policies. Camera projectionOffset is the common two-axis lens input for ordinary and stereo cameras, culling, capture and temporal consumers. CameraView composes independently culled camera graphs with private depth, post-processing and temporal history, shared asset residency, and one Renderer submission. A single Renderer feature host extracts and plans the full view roster once; scoped frame work owns shared simulation, scoped view work owns projection, and one outer transaction commits histories and source acknowledgment. Material programs explicitly declare binding interfaces and logical depth versions; Cook validates reflection and publishes the ABI, while Render owns independent before-pass depth snapshots and writer ordering without WGSL intent inference. MaterialPass color outputs use ordered graph attachments and construction-time graph composition through `render/authoring`; Forward output contributions reuse the native scene/light graph and own the final color format/domain and finishing work; Renderer retains compilation, submission and retirement. Skinned recording selects each submesh binding layout from its resolved material pipeline contract, never shader-name or entry-wide topology inference. Runtime `CanvasTexture` sources use explicit updates, renderer-owned dynamic uploads and native frame publication across Workers; caller canvases survive renderer recovery. `importTexture` is the one renderer-local external source (caller `GPUTexture` or video): the renderer re-imports video every frame zero-copy into `texture_external` slots and copies when the capability is absent, rejects stale generations and expired frames with structured state errors, and never destroys the caller's object. Render vocabulary plus extract/prepare/record and `Renderer`; view-owned scene pass caches retain bounded render-bundle reuse across unrelated graph replacement by physical command identity, with attachment compatibility, bounded pass retirement, device cleanup and explicit dynamic-state fallback; a renderer-owned persistent CPU projection consumes synchronous World change evidence or owned render publications, retains stable sparse page and identity roots, and derives capability-gated GPU Scene tables. The Renderer owns one Render World (an ordinary ECS World with `RenderApply`); receiver and local ingest write rows only through its `render-sync` system, and every view shares those rows and holds only view-private state. Lights are Render World entities holding lifetime-stable shadow atlas layers; point faces and spots are `ShadowView` entities linked to their light, so shadow identities and retained caches survive other lights' arrival or removal, and a steady frame writes no light state. Hot paths are O(changes): scene rows are numeric pages over interned contents, each Engine→Render publication is one transferred per-slot record (fixed header plus change columns; an unchanged frame is header-only) with low-frequency rows and changed metadata entries as the only cloned side, records shrink after demand collapses, and view transparency classifies per material Pass. GPU-driven batches cull only residual CPU-drawn rows (`ExtractedFrame.gpuOwned`), admit opaque rigid Unlit rows and morph (a renderer-owned compute geometry producer, one batch per morphed entity), and size buffers by membership and the adapter's requested limits, failing with structured `limit-exceeded`. Renderer-owned depth and VSM moment layers preserve submitted manual shadow updates across graph replacement and capture; per-light caster channels remain independent of display visibility. Ordinary transmission shares transparent ordering, with all requested back faces preceding the front-face backdrop, inside the existing submission transaction. Fixed raw/temporal frame rosters capture these roots without scene expansion; actual queries consume readonly FrameList entries, while material, Mesh, availability and submitted-history reads retain their accepted versions, while runtime only selects concrete services and assembles them. Complete dynamic-geometry preparation declares a bounded entity roster under the existing aggregate byte budget; one retained transaction admits all members synchronously, and actual per-member frame consumption remains the publication authority. Native source publications can feed that same projection across a Worker boundary without a receiver World. Published Mesh preparation uses that receiver resource namespace, copies source bytes, waits for physical GPU completion and exposes only a generation-bound residency lease; source World/candidate admission stays separate, and draw evidence requires the exact current FrameReceipt. Async source geometry reuses that same candidate, budget and synchronous FixedUpdate admission owner; App transports only physical preparation and completed frame evidence with the consumed source tick. Unpublished residency transfers retain their allocation until actual receiver packet acceptance or cancellation. Material extraction and GPU Scene rows consume the selected ShaderRegistry program’s admitted parameter ABI across value updates and Worker transport. Frame-scoped simulation scene inputs declare an explicit camera, use the same typed scene-capture graph before shared work, and share the Renderer submission and recovery transaction independently of display cadence. CameraSnapshot carries view composition through both local and published input; one Renderer orchestrates private view state and a shared submission, while accepted source deltas reach held views and seed newly enabled views. PlanarReflection belongs to a display Camera and names a distinct public RenderTarget; its derived capture writes that target directly and retains the matching projection and receipt. Candidate target promotion requires an accepted write submission; other views cannot publish an unwritten resized target. A one-shot framebuffer snapshot copies a linear-HDR scene-color region into a public 2D target inside the same submission and is observable only after its receipt completes. Cube capture progress belongs to one Renderer target scheduler. Diffuse GI fields stay per view, but one Renderer budget splits their probe and Card work and ranks streamed Card residency against every view. Standard height displacement shares one vertex kernel across color, depth, temporal and shadows; extraction owns conservative displaced bounds and shading derives normals from displaced triangles. Standard directional shadow reception uses primitive geometric normals independently of authored shading normals; Forward derives them inline and Deferred transports them through one view-owned packed attachment with graph lifetime and binding identity. Each view retains only successfully submitted directional shadow projections whose receiver/caster reach, bias and filter/raster footprint remain covered; committed cache statistics share the existing inspection lifetime. Terrain directional PCF families derive instance routing before normal quantization, retain the accepted root/cascade/resolution mapping, and compose only GPU-static depth plus role-correct casters through the existing shadow graph and submission transaction. Surface direct lighting applies independent unsigned32 light/receiver channel intersection through World publications, GPU Scene and Forward/Deferred captures; shadow casters and ambient/GI keep their separate policies. One outer GPU timing capture covers shared work, each identified view and composition; each view's DynamicResolution consumes its own interval. Camera DynamicResolution uses renderer-owned asynchronous GPU feedback to resize internal Standard targets while TAAU history and output remain at presentation size; no CPU-clock fallback or World mutation. Public world-space clipping shares one coverage predicate across color, depth, temporal and opted-in shadow writers; CameraSnapshot owns per-view capture planes and material parameters own local planes. Spherical Atmosphere shares one optical kernel across sky, RGB aerial perspective, solar attenuation and independent captures; Renderer owns shared medium tables and retained capture generations, while each view owns its Sky/AP resources. Analytic Fog adds an extra height medium over AP and fogs the opaque scene in place before transmission and translucency; every blended writer, GPU particles included, fogs itself at its own depth through the View copy its blend composition selects, never through a post-translucency pass. Projected decals consume visible depth and compose ordinary material channels through graph-owned DBuffer targets before Deferred lighting; their assets retain scoped residency. The image-based `LensFlare` camera companion re-images thresholded HDR color as disc-blurred ghosts after Bloom and before exposure; it needs no light entity or occlusion query. Skinned `CapsuleShadow` casters leave the directional cascades; their posed skeleton capsules are tile-binned per view and evaluated inline by Deferred lighting. Local volumetric media use independent linear 3D sources; optional premultiplied albedo/density channels share the same source, sampling, publication and retirement, while author bounds and optics remain scene facts. Prepared UI crosses the shared UiPaintSource POD boundary; Renderer owns its sparse-strip raster pipelines, screen composition and retained-device recovery within the existing submission receipt. An optional Profiler receives bounded CPU evidence without owning render policy. Its opt-in ray reference owns indexed hit attributes and a bounded shared-material path integrator, outside ordinary frame allocation; bounded SDF queries and unlit raster cards share these snapshot/material contracts. Live-field sampling derives a bounded 3D distance/status texture from the existing Global SDF, hard-rejects occluded receiver-to-probe segments, and propagates unavailable coverage without admitting partial cache or history; baked volumes keep their own four-binding artifact. Opaque Standard subsurface profiles travel through ordinary material values into a view-private diffuse carrier and depth/normal/profile-aware diffusion graph; linear-HDR difference composition preserves specular/emissive and all new resources use existing graph retirement. Demand-scoped geometric scene SDF inputs consume the full retained CPU composition independently of GI and GPU Scene tables; matching World/range/source requests share graph production and receipt/fence retirement, while the VFX compiler owns bounded collision response. |
| `terrain` | Realm-neutral Landscape source, component, author-height and submitted-triangle kernels. Cook derives bounded section height mips and Standard layer closures; an explicit pure-weight ID policy derives author-resolution controls while complete author weights remain authoritative; render retains selected immutable layer Material/Image versions, derives four GPU texture arrays for actual draw selections without root/section/instance fanout; render owns per-view LOD and successful submission facts, while physics owns heightfield admission. |
| `geometry` | Pure procedural mesh factories (ordinary MeshAsset values; no symbolic geometry tokens), constant vertex-color assignment, receiver-local decal clipping and bounded local mesh distance-field derivation plus the canonical vertex-attribute layout. Analytic 2D curve bounds remain independent of mesh tessellation. Canonical Mesh preparation, bounds, portable encoding and validated static collision products share this owner; mesh facts and GPU layouts derive from one attribute map, never parallel handwritten layouts. |
| `shader` | Runtime shader lookup is content-addressable and compiler-free. Publication pools source fragments and ABI receipts; admission verifies every source and row, then retains composed WGSL only on demand. A single material `paramSchema` derives bind-group layout, uniform layout, and loader projection. The registry admits immutable source, identity and binding-contract facts once per composed material program; artifacts and device forks share that description instead of rescanning WGSL during graph projection or recording. Material registration owns its receipt as frozen POD; complete private registrations can transfer between registries after batch conflict checks, sharing admitted schema/program facts while retaining receiver projection and GPU ownership. |
| `shader-compiler` | Build-time WGSL composition, validation, and reflection are pure compilation work; Node material production bounds independent context compilation in a worker pool while preserving publication order and invocation-owned native handles. No compiler/WASM dependency crosses into the player runtime. |
| `naga` | Thin build-time access to raw Naga parse/validate/reflection, kept separate from shader registry and renderer code. |
| `vite-plugin-shader` | The bundler bridge forwards compiler behavior through load/transform/bundle/HMR hooks so authored shader modules retain one build-time contract. |
| `vfx` | Runtime-safe code-first GPU VFX contract: strict schema-v3 source, closed bounded sphere/box/vector force-field declarations over ordinary Texture GUIDs, cooked-program loading, `ParticleEffectPlayer`, zero-time admission of newly rendered Players, and bounded ordered FixedUpdate intents; its per-World runtime owns exact-effect SharedRef grants for current Players, queued ticks and retained submissions, releasing removed program versions and obsolete emitter IDs; no compiler, RHI state, or CPU particle mirror. |
| `vfx-render` | Persistent GPU simulation and indirect billboard/mesh RenderFeature: explicitly authored Player mesh sources consume the same entity’s MeshFilter through managed asset resolution and existing source publication; fixed-bounds culling, per-renderer projection/material state, managed field preparation/residency and shared FixedUpdate sampling with per-view state copied through native graph passes, recovery, and host attachment; its explicit simulation camera provider may consume the already extracted display views without duplicating camera selection or matrices; per-view color work derives opaque-before-blended ordering from resolved material state while retaining each group and GPU particle order; source frames carry effect handles and emitter IDs while ordinary asset publication owns immutable WGSL/reflection and plan resolves through the accepted resource owner; published meshes use that same World-scoped asset resolver after exact current-payload admission, while unmatched custom mesh values remain inline and managed geometry edits consume the same asset revisions and changed ranges; no source authoring or runtime compilation. |
| `vfx-compiler` | Build-time WGSL hook/import composition, managed compute shell, Naga validation/reflection, deterministic artifact, pure saved 3D vector texture generation, reflected managed field helpers, and NativeCooker adapter; no World, Renderer, Device, or runtime dependency. |
| `graphics-extras` | Graphics-adjacent pure logic—glyph attribute layout with Geometry-owned packing, tile bits, video primitives—lives outside runtime. GlyphText is a native persistent Render source: shared Font roots adopt without label fanout, actual draw/query layout owns generated geometry, and no World Mesh/Material assets are synthesized. |
| `interaction` | Realm-neutral transform gizmo consumes propagated Scene transforms and Picking camera rays; it owns constrained drag snapshots, local/world conversion, snapping and cancellation. Its retained presentation uses ordinary Geometry/Render meshes. DOM pointer capture, selection and undo remain in the host UI; World/App/Renderer own no manipulation mode. |
| `picking` | Runtime-downstream free queries share camera-to-ray core logic and scale precision from entity AABB to current-pose triangles, vertex and tile cell without putting interaction policy in rendering. Exact triangle and vertex queries share current Morph-then-Skin vertices and bounds; live weights and current joints plus inverse binds are consumed per query without GPU readback or retained pose authority. |

Renderer-wide source extraction, publication adoption, topology, material queries and
GPU Scene preparation belong to one `SceneComposition`. Each view retains only its
camera-dependent projection, Skin recordings and successful-submit history. A view
pipeline reset must not invalidate shared composition; GPU completion still fences
physical retirement. The ECS `RenderPrepare` schedule currently owns retained views,
lights and shadow views. Feature preparation and recording, temporal promotion and
completion remain with their native owners; no callback wrapper establishes full
Apply/Prepare/Record/Commit/Retire ECS migration. Any later migration must move the
actual facts and readers together and remove the replaced authority.
See `packages/render/README.md` for the retained scene and per-view contract.

Asynchronous rigid-mesh preparation retains the existing candidate, mesh lease
and fixed-step admission owner. Renderer derives its pipeline preparation from
the candidate's actual material/layout and the current view's scene passes;
pending candidates remain outside the accepted scene while ordinary frames
continue. App transports this projection and immutable program dependencies
through the existing mesh preparation request, without a second World or PSO
registry. Standalone mesh residency remains independent of scene pipelines.

Renderer owns failed completion admission: when an accepted submission's queue
completion rejects, its current generation becomes `faulted` and pending receipts
terminate with the first cause. App consumes that lifecycle to stop World updates
and submissions; it owns no duplicate fault latch. Completion failure alone is not
native device-loss evidence and does not immediately retire the device scope.

Image-based Skylight and skybox outputs belong to the selected render resource
scope and complete asset handle, including its generation. DeviceScope shares
IBL pipelines; each source publishes its own completed cube and IBL textures.

Pack authoring is an optional Engine tool capability: Pack owns literal descriptors
and sparse memory drafts; DevKit owns source revisions, explicit Worker generation
and exact preview binding. Live changes use managed asset updates or one explicit
Scene instance field write, with sparse author events and no Catalog/entity scan.
Save writes source only. Existing Pack formats and ordinary build/hot-reload paths
remain compatible; View owns controls and Agent context.
Failed legacy declaration opens retain their exact preview binding; a source
event can admit newly exposed literal parameters without replacing that preview.

### Asset schemas, import, and delivery

| Package | Core design idea / invariant |
|---|---|
| `pack` | Pack source, GUID tools, scanning and native program artifacts define the asset-package contract; there is no separate builtin GUID namespace. Validation is strict by default; explicit Editor admission reports malformed source declarations and retains healthy siblings, while identity/dependency conflicts remain fatal. GUID identity survives reimport. |
| `content` | Engine Content: an ordinary read-only asset library of authored `*.pack.ts` meshes, a mipmapped checker texture/anisotropic sampler and a default Standard material, mounted only through forge.json `assetLibraries`. `src/ids.ts` is the GUID SSOT for its Packs and the exported `EngineContent` strings; no runtime registration or player code path. |
| `assets-runtime` | The runtime asset owner unifies loaded and code-created identities, owned content, automatic change evidence, dependency holds and fixed versions. World bindings retain its references; private source preparation and explicit conflict-checked reload adopt complete closures atomically without consumer fan-out. CatalogSession admits unpublished declarations for navigation, requests consumed GUIDs through an explicitly injected producer transport, and validates complete publications before decode; deferred plugin references stay deferred. Material readiness retains byte-free inspection facts while the existing artifact registry owns canonical programs; complete public reads own their byte snapshots, and completed artifact reads only weakly retain decoder-owned buffers. Fixed captures borrow only completed byte hints and otherwise read their frozen source; they never await or populate domain-loader reads. Owned material/mesh/texture writes preserve input isolation; edited geometry invalidates source-cooked collision. Source provenance records the adopted publication, independently of later Catalog changes. Import and cooking stay with source producers. |
| `import` | Protocol-injected filesystem import, error-budgeted automatic Mesh LOD production, and DDC cooking stay build-time; opt-in source mesh collision attaches Geometry-owned products to the existing mesh GUID; the explicit navigation-bake subpath produces versioned clearance polygons from indexed Mesh/world placement without entering the player; an explicit native cooker attaches derived SDF bytes to the existing mesh GUID. An opt-in runtime Pack producer shares the pure build kernel, validates closures, and publishes ordinary Catalog data. |
| `codec` | Runtime-safe decode and build-time encode are separate entry points; compression containers and decompression gates stay centralized. Runtime Basis accepts an explicit native Host through the complete generated Emscripten factory, shares one retryable initialization per realm and leaves package paths with the Host. |
| `image` | Image import is a deterministic pure disk-to-POD pipeline whose sidecar compression policy is derived once rather than re-decided by each consumer. |
| `font` | Build-time MSDF atlas baking and runtime font loading are distinct phases; runtime text consumes prepared assets instead of font-tool internals. |
| `gltf` | A portable glTF parser projects standard source into engine POD sub-assets and sidecar packages; one document-scoped decoder owns dense, strided and sparse accessor semantics and admitted image bytes, and the producer preserves source cameras, materials and cubic tangents without teaching rendering the source format. |
| `mesh-io` | Node-only OBJ/STL/SVG source adapters project canonical geometry-owned MeshAsset values and bounded OBJ/MTL/image closures into the existing Import/Cook/Catalog chain; static placement exports own file-format conversion, never World, GPU or player policy. DOM and FileReader adapters stay in bounded short-lived Workers. |
| `fbx` | One ufbx/WASM parser serves browser and Node and projects FBX into the same engine POD asset model, never an Autodesk SDK/native-addon dependency. |
| `vite-plugin-pack` | Development transport/HMR and build `pack-index` emission are bundler responsibilities; development routes and build output remain separate forms. |
| `ui` | UiAsset preserves author HTML/CSS and source base; private Pack companions use the publication-scoped artifact reader's admitted stream locators or verified bytes. Standard DOM mounting projects only parsed references to those resources, and each instance owns its open ShadowRoot, font stylesheet, derived resource URLs, layer, AbortSignal and idempotent disposal using its root's ownerDocument. One parser-backed UI authoring profile defines portable HTML/CSS support across import and browser/native mount; source diagnostics preserve locations and recovery hints. Explicit browserExtensions require capability checks in the receiving browser and never expand the native profile. Dynamic references stay inside that declared closure; behavior remains in the consumer. Bounded live inspection reads the receiving DOM/Blitz tree and mounted source ownership without retaining another node catalogue or state authority. Browser preview stays optional. Its opt-in localization entry validates producer-owned JSON and creates project-owned native i18next instances; translation semantics stay outside World/Renderer. |
| `ui-blitz` | Headless HTML/CSS implementation owner: maintained Blitz nodes and shadow fragments are the sole UI tree, the JS facade retains their generational identities, Stylo/Taffy/Parley derive style/layout/text, and AnyRender emits owned Vello sparse-strip preparation or CPU reference RGBA. GPU execution remains Renderer-owned through UiPaintSource; the portable UI WASM has no wgpu dependency. The facade checks source mutations against the UI-owned portable profile before native adoption and retains structured UiDomError diagnostics. Native resource handlers consume ordinary verified UiAsset data URLs or the explicitly supplied host reader; retired nodes cannot adopt late font/stylesheet results. Builtin marker fonts belong to every document independently of host font coverage. Native ElementState owns checkbox/radio checkedness, range values and single-select selection, including dirty defaults, range constraints, option exclusion and popup state; facade events and cancellation use that same state. It owns no display, GPU device, App loop, asset registry or game state; its README records the qualified bindings and target evidence. |

### Simulation and media implementations

| Package | Core design idea / invariant |
|---|---|
| `physics` | ECS schemas, ordinary MeshAsset collider references and `PhysicsWorld` define the physics contract; interface policy is independent of the simulation backend. Current contacts expose detached completed-step manifolds with world-space solver points and nullable current-step normal impulse, or unique neighbors filtered by a strict normal dot product; both are independent of retained collision events. Derived candidates accept ordinary convex compounds and heightfields through one atomic preparation/admission/cancellation/mass/snapshot transaction; producers retain their source geometry semantics. |
| `physics-rapier2d` | The 2D Rapier/WASM adapter owns SIMD loading, backend synchronization, stepping, and writeback; vector conversion stays at this backend boundary. |
| `physics-rapier3d` | The 3D Rapier/WASM adapter owns the same three-phase boundary for 3D bodies/colliders, events, and transform synchronization, pinned upstream source patches and a package-local WASM payload; native cylinder/cone, cooked-source convex hull/trimesh admission and atomic authored replacement remain backend-owned. Ordinary convex pieces use the existing bounded derived transaction and retain one logical shape identity. Bounded current-contact queries read the native graph without retaining another registry; neighbor projection scans native solver adjacency without transporting points or per-manifold objects; native solver-contact identity selects genuine current-step impulses, while sleeping pairs retain geometry with unavailable load. Explicit wake/sleep and bounded per-body joint inspection use existing native owners. Optional spatial grouping retains one logical compound owner and coalesced contact transitions. Source-specific units, decomposition and boundary policy remain with producers; Engine retains only generic geometry, pose, mass, motion and publication facts. |
| `audio` | Audio components, tick/plugin, backend protocol, POD clips, and a closed intent union are realm-neutral; Engine Workers produce bounded byte/index publications and configurable bus/control intents, including source world pose, directional cones, speed, pause, clip start and seek controls, and never transport Web Audio objects. World mutation projections select changed source controls and playing acoustic voices without scanning clip consumers; accepted controls support transport retry, while the asset owner alone supplies clip identity and revision. Scene transforms and saved box/sphere `AcousticRegion` fields derive bounded source route weights and separate first-listener wet/send overlays; explicit source bus/volume remain the base layer. |
| `audio-webaudio` | The Host-owned Web Audio consumer decodes and caches fixed clips by asset owner/handle/revision with source key only as provenance, fences stale entity plays, and owns `AudioContext`, atomic configurable bus/send graphs and shared effects, source nodes, retained regional crossfade taps into existing buses and listener wet/send AudioParam overlays, bounded verified PCM16 Range windows, rate-integrated pause/resume positions, exclusive user AudioNode chains, opt-in frequency analysis, sample-rounded musical transport/epoch scheduling, and cleanup. Music stem gains multiply the same accepted bus graph and Context clock. |
| `intelligence-fake` | Deterministic provider evidence: explicit `advance()` drives the same Activity consumer for offline tests and 300-frame validation without credentials or timing mocks. |
| `intelligence-dsh` | Node Host adapter exact-pinned to the DSH SDK; one JSON-RPC runtime per Activity gives isolated cancellation and full subprocess cleanup without leaking DSH types. |

### Inspection, debugging, and development bridges

| Package | Core design idea / invariant |
|---|---|
| `profiler` | Opt-in bounded CPU capture for the App/Render loop: `ProfileCapture` is the schema-validated offline boundary, allocation and overflow evidence are explicit, and CLI/Remote access reuses existing surfaces. It does not own ECS spans, GPU timing, UI, or a new RPC method. |
| `preview` | Engine-owned AI resource preview contract: one typed `preview.host` capability, canonical presentations, four closed subject operations, thumbnail presentation/input identity, and manifest-v2 evidence publication. Texture inspection derives bound source facts, validates mip/slice/display selection and packages ordinary material shaders; App assembles their consumer and Renderer owns upload, submission and retirement. Equirect source mip 0 remains distinct from internal IBL roughness levels. DevKit specializes the same previews in a retained asynchronous batch, caches only verified PNGs in DDC and publishes progressive workspace state. It owns no asset import, renderer, VFX, or second tool registry. |
| `debug-draw` | Immediate-mode debug primitives stage per-frame CPU data and render through a small RHI layer; it visualizes engine facts without becoming a scene asset system. |
| `remote` | Live inspection is an explicitly transported, physically isolated JSON-RPC/CLI surface with script contracts; optional profiler and execution roots are structural projections, not new RPC methods or upstream imports. |
| `rhi-debug` | RenderDoc-style frame tape: self-contained initial resources (external video frames enter as recorded CPU snapshots; BLAS/TLAS re-encode their last pre-capture build in topological order; optional size-scoped seeds) streamed as zero-copy container parts through resumable digest-checked chunked upload, deterministic replay on a fresh device, structured per-draw/offline inspection including every work output (compute storage buffers/textures, depth/shadow layers with linearization) plus bounded mixed-type compute buffer records, batched multi-work readback with HDR image/atlas-tile decode for GI buffers, replay-owned per-pass GPU timing, and producer-owned pair comparison (first divergence + bounded lineage) feeding a result-only viewer. |
| `vite-plugin-rhi-debug` | Development-only endpoints (digest-verified resumable chunk upload with atomic commit) and define injection connect browser capture to the RHI-debug tape path; no capture machinery remains in a production build without the plugin. |

**Maintenance rule:** when adding, extracting, or materially repurposing a package, update its row in this map in the same change. Preserve the separation stated here; use the named README and source for precise forms, error codes, and capability details.

## Component naming

- Single-semantic components drop the `Component` suffix — `Transform`, `Camera`, `DirectionalLight`
- Unity slot suffixes kept as idiom — `MeshFilter` (geometry) + `MeshRenderer` (material)
- Relationship components take the holder's perspective; field mirrors name — `ChildOf { parent: Entity }` (not `Parent`)
- Category discriminants sink into the asset — `MeshRenderer { materials: Handle<MaterialAsset>[] }` + `MaterialAsset.passes[].shader` (shader identity = discriminant)

Roster `packages/runtime/README.md` §Naming.

## Error model

Closed unions are the SSOT — exhaustive `switch (err.code)` without default; TS guards completeness. Error objects carry `.code` / `.expected` / `.hint` / `.detail` (`.detail` narrows per `.code` via discriminated union). **Read the source, don't duplicate member lists** — `packages/<pkg>/src/errors.ts` (shared unions `packages/types/src/index.ts`); grep `'export type [A-Z]\w+ErrorCode'`.

## Metric registry

`schemas/forgeax-metrics.schema.json` — CI metric declaration SSOT. Closed `MetricKind` (5, order locked): `'bundle-size' | 'fps' | 'bench' | 'gate' | 'spike-report'`. Each workspace declares all 5 in `package.json#forgeax.metrics` (`enabled=true`, or `false`+`reason`); undeclared/typo/non-`ok` → block PR.

## Worktree discipline

> [!CAUTION]
> **Never switch the root checkout's branch.** `git checkout` / `switch` / `checkout -b` in the primary working directory is forbidden — editing files there is fine; moving its pointer is not.

- Branch work goes through a worktree `.worktrees/<branch>/` (closed-loop `manage_worktree.py create`; ad-hoc `git worktree add`). All commits there
- After the task is committed or merged, confirm the worktree is clean and remove it with `git worktree remove .worktrees/<branch>`; delete the no-longer-needed merged branch as well
- Fresh contributor worktree re-materializes: `forgeax-engine-assets` (`submodule update --init --recursive`), `wgpu_wasm_bg.wasm` (cp from main tree). Public SDK source has no private asset submodule and keeps the checked WASM payloads in place.

## View source tool

`tools/view` is the fixed `forgeax-view` submodule, independent of the floating Harness
and private asset sidecar. Engine owns its workspace membership, root lockfile and SDK
publication. Initialize the gitlink to develop tools; `pnpm build:engine` remains usable
with View absent. `pnpm build:tools` selects generic View plus ordinary source plugins in
`tools/view-plugins`; those sources have no package manifests and runtime packages do
not depend on View or React. `pnpm test:view -- --candidate` tests a proposed pair;
formal `check_submodule_pins.py` still requires the final View pin on View main.

The SDK embeds built View under `tools/view/` and installs it as a private local
package alongside Engine in `.forgeax/cli-runtime`, using `toolchain/cli-runtime`
inputs. Only Engine and SDK are public npm products. Games only install Engine. The public source archive
expands the fixed View gitlink and includes its Apache-2.0 license. An installed tool's
native frontend resolves the selected Host Engine graph; conflicting game Engine bytes
are rejected before boot. An executing source Host supplies that graph even when the
embedded tool has a prebuilt Engine dependency. Artifact pages are usable without a project; project pages
retain Engine's existing project and target recovery.

## Assets submodule (contributor checkout only)

"assets" collides across three layers: runtime API (`AssetRegistry` + `Handle<AssetUnion>`) · runtime inspection (Inspector root `assets`, JSON-RPC WS:5732) · the submodule **`forgeax-engine-assets/`** (binary sidecar, pointer only; vendor namespaces keep upstream licenses, e.g. `learn-opengl/` = **CC BY-NC 4.0**).

Disk schema, `pack-index.json`, catalog dispatch, license boundaries — SSOT `forgeax-engine-assets/README.md` + `packages/pack/README.md`. The SDK `game-3d` template generates its asset closure from tracked `*.pack.ts` sources.

## Asset authority map

The machine-readable M5 audit is [`schemas/asset-authority.schema.json`](../../schemas/asset-authority.schema.json), with its executable gate at [`scripts/forgeax/check-asset-authority-audit.mjs`](../../scripts/forgeax/check-asset-authority-audit.mjs). Pack/external source plus Meta owns author facts; importers, native cookers and `RuntimePackProducer` produce validated outputs; DDC is disposable cache; Catalog is a projection runtime reads; Editor writes go through the asset-authoring gateway. `forge.json` remains the `engine-project` manifest authority and is not a Catalog asset.

Use the shared words `subject`, `execution`, `lifecycle`, `lastKnownGood`, and `sourceKey`. AI recovery starts with `inspect`, then follows a producer-owned `rebuild` or `cold-cook`; `preview-LKG`, `override`, `promote`, and `stop-publish` remain explicit operations with their owner and write boundary. Docs point to the audit schema rather than restating its matrix.

## SDK distribution

> [!IMPORTANT]
> Both SDK transports extend the built Engine with editable source and the same
> release's prebuilt package outputs. Rebuild only changed modules; unchanged
> modules keep those outputs. The full ZIP also supplies offline dependencies.

> [!IMPORTANT]
> SDK release is a two-phase Candidate → Promotion protocol. Dispatch
> `sdk-release-candidate.yml` on current `main` to build one seed, run the four
> independent gates, and seal `sdk-candidate.json`; dispatch
> `sdk-release-promote.yml` with that run ID to consume the exact sealed bytes.
> Promotion never rebuilds. It finalizes the GitHub Release idempotently and
> completes enabled source mirroring (development to public `main`, stable to
> public `stable`; the internal `rc` test line is not mirrored) before npm uploads
> and public metadata/dist-tag/tarball verification. Channels, the weekly rc cut and
> hotfix flow live in `packages/engine/RELEASING.md`. Never pre-create or push
> `sdk-v{version}`; a same-version different-integrity result is terminal.
> Operator commands and recovery semantics live in
> `skills/forgeax-engine-sdk/SKILL.md` and the maintained release design spec.

`pnpm sdk:build` packages both surfaces plus exact-version npm tarballs under
`artifacts/sdk/npm/`. The archive layout is the contract; never replace the source
snapshot with a workspace link or make the consumer verifier depend on the producer
checkout. `@forgeax/engine` is the single user-facing dependency; `@forgeax/engine-sdk`
is the on-demand carrier for `forgeax sdk install` (GitHub Releases are private, so
users need no GitHub credentials). ZIP, packages, tarballs, carrier, manifest, and
provenance share one version and Engine commit.

| Archive path | Authority and use |
|:--|:--|
| `bin/forgeax` | Standalone built CLI entrypoint; direct SDK users do not build the Engine first. |
| `packages/` + `templates/` + `skills/` + `store/pnpm/` | Full ZIP: bare built public package directories, project-local Engine skills, explicit `empty` and `game-3d` templates, and their offline game-project closure. |
| npm carrier `bin/` + `templates/` + `skills/` + `source/engine/` | Online SDK with editable source; shared outputs materialize from its exact-version Engine dependency using artifact `enginePath` and hash checks. It omits `store/pnpm/`, bare `packages/` and `toolchain/wasm/` (`SDK_ZIP_ONLY_PATHS`). `new`/`init` resolve the locked dependencies, including Engine, from npm. |
| `source/engine/` | Same-commit source, guidance and prebuilt `packages/*/dist/` from the release. Install source dependencies, rebuild changed owners and use the existing local Engine binding. |
| `source/engine/packages/*/pkg/` | Prebuilt WASM glue and binaries for wgpu, FBX, and Basis codec paths; these remove the default Rust/Emscripten fetch or compile prerequisite. |
| `source/engine/third_party/wgpu/` | Licensed source from the exact Engine gitlink, expanded without Git metadata for native Rust development. |
| `sdk-manifest.json` | Per-file archive inventory plus the source snapshot and prebuilt-WASM summary. |

The source snapshot is not a Git checkout and excludes every expanded repository's
`.github/`, `node_modules`, `.git`,
`pnpm build:engine` work there without WASM hydration. A source change needs its
source gates, then a fresh SDK build and exact-ZIP verification. Exact-ZIP verification
runs the unpacked template's renderer/UI/input/camera/animation/FixedTick path and omits
only the long `game-3d` collision journey, which the default Preview template smoke and
the Candidate gate still require. A hosted run may record one exact Chrome/Lavapipe
Instance loss preceding a completed journey (report `passed-with-omissions`, proving a
fresh process reaches `alive` — never survival of the lost renderer); every other error
is fatal. The SDK manifest schema is versioned independently of `forge.json`; its
`artifacts` array is the SSOT for every file digest (the npm carrier omits the
full-ZIP-only rows).

## Commands

`pnpm install && pnpm build` (packages + app fleet + `tsc -b`) · `pnpm build:engine` (daily engine feedback) · `pnpm build:app hello/triangle` (one app) · `pnpm build:clean` (cold rebuild) · `pnpm test:unit` (=`test`) · `test:browser`/`test:dawn` (chromium+WebGPU / dawn native) · `test:all` (CI source of truth) · `pnpm --filter @forgeax/hello-triangle smoke` (dawn-node e2e) · `pnpm --filter @forgeax/engine-profiler smoke:consumer` / `test:perf` (bounded CPU evidence) · `pnpm -F @forgeax/engine-wgpu-wasm build` (CONTRIBUTING §Rust) · `metrics:check`/`:run`/`:run-fps`/`:report` · `bench:pixel-parity` · `pnpm check:code-file-lines` (≤4096 lines per code file) · `pnpm check:function-complexity` (CCN ≤20 ratchet) · `pnpm check:dependency-vulnerabilities` (OSV lockfile ratchet; see [CI guide](../../scripts/ci/README.md#source-quality-ratchets)) · `pnpm dev` (:5173) · `biome check --write .`

`build:engine` / `build:app` are feedback shortcuts, not replacements for browser, Dawn, smoke, or full-fleet gates.

A fresh worktree can start from a built sibling: `pnpm build:seed [--from <worktree>]` copies its ignored build outputs and task receipts (default: the most recently built worktree), then `pnpm build:engine` verifies and rebuilds only what differs. `FORGEAX_BUILD_CACHE_DIR=<dir>` lets game checkouts share one content-addressed Pack-product build cache instead of `<project>/.forgeax/ddc/build-cache`.

**ForgeaX CLI** — `forgeax` is the single entry. `forgeax sdk install <directory>` installs the npm carrier; then `forgeax project new <directory> --template game-3d` (every 3D game) or `--template empty` (template is required; target outside the SDK root). From a game project root: `forgeax project skill install|verify` · `forgeax help --tree --json` · `forgeax asset list --json` · `forgeax project preview` · `forgeax project package [--format web-zip|single-html] [--output release/game-web.zip] [--compress=false]` · `forgeax dev status --json`. `project package` emits the default deterministic Web ZIP (HTTPS hosting, never a `file://` player) or an explicit single-HTML candidate with adjacent SHA-256 (the only file-based player form). Preview operations are the closed set `project.preview`, `asset.material.preview`, `asset.mesh.preview`, `asset.vfx.preview`, `asset.texture.preview` (resources by GUID). The `forgeax-engine-cli` skill covers authoring, composition, preview, packaging, and live inspection; `ToolClient`/`ToolRun` are internal contracts.

**CI retry discipline** — For a verified intermittent external GitHub Actions network or transport failure (`ECONNRESET`, TLS timeout, signed-artifact URL failure) with no code-level error, retry only failed jobs: `gh run rerun <run-id> --failed`. Never issue a whole-run rerun; preserve successful work and its evidence.

**CI monitoring discipline** — When the user requests periodic monitoring, use one watcher with observations bounded by the active wait policy (at most 240 seconds). Keep long monitoring jobs in the background and avoid duplicate status requests. Merge only when all required checks are green.

## Conventions

- **ESM-only**, output `.mjs`; types `tsc -b`. **TS strict** — `tsconfig.base.json` is SSOT (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`)
- **Errors structured** — return `Result`, never throw for expected failures. **Explicit registration** — components/resources/events need schema. **No comments unless why is non-obvious**
- **Lint naming** — private/protected fields no underscore prefix; package-internal `_xxx` needs `@internal` JSDoc
- **Biome** lint+format · **Vitest** · **tsup**
- **Dual lockfile** — `pnpm-lock.yaml` + `bun.lock` both committed; `pnpm run sync` if drift, gate `pnpm sync:check`; `pnpm ci:channel-align` checks the pnpm version pin. When editing `ci.yml` / `check-ci-channel-alignment.mjs`, run `pnpm run lint && pnpm ci:channel-align`. Dependabot parity `sync-bun-lock-on-dependabot.yml` (`FORGEAX_BUN_LOCK_OUT_OF_SYNC`).
- **English-only source + agent guidance** — ASCII + math/Greek/symbols. Checkers: `scripts/forgeax/check_english_only.py` and `check-agent-docs-english.py` (every `AGENTS.md` / `SKILL.md` and `skills/` text; localized READMEs exempt).
- **Duplication check** — `pnpm dup-check` (jscpd, SSOT `config/jscpd.json`)

## Test layout

- Test directories use the plural `__tests__/` spelling. Do not add `test/`, `tests/`, or `__test__/`.
- Tests live in the nearest owning `__tests__/` (source root, package/workspace root, or `scripts/**/`).
- Benchmarks: `bench/*.bench.ts` — the only test-like location outside `__tests__/`.
- Filename encodes the runner: `*.test.ts` (Vitest unit) · `*.test.mjs` (`node:test`/scripts) · `*.browser.test.ts` · `*.dawn.test.ts` · `*.test-d.ts` (types) · `*.integration.test.ts`.
- Run `pnpm test:layout` after adding or moving a test. The same check is part of `pnpm lint:grep`.

## Skills & knowledge base

- `skills/` — repo-local `forgeax-engine-*` usage skills; routing `rules/forgeax-engine-usage.md`. `forgeax-engine-cli` is the single total CLI skill for project operations, composition, live-instance inspection, and package-owned offline bins. Debug index `forgeax-engine-debug` (symptom → root-cause → fix)
- `.claude/skills/` — harness-installed (closed-loop, steps, install, monitor, …)
