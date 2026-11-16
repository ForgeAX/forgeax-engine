# Water R8: Coast Integration Acceptance

Run `pnpm --filter @forgeax/water-r8-integration-acceptance dev` and open
<http://127.0.0.1:8090/>. The server binds on `0.0.0.0:8090`. The saved Pack assembles an Ocean, offshore shallows,
a small island, a native four-pontoon rigid ship and standard single-layer optics.
The default `coast64` instance uses tessellation factor 6 (64 quads per edge).
`window.__waterR8.setMeshProfile('reference256')` selects the separate factor-8,
256-quad reference instance through the normal completed configuration transaction.
Both retain Q0 optical features; visual and performance evidence must name the
mesh instance, viewport, DPR and GPU adapter. A coast64 result does not establish
reference256 performance. Frame rates depend on the accepted workload and device;
the control panel displays completed frames rather than assuming a target rate.

## Scene controls

The primary Chinese control panel groups visible phenomena into nine dimensions:
quality, sea appearance, wind and waves, foam and wakes, hull and probes, driving,
entry spray, weather and lighting, and camera framing. Each control uses the
existing material, Water recipe, Scene component or native Physics admission
owner. The original showcase can also be served on a chosen port, for example
`pnpm --filter @forgeax/water-r8-integration-acceptance dev -- --host 0.0.0.0 --port 8092`.

Sea tint reads the active material's normalized scattering color. Clarity is
five-meter transmittance, mapped exponentially to absorption and scattering.
Visible surface and far materials keep their own admitted switches; unsupported
effects explain their disabled controls. SSR controls cannot enable a branch
that deliberately removes SSR. Four workload presets remain separate from
rendering branches and retain completed configuration admission and rollback.

Foam controls describe surface coverage, crest and shoreline thresholds,
emission and decay. Decay time means seconds to five percent with no new source;
zero foam decay means permanent coverage. Contact-history decay is a read-only
creation parameter because its owner has no live setter. Airborne droplets have
separate burst count, capacity, size, spread, opacity and lifetime. The count
edits the unique time-zero reservation burst, preserving later bursts; reserved
edge water remains invisible until its collision-derived shedding phase. Custom
continuous or looping schedules remain in Advanced. Entry response scales the
native normal-speed and sphere-radius response within its bounded tuning range. Launch and spray controls
apply to the next launch or entry, while residual-wave controls affect the solver.

Wind strength scales physical wave amplitude. Wavelength and direction rebuild
the deterministic spectrum; material detail speed changes texture motion only.
Native hull mass and inertia wait for a completed Physics step. Requested values
stay visible while pending, then show the accepted native value, including
fractional readbacks. Owner rejection restores accepted values and allows a new
edit. Sun orientation controls direct lighting only; the baked sky image retains
its authored sun direction.

Sliders preview locally and commit on release. Continuous number inputs accept
fractional values; discrete resolutions use supported choices. Closed dimensions
and hidden panels do no periodic full asset reads unless an edit awaits admission.
A demanded refresh shares one detached observation per owner form; Advanced
retains complete fields and immutable facts without a second runtime registry.
Diagnostic inspection is requested by expanded diagnostics, configuration
transactions or explicit profiling. Acceptance records completed hardware frames,
actual field readbacks and owner errors; changed rendering and effect paths require
fresh runtime evidence in addition to source checks.

The Ocean uses a 2048 m local wave window with 2048-pixel WaterInfo and an
explicit view-window far boundary. Its flat ring extends 4096 m beyond that
window; the saved Ocean, query and collision bounds span 16384 m. This is a
finite supported camera domain, with world-space wave phases across recenters.

> [!IMPORTANT]
> Implementation, completed hardware frames and paired reference equivalence
> are separate gates. Paired visual parity, device-recovery stability and the
> performance comparisons remain unverified. Q3's CPU mesh with type-default Water family
> materials and Q4's saved flat appearance adapter are selectable through completed configuration
> transactions; their paired reference comparisons remain unvalidated. R7 Bake/FFT
> are available in the separate dedicated R7 application.
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
Local waves use `waveDampingPerSecond: 0.45`: their free amplitude falls to 5%
in approximately 6.7 seconds. They emit foam only above slope 0.015. The Engine
owns this elapsed-time dissipation for visible and buoyancy fields; this recipe
only tunes its rate. Background Gerstner waves remain continuously forced, with
independent crest compression minimum 0.04 and range 0.1.
The local recipe sets `entryWaveMultiplier: 1` and `surfaceTransportMultiplier: 1`.
The same native wave field drives external buoyancy queries. Entry authoring
also supplies a generic `OceanPatch.enqueueWaveImpulse` from actual sphere
radius and normal incident speed. Local momentum evolves in the same finite-depth
field with the background waves unchanged. An unresolved footprint spreads to
one native cell with velocity reduced to preserve its deep-water energy budget.
The caller chooses that budget; Engine owns propagation and submission lifecycle.
Disabled local simulation retains ordinary airborne entry presentation. A fully
submerged ball is hidden while its ordinary native physics remains active.
Iron balls carry no `WaterPontoonSet` or `WaterContactProbeSet`; ship pontoons and
probes remain unchanged. Entry detection samples the surface on completed native
steps until the first entry, then uses the recorded surface height to hide the
ball when its current native top passes below it. It stays hidden without further
water queries. Recording entry removes `WaterShallowCollider`, ending water actor
gathering without removing the ordinary Physics `RigidBody` or `Collider`.
Submitted wave impulses retain their independent propagation and
source-receiver exclusion. `readEntryState()` derives `buoyancyParticipant`,
`contactProbeParticipant`, `shallowColliderParticipant` and `nativeEntryArmed` from existing components and the
recorded entry without sampling water.
The airborne effect starts with an indexed thin crown rooted at the native sphere perimeter.
Its irregular rim stretches into ligaments; fine droplets detach from that same
mesh rim with its current position and tangent velocity. A narrow sealed tongue
appears later, after a radius/normal-speed cavity-collapse delay. All three
emitters share the same Parameters/Custom ABI and one authored motion module.
The two apps derive rise, spread, size and duration from the same native collision;
normal entry speed bounds the airborne energy and sphere radius supplies its
gravity scale. The Pack carries the explicit module catalog, including a rim
table derived from the actual crown geometry. This is an authored sheet and
ballistic breakup approximation, not a resolved fluid simulation. Native water
waves retain the separate Water solver owner.
A paused canonical player requests preparation before the first launch. First-use
frame gaps and peak appearance remain runtime acceptance checks; these settings
alone do not establish physical fidelity.
The loaded ship adds 50% of its original design mass as low keel ballast via
`COAST_SHIP_ADDITIONAL_BALLAST_RATIO` in `assets/ship-rig.ts`. Its mass, COM and
full inertia tensor derive from those elements. The original hull buoyancy
calibration remains tied to design displacement, so added load increases draft
instead of increasing the same hull's buoyancy coefficient. Initial/reset height
derives from the loaded hydrostatic equilibrium; contact probes follow that
waterline. Native buoyancy still evolves the actual pose after initialization.
The loaded recipe uses ascent damping 24,000 N/(m/s) and water angular drag 2/s.
The previous archive checkpoint covered stationary behavior, sailing wake and
foam decay. The current demo adds runtime quality selection, manual navigation
and entry-response inspection. Those controls do not qualify the independent
reference, device-recovery or performance gates below; completed-frame evidence
must identify the selected workload and active configuration.
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

The runtime form selects four workload presets independently of implementation
branches, then reports custom when edited. WASD/arrows apply native inertial
thrust and rudder torque; Space boosts thrust. The coast recipe accepts a full
native source interval up to two seconds for slow presentation/capture frames.
Longer gaps remain explicit owner refusals; no source time is clamped or silently
dropped. Particle retirement follows its presentation simulation clock.

The four presets change real mesh, WaterInfo, wave, pontoon and local simulation
workloads. The form reads accepted owner state after configuration completion;
editing a workload marks it custom. Native mass edits retain fractional values
and update the focused field when the solver accepts the publication. Invalid
inputs display the owner error and restore the last accepted value. Read-only
identities and cooked facts remain visible separately from editable parameters.

Collapsed runtime sections perform no periodic full asset reads. Opening a
section reads one coherent accepted observation for all fields; pending native
edits continue refreshing until commit or rejection. Profile and RHI capture are
explicit diagnostics. Compare ordinary completed-frame windows separately from
sampled or captured windows with identical camera, viewport and workload.

Entry spray retains the translucent water-sphere renderer. Its particle alpha
owns opacity; the authored soft-particle fade is in normalized reverse-Z depth
units, as specified by the VFX owner, rather than metres. The independent R8
entry experiment on port 5388 also exposes the v2 visual-normal FFT, native
residual query policy, pause and reset. It is a separate scene from this showcase.

The shared entry effect attaches its crown and tongue to the current water
surface using ordinary parameter patches and Water queries during the effect
lifetime. This effect attachment is independent of the iron ball, which remains
without buoyancy, probes or post-entry water queries. Released droplets retain
their GPU position and velocity instead of following later attachment patches.
The physical impulse footprint is the sphere radius times 1.2; the spectral
producer projects that supplied footprint without widening it to a grid cell.
