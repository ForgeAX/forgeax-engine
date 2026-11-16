# Boat Sailing — Shared R4 / R5 Experience

One native boat experience is served at both R4 (5384, primary entry) and R5
(5385). R4 imports this implementation and publishes this same asset catalog.
Worker async buoyancy is a readable mode in the shared settings panel, alongside
synchronous buoyancy and GPU/CPU WaterMesh. The same scene and source authorities
serve both URLs; both window evidence names reference one object.

Lake/Ocean materials reuse the Showcase porous foam texture author with real
Water contact/crest/scene-depth inputs. No white-sphere foam particle consumer
runs in this experience. Pontoon spheres remain hidden unless the explicit
advanced debug control is enabled.

The existing Water fluid feature consumes native Ocean pontoon contact events
into a 512-pixel history with 1.8/s coverage decay. Moving the Ocean craft emits
contact foam; stopping leaves the submitted history to decay. The material's
authored 100 m capture remains centered at world XZ zero. This current Engine
contact-history path accepts Ocean owners only: Lake shoreline foam uses scene
depth, and the Calm preset deliberately disables background waves. Head-on
waves enables the authored Gerstner field and its crest foam. No local-wave
simulation or hull-probe source is installed by this scene.

Startup applies the existing Head-on waves preset to the Ocean craft before
the first App frame. Its nonzero `waves/estuary` field moves the water surface;
the same scene-depth foam path used by Showcase responds to the changing
water/shore depth clearance. The porous texture is shared with Showcase.
Its power, boost, contrast and
neutral foam lighting use Showcase's authored response; crest amount is lower
for this sheltered harbor. Five directional waves span 4.8–18 m, with summed
amplitude 0.203 m and a conservative 0.23 m WaveSet height envelope. Default Q1
uses 32 quads per LOD0 edge and LOD scale 2.4; Q0–Q3 retain real source settings.
The mesh overlay remains opt-in. These changes require actual pixel acceptance.
Calm remains an explicit no-wave comparison, where fixed-camera
shoreline foam can remain static. Actual shoreline pixels still require browser
acceptance; enabling waves is not a claim of full fluid shoreline dynamics.

```powershell
pnpm --filter @forgeax/water-r5-gpu-mesh-async-pontoons dev
```

The default local URL is `http://127.0.0.1:5385/`. Build Engine inputs with
`pnpm build:engine` before starting a cold consumer. This app uses the public
`@forgeax/engine` facades, ordinary Pack/catalog assets and the existing Water
Scene plugin. It owns no substitute renderer, solver or water registry.

The mesh controls select CPU/GPU, supersampling, MSAA, four occlusion modes,
tessellation, camera height, wireframe, waves and multiple views. Stress scenes
exercise nine priority values and 127/128 intersecting bodies; 128 intentionally
shows the source admission failure. Buoyancy controls cover global/component
async gates, relative/socket anchors, 1/4/16 pontoons, force settings, cancellation,
reset/launch and root/Water generation replacement. Reset/launch commands execute
after Physics sync and before the force snapshot.

All crafts use `riverShoreFactor: 0`, retaining River current forces without
an authored lateral shore push. This configuration is valid for both synchronous
and Worker paths, including global/component async disable and cancellation.
The negative inward river-path recovery blend is specific to the async solver
and is not used by this experiment's switchable shared configuration.

`window.__waterR5.readState()` exposes submitted frame, renderer diagnostics,
current body dynamics and exact pontoon/solver state. `exportTraceJson()` retains
completed step history for external evidence. Optional RHI capture uses the App's
existing `rhiCapture` host; a tape supplements the fixed-step traces.

See the [Water](../../../packages/water/README.md),
[Physics](../../../packages/physics/README.md#solver-participants) and
[Render](../../../packages/render/README.md#gpu-water-mesh) contracts. Detailed
validation evidence and UE native numerical/pixel comparison limitations belong
in the external implementation documentation, not this app entrypoint.
The primary panel groups demonstration presets, hull/load, water conditions,
quality and camera. The default Ocean craft starts with its root at `y=0 m`;
Calm selects the Lake craft at that same root height.
Presets edit real Water assets and queue one native pose/velocity reset at the
fixed-step boundary:

| Preset | Source behavior | Observe |
|:--|:--|:--|
| Calm | Lake, no waves, no cargo, root at `y=0 m` | Waterline and draft under steady support |
| Head-on waves | Ocean, waves enabled, one heading and initial-velocity reset | Heave and roll under the selected execution path |
| Airborne return | Lake, waves enabled, one lift to `y=4 m` with zero velocity | Free fall and buoyancy recovery |
| Offset cargo | Lake, no waves, root at `y=0 m`, `25 kg` at starboard `z=0.45 m` | A stable list isolated from wave motion |

The shared boat controls add cargo mass to the RigidBody's `125 kg` additional
mass; native collider density contributes separately to accepted total mass.
Cargo uses local `[-0.9, 0.95, sideM]`. Equal/opposite point forces move its
existing gravity contribution from the native COM to that visible load, adding
roll/pitch torque without duplicate weight. They do not edit native COM or
explicitly author a new inertia tensor. The manual `180 kg` limit permits
extreme loading and possible capsize. The loaded preset's modest cargo does not
establish stability for all loads, waves or support layouts.

Motor and rudder sliders apply fixed-step native point forces; Stop clears the
commands and leaves inertia and Water drag intact. Q0–Q3 write actual Zone
subdivision, LOD and WaterInfo resolution. Shared snapshot-driven free camera
uses drag, WASD/arrows, E/Q/Space/Page up/down, Shift and wheel speed, with no
pointer capture or lock. Manual navigation leaves the follow view. Existing
control IDs and window evidence entrypoints remain available; `applyPreset`
and `cameraControls` supplement those entrypoints.

GPU/CPU selects the real Water mesh path. Global and per-craft async gates and
1/4/16 pontoons provide solver/load comparisons. Completed-frame FPS remains
receipt-derived. The CPU readout uses optional native-step timing when the
backend enables it; Worker timing and unavailable timing are explicitly marked
unavailable, and this readout is not total frame CPU or GPU duration.

Managed native writes, including wake and reset, belong after Physics sync and
before step; DOM handlers queue commands for that boundary. The backend refuses
ordinary native writes while a Worker is pending. Acceptance must check page
errors as well as renderer errors and completed-frame readiness: a ready picture
does not prove that an interaction's native command succeeded. The shared
controls' nearest R4 native tests exercise real motor/rudder forces and wet
offset-cargo support, while R5's Worker controls require their own browser journey.
