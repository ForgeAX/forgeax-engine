# Three.js compatibility layer (in development)

`@forgeax/engine/three` targets complete Three.js r184 public functionality. The
current implementation runs an initial subset of authoring code on
Forgeax's Renderer. It reuses the pinned Three CPU classes and projects their
cached world matrices into ordinary affine Scene components and shared assets in a private World.
Rendering, shader preparation, GPU submission, recovery and RHI recording stay
with their existing engine owners. No Three WebGL/WebGPU renderer ships in the
compatibility module's JavaScript closure.

The full compatibility target includes ordinary shaders used internally by
official addons. Only user custom shaders, `onBeforeCompile` and direct WebGL
access may require migration. See the [complete contract and measured gaps](COMPATIBILITY.md).
This experimental entry does **not** yet meet that target. Forgeax feature coverage does not establish Three behavioral
compatibility. Each supported input still needs renderer and migration tests.

## Quick start

Until this entry ships in an SDK release, use a source build containing this
prototype. Applications consume `@forgeax/engine`, not physical owner packages.
Use the engine shader Vite plugin in the project's existing Vite configuration:

```ts
import { defineConfig } from 'vite';
import { forgeaxShader } from '@forgeax/engine/vite-plugin-shader';

export default defineConfig({ plugins: [forgeaxShader()] });
```

Then change the application imports:

```ts
import * as THREE from '@forgeax/engine/three';
import { OrbitControls } from '@forgeax/engine/three/addons/controls/OrbitControls.js';

const renderer = new THREE.WebGLRenderer({ canvas });
await renderer.init();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, canvas.width / canvas.height, 0.1, 100);
camera.position.z = 5;
scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ color: 0x55ccaa })));
const controls = new OrbitControls(camera, canvas);
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
```

`setAnimationLoop` starts after initialization. An application with its own
`requestAnimationFrame` loop must await `init()` first. `render()` samples and
submits synchronously, returns `void`, and never advances a World clock or an
AnimationMixer. Asset and pipeline preparation may produce a receipt whose
`presentation` is pending; `renderer.inspect().receipt` exposes this fact.
`init()` prepares the renderer and admits the package-built Unlit, Standard and
numeric and base-color Physical programs, not every future scene. Runtime
clearcoat edits reuse these programs. Base-color maps are prepared for
Standard/Lambert and Physical; other physical texture combinations still need
further program coverage.

The prototype selects browser WebGPU explicitly and needs HTTPS or localhost.
The advanced
`forgeax.backend` construction option accepts an existing recordable engine
backend. It does not silently select WebGL. Context injection, alpha canvas
compositing, XR, raw WebGL APIs, partial clears, render targets and custom
viewport/scissor sequences are outside this version.
The adapter owns its native Forward output pipeline; `forgeax.renderer.pipeline`
is not a construction option.

Run the repository example with
`pnpm exec vite packages/three/example --config packages/three/example/vite.config.ts`.
Build engine packages first with `pnpm build:engine`.

## Supported surface

| Area | Prototype contract |
| --- | --- |
| CPU authoring | All 441 root runtime exports from pinned r184; GPU-facing exports still need behavioral adapters. |
| Objects | Scene, Group, Object3D and rigid Mesh; cached automatic/manual affine matrices (including shear), reparenting, shared resources, remove/re-add, names. Ordinary Object3D roots and externally parented camera caches are preserved; singular matrices remain unsupported. |
| Visibility | Inherited `visible` and per-object camera layers; material visibility. Mixed visible/invisible material arrays are rejected. |
| Cameras | Perspective and orthographic, including zoom through the cached projection matrix. Call `updateProjectionMatrix()` after edits. View offsets and film offsets use native two-axis lens offsets. Finite far and positive near are required; arbitrary custom projective matrices remain unsupported. |
| Geometry | Triangle lists, indexed/unindexed, position/normal/UV0–UV7/tangent/color, interleaved and normalized attributes, drawRange, material groups. Normals are required; call `computeVertexNormals()` when absent. |
| Materials | Basic, Standard, Normal, Lambert, textured Matcap and Physical clearcoat pass their reference fixtures. Remaining Physical combinations are incomplete. Depth/cull/blend state and alpha test are projected. |
| Canvas output | Normal data colors, ordinary `toneMapped=false`, ACES/Reinhard exposure (including zero), encoded transparent blending and MSAA pass mixed-scene references and replay. Fog, premultiplication, dithering, target output and official post-processing remain incomplete. |
| Textures | Loaded RGBA8 images, DataTexture and CanvasTexture; color space, flipY, generated mipmaps, ordinary filters/wrapping. UV set 0 with identity transform; anisotropy 1. |
| Lights | Additive ambient and unshadowed directional, point and spot lights. Spot target, angle, penumbra, power and finite distance edits use native lighting. Spot decay currently requires 2; projector maps remain incomplete. Standard material without light is dark. |
| Addons | OrbitControls and the pinned GLTFLoader entry. Loader output must satisfy the same renderer admission rules. Static assets with supported materials can migrate; skin, morph, compressed textures and advanced material extensions need further adapters. |
| Debug | Native Renderer inspection, real frame receipt, standard RHI tape capture and detached source UUID → entity mapping. |

The root export surface follows upstream. Rendering support is measured separately.
Unsupported ordinary features throw `ThreeCompatibilityError` with code
`three-unsupported`; only custom shaders and native WebGL use
`three-migration-required`. The error includes `detail.subject`, optional source
`uuid`, and `hint`. Native engine failures retain their owning error. Successful
import, construction, serialization or glTF decode does not establish GPU support.
The complete interface audit is available through `pnpm --filter
@forgeax/engine-three audit:api`; its `--check` mode is intentionally red.

Await `TextureLoader.loadAsync()` before attaching a texture in this prototype.
Texture and geometry byte edits follow Three's `needsUpdate` / version contract;
ordinary material scalar/color edits are sampled each render. `dispose()` on a
source resource invalidates its cached projection; reusing it creates a fresh
native resource. Shared materials remain shared. Static source frames reuse
asset handles and compare projected component values with World storage before
publishing changes. Failed resource preparation releases provisional leases and
preserves the accepted scene bindings. Texture pixels are copied on update, so this is not a streaming
video or zero-copy texture adapter.

## RHI Debug

After at least one ready frame:

```ts
const capture = await renderer.captureFrame(scene, camera);
// capture.tape.bytes is an ordinary .rhitape accepted by engine/rhi-debug.
// capture.sources maps Three uuid/name/type to this projection's entityKey.
// capture.observation contains only the evidence returned by native Renderer.observe.
```

Capture pauses callbacks from this renderer's animation loop, snapshots the
source input once, and submits that exact projection through the same native
render path. Concurrent render/capture and resize calls fail with `renderer-capture-busy`.
Cancellation uses `CaptureFrameOptions.signal`; disposal aborts capture and
releases the native lease, resources and recorder. Await `renderer.dispose()`
when teardown completion matters.

The prototype uses the native direct geometry lane for ordinary and captured
frames. Draw-to-pipeline observations can be unavailable, and multiple objects
can share one pipeline; UUIDs are not fabricated workIndex identities. The tape
is authoritative for actual GPU work and can be opened on a fresh RHI replay
device. A Three project captured here shows how **Forgeax** renders its adapted
scene; it does not record the original Three WebGL renderer's internals.

## Ownership and next increments

The adapter samples Three's existing world-matrix cache into flat native affine entities, preserving frozen matrices without a second hierarchy evaluation. Scene owns their derived matrices. The adapter owns the author-object → entity map and current shared-reference
leases. Scene owns derived matrices, World owns component identity, and Render
owns asset residency and GPU lifetime. It creates neither a second GPU cache nor
a separate capture format. There is one pinned Three constructor family across
the facade and bundled addons. Importing another installed Three build alongside
it can introduce a second family and is outside the compatibility contract.

The [native design boundary](COMPATIBILITY.md#native-design-boundary) keeps source
callback interpretation and mutable Three state in this package. Native components
and render plans remain explicit data; the adapter reads shared payloads and current
material admission from their existing owners.

The [implementation contract](COMPATIBILITY.md) records required native owner
changes, the exact migration exceptions, remaining API families and measured
reference cases. Missing ordinary features remain obligations; the initial
supported subset is not the final scope.

The architecture and longer-term compatibility criteria are recorded in the
[design proposal](https://github.com/ForgeaX-Games/forgeax-engine/blob/31d277eaa96aea1811dac263493d5a8f526bbbd1/packages/runtime/docs/threejs-compatibility-design.md).
Bundled upstream CPU/addon code is MIT licensed; retain [LICENSE-THREE](LICENSE-THREE).

## Open-source migration sample

The [Rubik migration harness](migrations/rubiks-cube/README.md) builds the pinned
MIT-licensed `HichemTab-tech/RubiksCube-threejs` application against original
Three r184 and this public entry. Its game source remains unchanged. Ambient
lighting and the Standard/Lambert base-color program were implemented in response
to its real first-frame failures. This is a concrete migration sample, not proof
of the complete public compatibility contract.
