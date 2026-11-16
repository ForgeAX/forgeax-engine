# R8 native entry experiment

Run `pnpm dev` and open port 5388. This independent experiment mounts an Ocean
Body in a fixed 128 m WaterZone and a centered 64 m native OceanPatch beside an
asset-backed pier. The Zone boundary and simulation domain are independent. Drop
iron spheres using adjustable launch inputs, inspect native query/physics
receipts and compare GPU splash with the propagated local wave field. It shares
authored coastal materials and VFX with the integrated showcase but creates
its own World, camera, inputs and experiment scene.
Use the overview and entry close-up buttons to inspect the same simulation from
either the coastal scene or the impact point. The close-up keeps droplets and
the local wave footprint visible without changing launch or solver parameters.

`window.__waterR8Entry` exposes launch, query, entry and renderer facts. See
[Water](../../../packages/water/README.md) and
[VFX](../../../packages/vfx-render/README.md) owners.

The v2 recipe also publishes the independent visual normal FFT. Its authored
noise is an ordinary loaded texture dependency; the visible water material consumes
`visualNormal` through `NormalDetailTex`. Residual query/force/foam history stays
independent. The recipe form exposes both configurations and completion facts.
The visible native foam consumes `waterShallowFoamTexture` through the ordinary
shallow material branch, alongside residual normals and the separate visual FFT.
The fixed experiment surface uses its authored height, depth and zero flow,
while the native residual maintains its independent query and foam history.
Legacy static Ocean foam maps remain a different authored branch. Entry spray
uses the same admitted GPU particle program as the showcase.

The shared entry authoring maps actual sphere radius and normal incident speed
to a bounded local momentum impulse. If the native grid cannot resolve its
footprint, authoring spreads the Gaussian and reduces velocity to preserve its
deep-water wave-energy budget. Local gravity waves add to the background field;
spray controls do not change their budget. Crown, sheet breakup and droplets are
authored airborne approximations, while the native field propagates linear
finite-depth waves. A fully submerged sphere is hidden without retiring its
native physics. This scene does not depict underwater
impact dynamics or a complete fluid simulation.

Iron balls have no `WaterPontoonSet` or `WaterContactProbeSet`. The entry observer
samples the water surface only before its first recorded native entry. Afterward,
the current native sphere top crossing that recorded surface height hides the
ball permanently; visibility and observation reads do not sample water. Recording
entry removes `WaterShallowCollider`, ending native water actor gathering while
ordinary Physics `RigidBody` and `Collider` remain. Previously submitted wave
impulses continue independently. Each ball
observation derives `buoyancyParticipant`, `contactProbeParticipant` and
`shallowColliderParticipant` from its existing components, and `nativeEntryArmed`
from its native components and recorded entry.

The launch radius scales the paired 0.6 m mesh and collider exactly once through
the root Transform. The residual query age follows the Water owner's (0, 0.5]
second interval. Invalid age edits keep the accepted policy. Pause retains the
completed residual and child FFT histories; reset clears the local wave state
and retires launched bodies. Recipe fields and native/output facts are available
in the runtime form. Development servers support a real single-frame RHI capture
through `app.rhiCapture`, streamed to `FORGEAX_RHI_CAPTURE_ROOT` when configured.

The showcase-style panel groups launch, camera, wave response, quality and
advanced observations. Radius, height and launch velocity edit the one launch
source; four quality levels edit WaterZone resolution/tessellation and native
OceanPatch FFT resolution. The residual decay control edits waveDampingPerSecond.
WASD/arrows, drag look, E/Q, Shift and wheel use the shared frame-scanned camera;
no pointer capture or lock is acquired. Presets and the VFX camera read the same
pose. Completed-ready receipts drive the visible FPS and entry count.

The short-lived splash effect separately queries its surface attachment through
`WaterSystem.queryBody`, with the presentation wave clock and completed native
residual clock. Its bounded region uses the existing OceanPatch query owner,
without a force receiver or a ball probe. Crown and tongue roots follow the
current surface offset; a droplet transfers its edge position and velocity once
at release, then retains its own ballistic GPU state. Missing residual samples
retain the valid base-wave surface until completion.
