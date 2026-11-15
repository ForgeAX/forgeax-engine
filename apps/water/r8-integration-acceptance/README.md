# Water R8: Coast Integration Acceptance

Run `pnpm --filter @forgeax/water-r8-integration-acceptance dev` and open
<http://127.0.0.1:8090/>. The server binds on `0.0.0.0:8090`. The saved Pack assembles an Ocean, offshore shallows,
a small island, a native four-pontoon rigid ship and standard single-layer optics.
The default `coast64` instance uses tessellation factor 6 (64 quads per edge).
`window.__waterR8.setMeshProfile('reference256')` selects the separate factor-8,
256-quad reference instance through the normal completed configuration transaction.
Both retain Q0 optical features; visual and performance evidence must name the
mesh instance, viewport, DPR and GPU adapter. A coast64 result does not establish
reference256 performance. The current target is at least 60 completed frames/s.

The Ocean uses a 2048 m local wave window with 2048-pixel WaterInfo and an
explicit view-window far boundary. Its flat ring extends 4096 m beyond that
window; the saved Ocean, query and collision bounds span 16384 m. This is a
finite supported camera domain, with world-space wave phases across recenters.

> [!IMPORTANT]
> Implementation, completed hardware frames and paired reference equivalence
> are separate gates. Visual parity, recovered 60-frame stability and acceptable
> Q0 performance have not passed. Q3's CPU mesh with type-default Water family
> materials and Q4's saved flat appearance adapter are selectable through completed configuration
> transactions; their paired reference comparisons remain unvalidated. R7 Bake/FFT
> remain unavailable.
> Current local simulation composition does not establish UE-R0 fidelity.

Q1 reduces authored mesh and WaterInfo parameters. Q2 disables SSR. R1 selects
GPU mesh, and R5 selects the existing Worker buoyancy path. A change becomes
active only after a completed receipt agrees with the current Zone, Body,
WaterInfo, mesh and graph generations. Failed candidates restore the previous
configuration; restoration failures pause the app and remain in the export.
Q0 composes the opt-in `mode-projected-gravity/1` World OceanPatch's residual
height/normal/foam with the existing water material. Its fixed world domain and
native geometry source remain independent of Terrain depth and Body flow.
The candidate uses a 256 m / 512-cell grid, 16 cubic depth slabs and a uniform
16 m reference depth; it is not a resolved 1 m/s acceptance configuration.
Select circular or straight sailing through the normal ship controls.
Contact and local-wave foam use the authored `COAST_FOAM_DECAY_PER_SECOND`
value in `src/identity.ts`. At 1.8/s, unrefreshed coverage retains approximately
5% after 1.7 seconds; active waves can still produce new foam. This is scene
appearance configuration, independent of buoyancy and source transport.
Local waves use `waveDampingPerSecond: 0.5`: their free amplitude falls to 5%
in approximately 6 seconds. They emit foam only above slope 0.1. The Engine
owns this elapsed-time dissipation for visible and buoyancy fields; this recipe
only tunes its rate. Background Gerstner waves remain continuously forced, with
independent crest compression minimum 0.04 and range 0.1.
The local recipe sets `entryWaveMultiplier: 4` for an exaggerated falling-object
diagnostic. The same amplified wave field drives external buoyancy queries;
the ship's sailing transport and native cannonball size/mass retain their values.
This setting does not establish physical entry-wave amplitude fidelity.
The scene uses `surfaceTransportMultiplier: 2` to strengthen the bow/side sailing
wave source at the existing 6 m/s ship-speed target. This artistic gain does not
extend free-wave or foam decay and does not alter the independent entry gain.
The loaded ship adds 50% of its original design mass as low keel ballast via
`COAST_SHIP_ADDITIONAL_BALLAST_RATIO` in `assets/ship-rig.ts`. Its mass, COM and
full inertia tensor derive from those elements. The original hull buoyancy
calibration remains tied to design displacement, so added load increases draft
instead of increasing the same hull's buoyancy coefficient. Initial/reset height
derives from the loaded hydrostatic equilibrium; contact probes follow that
waterline. Native buoyancy still evolves the actual pose after initialization.
The loaded recipe uses ascent damping 24,000 N/(m/s) and water angular drag 2/s.
The user accepted stationary behavior, sailing wake and foam decay as the current
archive checkpoint. External entry response, wind-motion calibration and foam
appearance remain deferred; FPS work is paused. This checkpoint does not qualify
the independent reference, device-recovery or performance gates below.
Optional R6 is authored and disabled by default.
Both retain their independent owner acceptance gates. The dispersive OceanPatch
now admits completed local height/normal samples through the Water query owner
to ordinary native pontoon forces, fenced by GPU, fixed-step time and Body
generation. Four zero-wind/current browser controls establish synchronous
iron-ball causality and feedback-off behavior with native force/integration
reconstruction and no solid hull contact. Worker consistency, lifecycle and
production hull-on stopped stability remain required acceptance gates. R6/R7 visual outputs and
contact-foam history do not establish this live feedback path.
V-06 remains a separately unverified optional WaterEditor/Terrain tool gate;
it does not block the required UE-R0 runtime fidelity gates. Render inspection
reports CPU mesh publication as unvalidated when that Runtime fact is absent,
so Q3 reports support only after its same-frame Runtime CPU WaterMesh publication
matches the accepted Zone and Body output generations. Its transaction retains
the complete WaterInfo compute/storage and optics gates. Q4 selects saved flat
appearance materials and reports an adapter only after a ready Renderer draws
one of their expected revisions in the completed frame. Neither mode establishes
paired UE appearance evidence.
The accepted coast material switches enable foam, so the report requires V-16.
`foamInputs` exports those material revisions and the submitted draw's static,
dynamic, Baked and no-simulation FoamRT observations; this is not contact-foam
appearance or UE comparison evidence.

`window.__waterR8.readState()` exports capability decisions, logical resource
estimates, source/output generations, queries, fixed/CPU/render timelines and
operation receipts. `inspection` belongs to the submitted frame;
`liveRenderer` reports the current state, pending completions and recovery.
The logical budget estimates the current compiled view graph only. Candidate,
previous, retiring and all-generation peak bytes and last-use fences remain
unknown; it does not measure physical VRAM. The Ocean height fault replaces a
complete pre-cooked variant through the accepted Asset publication.

The opt-in profile API is separate from `readState()` and its version-1 schema.
`window.__waterR8.startProfileCapture()` defaults to the bounded 900-frame
`normal` preset; pass `'nested'` for the 180-frame nested attribution preset,
or pass a `{ preset, frameLimit, eventLimit, detail }` object to use bounded
`RecorderLimits` overrides. The normal preset records graph-pass detail; nested
also records producer-owned child scopes. Each preset caps the event store at
1,048,576 events. Call
`await window.__waterR8.finishProfileCapture({ waitMs: 5000 })` to close CPU
recording and allow pending receipt callbacks and GPU observations up to the
bounded wait to settle before the export is frozen. A timeout is explicit in
the completeness sidecar and leaves outstanding work partial.

Profile exports keep each exact submitted receipt's
`renderPassCpuIdentities` and `renderPassCpuIdentitiesComplete` beside its
receipt/profile-frame/device identities. `gpuIdentity` rows carry the actual
GPU timing identity tuple for CPU-to-GPU joining; `graphExecutionIndex` is a
CPU graph position and must not be used as a GPU execution index. GPU timing
completeness requires every pass to be measured and an exact identity join.
Native timing is fenced independently by
`PhysicsWorld.getSolverClock().completedStep` at CPU capture start and finish,
and is partial if expected synchronous step rows are missing, duplicated,
unassociated, dropped, or the fence cannot be read.

Body telemetry names Runtime asset-output snapshots and current WaterSystem
output status separately from accepted per-view mesh publications and their
completed frame identity. The explicit WaterInfo delay action uses a Render-owned
internal probe to retain one capture before the next frame produces its candidate.

Use the existing RHI capture/upload capability for a failing frame and retain
its tape, digest, live screenshot and native receipt. Inspect unseeded resources
before interpreting replay pixels. Raw evidence belongs outside the checkout.
The separate Harness QA entry
records the visual differences, driver failures, hardware and unverified gates.

Relevant owners are [Water](../../../packages/water/README.md),
[Runtime](../../../packages/runtime/README.md),
[Render](../../../packages/render/README.md) and
[RHI Debug](../../../packages/rhi-debug/README.md).
