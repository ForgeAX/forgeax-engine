# SSAO: contact and room scenes

One 12-unit plane and one two-unit cube share an untextured Standard material.
The fixed camera, Skylight, and dim point light isolate contact occlusion.
There are no baked AO maps or directional shadows in the default scene.

The **Room** link (`?scene=room`) adds two thin walls, a thin pole, two fragments
and a four-cascade directional light. AO and PCF3/PCF5/PCSS medium/high remain
independent controls; angular radius changes the soft shadow penumbra. Camera,
exposure and light intensity stay fixed during filter comparisons.

```bash
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-9-ssao dev
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-9-ssao smoke:discrimination
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-9-ssao smoke:browser:pair
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-9-ssao smoke:performance
```

| Control | Expected observation |
|:--|:--|
| AO toggle | Contact edge darkens; the broad open plane stays clear |
| Strength zero | Same pixels as disabled AO |
| Cube lift | Contact occlusion decreases beyond the selected radius |
| Quality | 16 / 32 / 64 samples; same spatial meaning, different sampling cost |
| Radius | Changes the local neighborhood in scene units |

The browser check toggles the public profile, reads final pixels, lifts and
restores the cube, removes/reinserts its renderer, and replays the same captured
frame on Dawn. Removing the occluder must remove its contact AO immediately;
reinserting it must restore the original pixels. The room browser journey separately toggles AO and shadows, compares PCF with
PCSS, moves the pole, removes/reinserts a wall and moves/restores the camera.
Each restore must recover the original pixels; 60 stationary frames must stay
identical and retain GPU-driven submission. `smoke:browser` runs both journeys.
Native
`smoke:discrimination` submits 60 real frames per state. The shader-level Dawn
gate independently covers an unoccluded tilted plane, orthographic projection,
near contact, distant silhouettes, background, and bilateral edge rejection.
The performance command reports GPU pass-boundary p50/p95 over 60 measured
frames per quality after 15 warmup frames. Disabled AO must execute zero AO
passes. GPU pass intervals can overlap and must not be added as frame latency.

## Three.js reference

The review used Three.js **r186** with the same plane/cube sizes, camera
`[3, 3, 6]` looking at the origin, 45-degree perspective, and radius `0.5`.
It compared the official [SSAOPass](https://threejs.org/docs/pages/SSAOPass.html)
and [GTAOPass](https://threejs.org/docs/pages/GTAOPass.html), including AO-only
output and lifting the cube. The geometric expectation is a local contact
band, a clear open plane, and reduced contact after separation. These are
spatial comparisons, not pixel parity: the integrators, blur, and ambient
composition differ. Three.js describes GTAO as higher quality and higher cost;
this Engine change repairs and bounds the existing hemisphere SSAO algorithm.

For dynamic environments, the reference is
[CubeCamera.update](https://threejs.org/docs/pages/CubeCamera.html): capture the
surrounding scene into a cube, then use it for reflection. Engine ReflectionProbe
adds automatic update intent, bounded scheduling, filtering, and atomic
publication; its 36-step latency is explicit in the Render contract.
