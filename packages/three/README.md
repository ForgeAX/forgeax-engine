# Three.js objects on the Forgeax renderer

`@forgeax/engine/three` targets **Three.js 0.184.0 `WebGPURenderer`, using WebGPU**.
It reuses Three's CPU objects and projects them into Forgeax Scene, Geometry,
Material, Skin and managed assets. Forgeax owns the render graph, GPU submission,
resource lifetime and RHI capture. The package does not ship a Three GPU renderer
or a runtime shader compiler.

This is a bounded compatibility surface, not complete Three conformance. See
COMPATIBILITY.md for defaults, supported source operations,
measured rendering differences and the specific native contracts still missing.
WebGL backends and their exclusive interfaces are outside the target. Addon
expansion is deferred; the existing OrbitControls and GLTFLoader paths remain.

## Use

Install `@forgeax/engine` and add its shader plugin to the application's Vite
configuration:

```ts
import { defineConfig } from 'vite';
import { forgeaxShader } from '@forgeax/engine/vite-plugin-shader';

export default defineConfig({ plugins: [forgeaxShader()] });
```

Ordinary Three authoring code keeps its object model:

```ts
import * as THREE from '@forgeax/engine/three';

const renderer = new THREE.WebGPURenderer({ canvas });
await renderer.init();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, canvas.width / canvas.height, 0.1, 2000);
camera.position.z = 5;
scene.add(new THREE.Mesh(
  new THREE.BoxGeometry(),
  new THREE.MeshStandardMaterial({ color: 0x55ccaa }),
));
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.position.set(2, 3, 5);
scene.add(sun);
await renderer.setAnimationLoop(() => renderer.render(scene, camera));
```

Rendering requires HTTPS or localhost. `init()` admits the renderer and packaged
native material programs. Subsequent asset preparation can still be pending;
`renderer.inspect().receipt.presentation` reports readiness. `render()` submits
synchronously and does not advance an AnimationMixer or simulation clock.
`renderAsync()` additionally admits borrowed GPU/video texture inputs before
submitting. Video inputs require `texture.colorSpace = THREE.SRGBColorSpace`.

Additional Physical texture combinations use the build-only `cookPhysicalMaterials()`
entry and `forgeax.materialPrograms`; the exact recipe workflow and bundled sets are
listed in COMPATIBILITY.md.

The source objects own their mutable state. Use ordinary `needsUpdate`, geometry
attributes, material properties, skeleton poses, morph weights and disposal.
Source skinning for lit materials and instance expansion for per-instance colors,
morphs and BatchedMesh trade CPU work and upload memory for compatibility. They
are not claims of Three's instancing performance. Native Skylight continues to own
both diffuse environment lighting and reflections.

## Pending textures and shadows

`TextureLoader.load()` returns immediately. Rendering continues while its image
is pending, using the WebGPU zero placeholder for a first upload or the last
admitted bytes for an existing texture. A network failure reaches the loader's
`onError`; it does not turn a missing image into a renderer exception. Invalid
ready texture formats still report structured errors.

```ts
const texture = new THREE.TextureLoader().load('/albedo.png', undefined, undefined,
  (error) => console.error('Image download failed', error));
texture.colorSpace = THREE.SRGBColorSpace;
material.map = texture;
// For later direct image/data edits:
texture.needsUpdate = true;
```

`Texture.version` controls admission. Assigning `image` or setting
`source.dataReady` alone does not upload new pixels. `texture.onUpdate` runs when
the version is admitted to a ready native submission.

Shadows remain off until explicitly enabled:

```ts
renderer.shadowMap.enabled = true; // PCFShadowMap by default: five Vogel taps
sun.castShadow = true;
mesh.castShadow = true;
ground.receiveShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = sun.shadow.camera.bottom = -5;
sun.shadow.camera.right = sun.shadow.camera.top = 5;
sun.shadow.camera.updateProjectionMatrix();
```

Directional shadows use the authored shadow camera. Point and spot shadows,
Basic/PCF/PCFSoft/VSM selection, shadow side/layers, bias, normal bias, radius,
intensity and manual `autoUpdate`/`needsUpdate` project to the native renderer.
As in r184, point lights use Vogel filtering for every non-Basic selection.
Native Forgeax CSM defaults and the Game3D template's shadow distance are unchanged.

## Inspect and compare

```ts
const capture = await renderer.captureFrame(scene, camera);
const { renderer: nativeState, sources, receipt } = renderer.inspect();
await renderer.dispose();
```

Capture requires a ready scene and preserves the actual native RHI commands,
resources, source identities and submitted output. It does not capture Three's
reference renderer. The browser fixtures compare against a separate, actual r184
WebGPU renderer and replay the native capture on a fresh device.

```sh
pnpm --filter @forgeax/engine-three build
pnpm --filter @forgeax/engine-three typecheck
pnpm --filter @forgeax/engine-three test
pnpm --filter @forgeax/engine-three example
node packages/three/scripts/audit-api.mjs --output artifacts/three-compat/api-audit.json
```

The API inventory reports names and TypeScript admission, including unsupported
native-dependent surfaces. It is not a compatibility percentage. Its full-surface
`--check` remains deliberately red while those interfaces are missing.
