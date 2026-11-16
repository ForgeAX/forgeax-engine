# Water R5 GPU Mesh and Async Pontoons

A Chinese-language interactive estuary with River, Lake and Ocean crafts,
saved GPU WaterMesh settings and real Worker solver buoyancy. The first screen
is the running experiment. Use the mesh, buoyancy and observation tabs to inspect
the public runtime state.

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

`window.__waterR5.readState()` exposes submitted frame, renderer diagnostics,
current body dynamics and exact pontoon/solver state. `exportTraceJson()` retains
completed step history for external evidence. Optional RHI capture uses the App's
existing `rhiCapture` host; a tape supplements the fixed-step traces.

See the [Water](../../../packages/water/README.md),
[Physics](../../../packages/physics/README.md#solver-participants) and
[Render](../../../packages/render/README.md#gpu-water-mesh) contracts. Detailed
validation evidence and UE native numerical/pixel comparison limitations belong
in the external implementation documentation, not this app entrypoint.
