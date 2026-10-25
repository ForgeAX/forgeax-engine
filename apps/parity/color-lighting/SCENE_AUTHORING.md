# One scene, two authoring APIs

Read the complete [Three.js program](src/scene-authoring/three-scene.mjs) and
[ForgeaX program](src/scene-authoring/forgeax-scene.mjs), or open
`scene-authoring.html` for live canvases, controls, source and downloads.
The shared page hosts the programs; each program constructs its own geometry,
materials, scene, camera, lights, effects, frame loop and normal cleanup.

## Workload and scope

Both render a ground slab, blue box, copper sphere and emissive sphere through
WebGPU. Dimensions, sphere segments, positions, sRGB material colors,
metalness/metallic, roughness, emissive intensity and light values are explicit.
The camera is 45 degrees, near 0.1, far 40; ForgeaX takes radians. Both use
exposure 1, sRGB output, three practical CSM cascades, 1024² maps, range 40,
five-tap PCF and no cascade fade.

The default has no post-processing. The selector adds ACES + FXAA, then Bloom
before ACES. Bloom strength is 1, threshold 1, radius 0 and smooth width 0.01.
Threshold 1 matches the engine default; strength 1 is an explicit scene choice
(the engine default intensity is 0.5).
The shadow control toggles reception while preserving casters in both engines.
Camera switching, resizing and disposal/recreation are included.

The optional ambient diagnostic is off in the matched scene: Three.js
AmbientLight and ForgeaX solid Skylight do not represent the same function.
GTAO, textures, asset loading, animation and IBL prefilter quality are outside
this example. This is not a performance benchmark or complete parity claim.

## Code comparison

| Concern | Three.js r184 | ForgeaX | Meaning |
|:--|:--|:--|:--|
| Bootstrap | renderer, `init`, Scene | `createApp`, World, bundler adapter, Result | App assembles more services; shader publication is an extra author concept. The RHI import explicitly pins WebGPU for this comparison. |
| Renderable | `Mesh(geometry, material)`, position, `scene.add` | Transform, MeshFilter, MeshRenderer, two asset handles, `world.spawn` | App's AssetRegistry owns geometry/material content; ECS binds its handles. |
| Material | `color`, `metalness`, `roughness` | `baseColor`, `metallic`, `roughness` | Similar operation with different vocabulary; both accept sRGB hex. Neither needs manual shader/pass authoring. |
| Camera aim | `camera.lookAt(target)` | `quat.fromLookAt(out, eye, target, up)` + Transform write | ForgeaX exposes quaternion allocation and repeats the camera position. |
| Directional light | position + target | outgoing direction | ForgeaX needs no positional entity, but copying the light position as its direction reverses illumination. |
| CSM | renderer flag, light flag, CSMShadowNode, assignment, resize update | light flag and fields | ForgeaX removes addon and camera-maintenance wiring. Bias sign, slope/texel coverage and fitting still differ. |
| Mesh shadows | cast/receive opt-in | cast/receive default true; component overrides | Matching the light default alone does not match the full workflow. ShadowParticipation is explicit here for the toggle. |
| Post-processing | scene pass → color + Bloom → output transform → FXAA → RenderPipeline | camera tonemap, antialias and Bloom fields | ForgeaX removes ordering and color-space decisions for built-in effects. Three exposes a composable node graph. |
| Resize | observer, DPR, extent, aspect/projection, CSM frustums | App + camera auto-aspect | These savings belong to ForgeaX, not to the shared comparison page. |
| Lifetime/errors | dispose meshes, effects, renderer and observer; promises/exceptions | App disposal; Results at construction/mutation | Extra unwrap calls buy structured failure; App removes most normal cleanup wiring. Failure-path equivalence is not established. |

The ForgeaX program takes `assets` from its App and keeps these scene assets
until App disposal. These excerpts come from the runnable programs:

```js
// Three.js
const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial(parameters));
mesh.position.set(...position);
mesh.castShadow = true;
mesh.receiveShadow = true;
scene.add(mesh);
```

```js
// ForgeaX
world.spawn(
  { component: Transform, data: { pos: position } },
  { component: MeshFilter, data: { assetHandle: assets.create(geometry).unwrap() } },
  { component: MeshRenderer, data: {
    materials: [assets.create(Materials.standard(parameters)).unwrap()],
  } },
  { component: ShadowParticipation, data: {} },
).unwrap();
```

## Size and similarity

The verifier measures the complete modules, including imports, scene data,
diagnostic controls and cleanup. Both use the same Biome formatting. The shared
page, Vite config and verification code are excluded and disclosed above.

| Metric | Three.js | ForgeaX |
|:--|--:|--:|
| Imported modules | 5 | 7 |
| Lines containing code tokens | 132 | 164 |
| JavaScript lexical tokens | 995 | 957 |

Lexical tokens come from TypeScript's scanner without whitespace/comments;
they are not LLM tokens or an implementation similarity score. ForgeaX has more
formatted lines but fewer lexical tokens. Post-processing and lifetime savings
offset verbose entity creation. A single percentage conceals where the user has
to make decisions; neither figure establishes that one API is universally simpler.

## Ambient is a semantic mismatch

The optional diagnostic sets AmbientLight and Skylight intensity to 0.3.
AmbientLight adds diffuse irradiance and a Lambert response. Solid Skylight
adds a flat diffuse and specular environment. Matching numbers is insufficient.
The original RHI capture read white irradiance/prefilter cubes and a constant
BRDF LUT `[1, 0]`. That LUT is historical: #4126 replaced it with the shared
r184 DFG data; see [environment response](ENVIRONMENT_RESPONSE.md). The
AmbientLight/Skylight semantic difference remains intentional.

See `packages/render/src/ibl/skylight-bind-group.ts` and
`packages/shader/src/standard-lighting.wgsl`, versus Three's AmbientLightNode
and PhysicalLightingModel.indirectDiffuse. The default matched scene leaves
this diagnostic off. Remaining pixel differences are recorded without an
unproven shader attribution. Whole-canvas RGB means include the background and
can conceal concentrated shadow/edge errors.

## Questions worth resolving

1. Can the existing authoring boundary derive registry-owned asset handles from
   geometry/material values, without adding a second registry or scene graph?
2. Can author-facing camera settings use semantic values such as `fxaa` and
   `acesFilmic`, while retaining one numeric ECS representation?
3. Can `assetHandle`/`materials`, color/metallic names, direction and
   ambient-versus-environment semantics become consistently discoverable,
   without introducing compatibility aliases?
4. Can camera aiming derive its quaternion from the existing Transform position?

Preserve CSM camera following, built-in effect order, auto-aspect and App cleanup.
They remove real author decisions; copying Three's extra wiring would not help.

## Reproduce

From the repository root with current package outputs available:

```sh
pnpm --filter @forgeax/parity-color-lighting dev --host 127.0.0.1 --port 4277
node apps/parity/color-lighting/scripts/verify-scene-authoring.mjs
pnpm --filter @forgeax/parity-color-lighting typecheck:scene-authoring
```

The verifier captures direct, shadow-off, ambient-diagnostic, post, Bloom,
opposite-camera, resized and recreated states. It waits on native GPU queues
and stable screenshots, rejects empty output/browser errors, checks controls
change pixels and checks reconstruction. Cross-engine differences are recorded
without a global parity threshold. Chromium retains its sandbox; ANGLE and
Vulkan use SwiftShader for the local software path.

Build with this app's `build`, run `preview`, then pass the built page URL and
an output directory to the verifier. No models or asset Cook step are needed.
`FORGEAX_ENGINE_RHI_DEBUG=1` on the dev command enables actual-frame capture
through `globalThis.__forgeax.captureFrame()`.
