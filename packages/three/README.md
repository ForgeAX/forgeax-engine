# Three.js objects on the Forgeax renderer

`@forgeax/engine/three` targets **Three.js 0.187.0 `WebGPURenderer`, using WebGPU**.
It reuses Three's CPU objects and projects them into Forgeax Scene, Geometry,
Material, Skin and managed assets. Forgeax owns the render graph, GPU submission,
resource lifetime and RHI capture. The package does not ship a Three GPU renderer
or a runtime shader compiler.

This is a bounded compatibility surface, not complete Three conformance. See
COMPATIBILITY.md for defaults, supported source operations,
measured rendering differences and the specific native contracts still missing.
WebGL backends and their exclusive interfaces are outside the target.
GPU-dependent addon expansion is deferred. The 88 public CPU addon subpaths share
the facade's original constructor family and import no native renderer or cooked
material programs. They include the existing OrbitControls, GLTFLoader,
BufferGeometryUtils, SkeletonUtils and MeshSurfaceSampler, plus:

- RoundedBoxGeometry, ParametricGeometry, ConvexGeometry, BoxLineGeometry and TextGeometry.
- FontLoader, STLLoader, PLYLoader and XYZLoader (synchronous parse returns BufferGeometry).
- OBB, Octree, ConvexHull, Capsule, ImprovedNoise, SimplexNoise, CurveExtras and SceneUtils.
- EdgeSplit/Simplify/Tessellate modifiers, DecalGeometry, ParametricFunctions and TeapotGeometry.
- OBJ/MTL/HDR loaders and OBJ/STL/PLY exporters; PLYExporter returns data synchronously without a callback.
- AnimationClipCreator, CCDIKSolver, CameraUtils, ColorUtils, GeometryUtils, Lut and normal/tangent/Octree helpers.
- FBX/SVG/BVH/PCD/VTK/MDD/PDB/NRRD loaders, TGA/DDS/KTX/EXR/IES and Cube/3DL LUT loaders.
- NURBSCurve/Surface/Volume/Utils, LoftGeometry, ConvexObjectBreaker, ColorConverter, ColorSpaces and SortUtils.
- Arcball/Drag/FirstPerson/Fly/Map/PointerLock/Trackball/Transform controls and SelectionBox/SelectionHelper.
- Collada/3MF/AMF/VOX/TDS/VRML/GCode/RGBE loaders, GLTFExporter, AnimationPathHelper and SceneOptimizer.

Import each through `@forgeax/engine/three/addons/<category>/<name>.js`.
Generated geometry uses the existing native topology and material admission.
Points transport RGB/RGBA vertex colors through the existing native point tint
stream, including normalized attributes, source color revisions and color-enable
changes. PointsNodeMaterial retains the same supported uniform/reference inputs.
Lines still reject per-vertex colors; Lines/Points source UV and point-coordinate
texture paths remain unsupported. Octree and OBB are CPU queries, not native physics bodies.
OBJ/MTL keep their original Phong CPU materials; select a supported native material
explicitly for rendering. HDRLoader parsing does not install environment lighting
or PMREM. Modifiers, exporters, clip generation and CCD IK run only when called;
there is no implicit worker, animation tick, helper render or per-frame export.
SimplifyModifier retains its original embedded meshoptimizer WASM initialization
and readiness; await modify(). It is not installed in the frame loop.
Exporters retain upstream format limits; binary STL and PLY are round-trip tested.

FBX preserves its original CPU scene, skeleton and material data; select supported
native materials explicitly. SVG path parsing requires a real DOMParser; shape
geometry then uses ordinary native mesh projection. BVH/MDD data, NRRD volumes,
IES textures, LUT descriptors and color-space definitions do not install native
animation, volume, lighting or post-processing systems. DDS/KTX compression still
needs the existing native format/device capability admission. ConvexObjectBreaker
produces CPU meshes and writes their userData; it creates no physics bodies.

VTKLoader.parse accepts ArrayBuffer without a path (the upstream r187 loader is
deprecated and its format sniff expects at least 250 bytes). NRRDLoader.parse also
consumes ArrayBuffer; setSegmentation returns void. Its field parser helpers are
module-private. ColorConverter.getHSV writes h/s/v to the caller's original target.
ConvexObjectBreaker outputs nullable Mesh fragments, and radixSort accepts
Uint32Array with matching caller-owned scratch. These declarations retain the
original runtime identities. Network loading,
arbitrary files and native LUT/volume/IES consumption are not new acceptance claims.

Controls retain upstream DOM listeners and explicit updates. FlyControls and
FirstPersonControls require `update(deltaSeconds)`. Dispose controls when their
canvas is retired; Arcball keeps upstream optional inertia animation. No extra
Engine frame driver or View editor is installed. PointerLock movement is tested;
browser lock permission is not. TransformControls attach/mode state is available,
but its helper uses nonfinite renderOrder and remains rejected by native admission.
SelectionHelper needs an HTMLCanvasElement host (`{ domElement: canvas }`), not a
WebGLRenderer or OffscreenCanvas. SelectionBox remains a CPU frustum query.

Collada/AMF/3MF parsing requires DOMParser; loaded materials retain upstream
models, so select supported native materials explicitly. AMF units are converted
to millimeters by its original loader. VOXLoader.parse can return undefined, and
its result.scene can be null for files without scene nodes; use chunks/buildMesh
for those files. RGBELoader retains its deprecated HDRLoader alias behavior.
AnimationPathHelper uses UUID position tracks; line/points may be absent if no
track matches. Its existing Line/Points children render through native projection.
GLTFExporter retains original FileReader and injected compressed-texture utilities;
only texture-free JSON/GLB round trips are newly verified here. SceneOptimizer
explicitly rewrites the source scene and disposes replaced meshes/assets. Its
BatchedMesh result uses the existing CPU expansion route, not native GPU instancing;
this export is not a frame-time improvement claim.

`setRenderTarget(null, face, mip)` retains default-framebuffer selection metadata:
face is an integer from 0 to 5 and mip is a nonnegative safe integer. Omitting them
resets both to zero; RendererUtils save/restore preserves them. They select no GPU
subresource on the default framebuffer. Non-null RenderTargets remain unsupported.

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

The build entry also exports `physicalTextureRecipe(material)` to inspect the
exact authored map set with the same normal-over-bump selection as the player:

```ts
import { cookPhysicalMaterials, physicalTextureRecipe } from '@forgeax/engine/three/build';
const publication = await cookPhysicalMaterials([physicalTextureRecipe(material)]);
// Supply this build-produced string through forgeax.materialPrograms.
```

`Scene.fog` supports `Fog` and `FogExp2` through the existing native view-depth
laws, including source edits, removal and per-material `fog = false` changes.
The compatibility fixtures compare opaque and blended output against r187,
including unpremultiplication before tone/color conversion and premultiplication
afterward. Authored clear colors use the same premultiplied coverage law.

The source objects own their mutable state. Use ordinary `needsUpdate`, geometry
attributes, material properties, skeleton poses, morph weights and disposal.
Source color morphs rebuild existing vertex-color bytes only when geometry,
targets or weights change; RGB/RGBA and relative/absolute targets retain source
data. They currently require ordinary Mesh color attributes; per-instance color
morphs remain explicit gaps. Source skinning for lit materials and instance
expansion for per-instance colors,
morphs and BatchedMesh trade CPU work and upload memory for compatibility. They
are not claims of Three's instancing performance. Native Skylight continues to own
both diffuse environment lighting and reflections.

## CPU addons and Matcap coverage

Import the supported CPU utilities through the public facade. Their ordinary
upstream APIs are retained; no renderer, World synchronization or shader compiler
is created by these imports.

```ts
import { mergeGeometries, mergeVertices } from '@forgeax/engine/three/addons/utils/BufferGeometryUtils.js';
import { clone } from '@forgeax/engine/three/addons/utils/SkeletonUtils.js';
import { MeshSurfaceSampler } from '@forgeax/engine/three/addons/math/MeshSurfaceSampler.js';
```

Merged geometry can be used directly in a Three Mesh. SkeletonUtils clones the
bone hierarchy and rebinds the cloned Skeleton; geometry and material remain
shared as in r187. MeshSurfaceSampler writes to caller-owned vectors/colors/UVs.
Rebuild its distribution after in-place position/weight edits; create a new
sampler after replacing the geometry or attribute objects.

`MeshMatcapMaterial.alphaMap` uses ordinary UVs (including channels, transforms
and wrapping), the r187 red-channel coverage rule and existing native alpha
bindings. The Matcap sphere texture retains its independent lookup and ignores
its image alpha. Alpha-map image/version edits, alpha testing, blending and
removal follow the normal texture/material lifetime. If one source texture is
used for both lookups, the existing two orientation variants are retained only
while referenced. No new native shader, binding slot, pass or per-frame compiler
is added. Matcap color, normal, bump and displacement maps, Basic AO/light maps,
and the other deferred material inputs remain explicit compatibility gaps.

CPU-backed `RedFormat` textures follow r187 scalar sampling: color slots expand
R to RGB with opaque alpha, vector/data slots splat R to all four components,
and scalar R-only slots retain compact storage. Upload variants share existing
orientation caches and samplers and retire with their actual material uses.
Expansion runs only on source revisions and only for a used role; those variants
consume RGBA storage. Borrowed external textures must already have the required
RGBA layout because their GPU bytes are not read back for conversion.

## Explicit texture preparation

After `await renderer.init()`, `renderer.initTexture(texture)` prepares a
CPU-backed 2D texture through the same native asset/residency cache as drawing.
`await renderer.initTextureAsync(texture)` also initializes the renderer and
continues to admit borrowed GPU/video sources. This prepares texture storage;
it does not compile scene materials or promise a ready first scene frame.

Unchanged texture versions reuse storage; `needsUpdate` admits new bytes. The
call submits no scene or hidden frame. Generated mips submit only this texture's existing native blits and retain its allocation through queue completion. Ordinary no-mip uploads use queue writes only. An explicit init
retains its source lease across scenes until texture disposal is observed by
synchronization, or renderer disposal. `onUpdate` runs after successful ready
image admission and does not repeat on an unchanged draw. Raw eager storage is
shared with ordinary UV uses; scalar/vector or Matcap orientation variants are
still built only when actually needed. Unsupported shapes/formats stay explicit.

## Core interfaces in r187

| Interface | Supported behavior | Boundary |
|:--|:--|:--|
| `initTexture` / `initTextureAsync` | Explicit CPU texture residency, source versions, update callbacks and disposal/reinitialization | Shares the native owner; pending images, role variants and pipeline readiness retain their own contracts |
| `IESSpotLight` | Original constructor, copy/clone, ordinary untextured spot lighting and edits | iesMap and projector maps remain rejected; ProjectorLight rectangular attenuation is deferred |
| Node descriptors / diagnostics | Original NodeAttribute, NodeCode, NodeFunctionInput, NodeUniform, NodeVar, NodeVarying, NodeError and StackTrace objects | Data and error handling only; no runtime node compiler or native graph conversion |
| Node parameter types | Original declaration-only parameters, JSON, context, scope and event interfaces | Parameters alone do not imply native shader-graph support; the model subset below owns its actual behavior |
| `BundleGroup` | Ordinary Group hierarchy, visibility, transforms and source edits | Native automatic bundle reuse owns submission; Three's explicit static bundle cache is not reproduced |
| `QuadMesh` | Shared fullscreen triangle, material replacement, `render` and `renderAsync` | Uses supported ordinary Material and plain NodeMaterial families; authored node/TSL effects remain unsupported |
| Storage buffer attributes | Original constructors, count/typed-array forms, updates, ordinary geometry/index/instance inputs | CPU-backed authoring; no compute, indirect GPU submission or GPU writeback |
| `BlendMode`, node constants | Original data configuration, copy/clone and metadata values/types | Exporting node metadata does not enable a runtime node compiler |
| `onDeviceLost`, `onError` | Native lifecycle-gated device loss and actual uncaptured WebGPU error event objects; replaceable callbacks | Disposal removes observers and cancels pending loss delivery; native error handling remains installed |
| `setTransparentSort` | Source RenderItem comparator, projected depth, null reset, `sortObjects` control | Single-material, unclipped objects |
| `renderOrder`, Group order, `setOpaqueSort` | Source opaque ordering, caller comparator, null reset and traversal order with `sortObjects = false` | At most 1000 visible ordinary single-material, unclipped opaque meshes when ordering is requested; instance, BatchedMesh and line/point/sprite combinations remain explicit gaps |
| `CanvasTarget`, `getCanvasTarget` / `setCanvasTarget` | Original canvas sizing/event object, one authority for logical size, DPR, viewport and scissor; direct source edits and same-canvas target selection | Changing physical canvas, partial viewport/depth/scissor and framebuffer texture sampling remain rejected |
| NodeMaterial model subclasses | Original Basic, Standard, Physical, Lambert, Normal, Matcap, LineBasic, LineDashed, Points and Sprite NodeMaterial models render ordinary properties through existing native models and caches | Only the documented uniform, sampled-texture and direct value-reference leaves are projected; other node inputs stay null. Custom subclasses, shader-hook overrides, unsupported lighting modes and physical lobes fail admission. NodeMaterial itself is a CPU base, not a generic native shader |
| `NodeMaterialInstance` | Original shared definition, copied instance data, read-only graph inputs, clone/userData and version behavior; Basic/Standard/Sprite/dashed instances reuse existing native materials | Physical prototype accessors and nested/custom definitions remain rejected; no graph compiler or shader-method copies |
| CPU material libraries | Original Phong, Toon, SSS, Shadow, Volume and Line2 node models; BasicNodeLibrary / StandardNodeLibrary conversions, Lighting scene caches, and NodeMaterialObserver CPU inspection | These six models are CPU descriptors and fail native rendering admission. Libraries are not installed on the native renderer; unmatched fromMaterial returns null |
| CPU expressions / references | TempNode, AssignNode, ConditionalNode, StackNode, LoopNode, OperatorNode, MathNode, BitcastNode, RotateNode, UniformArrayNode, ReferenceNode, ReferenceBaseNode, ReferenceElementNode, UserDataNode, OutputStructNode, SubBuildNode, IndexNode, VertexColorNode, FrontFacingNode, TextureNode, CubeTextureNode and Texture3DNode | Original CPU operands, references and JSON; caller-driven updates, no native graph evaluation |
| CPU graph authoring | ArrayNode, ArrayElementNode, BypassNode, ContextNode, ConvertNode, ExpressionNode, FlipNode, JoinNode, MemberNode, ParameterNode, PropertyNode, SetNode, SplitNode, StructTypeNode and UniformNode preserve original identity, references, values and JSON | Does not supply a NodeBuilder or native shader-graph conversion |
| `EventNode`, `ReadbackBuffer` | Original update-phase callbacks via caller-owned NodeFrame; release/dispose events and readback data fields | The facade does not drive node events or allocate/read GPU buffers; pipeline events need a separate upstream builder owner |
| `RendererUtils` | Original save/reset/restore functions for renderer, scene and combined state; reusable caller state objects | Current canvas/default draw state; non-null MRT, render-target and render-object overrides remain unsupported |
| `Node`, `InputNode`, `ConstNode`, `UniformGroupNode`, `NodeCache`, `NodeFrame`, `NodeUtils` | Original CPU node identity/events, weak cache inheritance, manually driven updates and value/hash utilities | Not connected to native material compilation or the renderer animation loop |
| `waitForGPU` | Physical completion of prior native queue work | Retained legacy declaration API; distinct from renderAsync submission |
| `hasCompatibility`, `resetState` | WebGPU comparison capability and pass-local state boundary | Unknown hints return false; resetState retains authored renderer settings, matching WebGPU |

The r187 runtime passes `{ api, type, message, originalEvent }` to `onError`.
The facade types describe that actual object. The pinned @types string signature
is an upstream declaration discrepancy retained in the raw audit.

NodeFunctionInput types include the real type/name fields, nullable count and
static flag. StackTrace includes its actual formatting methods and accepts the
working string/null forms; the upstream-declared Error input throws in r187.
Those declaration differences remain visible in the raw audit.

EventNode admits all nine actual r187 event phases. JoinNode admits its optional
node-type argument; MemberNode exposes the actual `structNode` field; SetNode
admits string components and the existing array form. NodeFrame includes the real
`updateAfterNode` method. These declaration overlays retain upstream constructors;
raw differences from the pinned declarations remain in the audit. Other inherited
upstream declarations, including NodeFrame's historical bookkeeping fields, have
not been exhaustively corrected.

CanvasTarget edits share state with renderer getters and setters. The active target
owns the desired logical and physical extent; selecting an earlier same-canvas target
restores its dimensions on the next accepted operation. An unchanged extent does not
write canvas dimensions. Validation uses fixed renderer-owned scratch and precedes
scene publication. CanvasTarget's framebuffer color/depth objects are CPU descriptors,
not leases on native attachments; unsupported framebuffer sources fail before the
ordinary image-loading fallback. Renderer disposal dispatches dispose once on the
active target after releasing its native resources. Default DPR remains 1.

Original NodeMaterial classes bring their upstream CPU TSL definitions into the
facade. No upstream GPU renderer or NodeBuilder is included. The admitted model
constructors share the existing unlit/Lambert/Normal/Matcap/PBR projection and shader
programs; source objects and material handles keep their original identity.
Admission reads a fixed list of r187 node inputs and source-derived shader-hook
references; it never walks or compiles a graph. Ordinary Material sources skip
that scan. Unsupported graph inputs are rejected before publishing assets or World changes.
Physical diffuseRoughness and retroreflectivity remain unsupported, alongside the
existing dispersion and nonuniform clearcoat-normal-scale boundary.

Plain PointsNodeMaterial is admitted only on Points (one-pixel WebGPU primitives),
and SpriteNodeMaterial only on Sprite (the existing camera-facing transform,
rotation, center and sizeAttenuation). PointsNodeMaterial on Sprite needs a native
screen-space sizing path and is rejected. LineDashedNodeMaterial shares affine
lineDistance projection and adds its actual dashOffset, including constant-gap
coverage at zero scale. Sprite positionNode, rotationNode and scaleNode replace local
position, rotation and scale through the same billboard transform; source positionNode
is inherited by a scene override, while override rotation/scale remain selected.
Line offsetNode, dashScaleNode, dashSizeNode and gapSizeNode replace the ordinary
dash parameters. A constant phase exactly equal to dashSize remains visible,
including non-binary decimal values. Existing line/point texture and vertex-color boundaries
remain. AssignNode declarations include its real targetNode/sourceNode references;
other inherited upstream declaration discrepancies remain in the raw audit.

Additional StructNode, VarNode, OverrideContextNode, IsolateNode, AttributeNode,
BufferNode, CodeNode, FunctionCallNode, FunctionNode and FunctionOverloadingNode
exports retain CPU data and references. StructNode accepts named or array values;
code includes and the actual `parametersNodes` field are declared. These are not
native WGSL calls or GPU buffer submission. Raw upstream declaration differences
remain visible. `init()` continues to resolve to the renderer, matching r187 runtime;
the pinned `Promise<void>` declaration remains an audit difference.

These are bounded name/type additions, not full conformance percentages. The
player still imports no upstream GPU renderer or NodeBuilder. Default sorting
does not create opaque RenderItems or object-specific material variants. Explicit
opaque ordering reuses native material queue priorities 2000 through 2999, below
the transparent queue. Stable source identities preserve material handles when
ranks change; unchanged ranks issue no material updates. This path can split native
material batches and costs a bounded CPU sort. Default opaque scenes retain native
batching and have no 1000-object limit. Mixed-world mounts retain their existing
opaque-order rejection because the host owns ordering with native objects.
One shared fullscreen geometry/camera serves
all QuadMesh instances. The r187 output route selects one premultiplied-alpha
fragment entry in the existing output pass. It adds no binding layout, render pass or per-source
shadow registry. Native straight-alpha output entries keep their existing path.

## Share a native World

`mountThreeScene({ world, renderer, scene, camera })` projects into an existing
World and borrows its asset owner and initialized renderer. Assemble the renderer
with the public `createThreePipeline()` and install the normal runtime asset
decoder contributions. The runnable [mixed example](example/mixed.ts) shows the
complete public setup (`example/mixed.html`).

```ts
const mount = (await THREE.mountThreeScene({ world, renderer, scene, camera })).unwrap();
// Once per host input update, before native simulation:
mount.sync().unwrap();
const selected = mount.entityFor(camera).unwrap();
// After scheduled native simulation and transform propagation:
const result = renderer.draw({
  source: mount.source,
  camera: { entityKey: selected },
  geometryLane: 'direct',
});
if (!result.ok) throw result.error;
// Later: releases source entities and leases; native entities remain.
mount.dispose().unwrap();
```

The host owns the frame loop, simulation, propagation and rendering. The mount
never ticks the World or submits a frame; keep its borrowed `source` lease alive
until unmount. Source objects retain authority over their projected components.
Native entities can share depth, lighting, shadows and projected asset handles;
static colliders and business components may be attached to source entities.
Native references retain shared assets after unmount through the existing asset
owner. Source removal also removes any components attached to that source entity.

This initial surface allows one mount, one Three camera and one global Three
environment per World. It rejects native hierarchy links and dynamic physics
writers on source entities; repair those conflicts before retrying removal or
unmount. CPU-backed resources follow the compatibility contract. Mixed mode does
not provide external/video texture import, custom Scene render callbacks,
reverse Object3D proxies, automatic pose writeback or Worker object transport.
Direct property edits still require source discovery; unchanged component writes
and resource replacements are skipped, and native mesh populations are not
projected again. This is an experimental, bounded interoperation surface.

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

The small-map variance startup tests retain Three's zero bias/normalBias defaults.
Variance rendering also admits shadow receivers as casters, matching Three.
Both references can therefore contain self-shadow stripes from forward-depth
RG16F moments and zero comparison separation. Passing cross-renderer parity is
not an acne-free quality verdict; native shadow quality uses independent
shadow-on/off lighting and known-unoccluded receiver oracles. Increasing bias
can suppress stripes while detaching contacts, so both conditions need checking.

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

PCFSoftShadowMap is rejected, following its removal from r187 WebGPU.
Directional shadows use the authored shadow camera. Point and spot shadows,
Basic/PCF/VSM selection, shadow side/layers, bias, normal bias, radius,
intensity and manual `autoUpdate`/`needsUpdate` project to the native renderer.
As in r187, point lights use Vogel filtering for every non-Basic selection.
The adapter explicitly owns Three's shadow-sidedness policy: a null
`shadowSide` reverses single-sided color culling for non-VSM shadows, while VSM
uses the color side. An explicit `shadowSide` overrides either default. This
projection stays independent of native generated casters, which preserve
authored culling for contact correctness.
Native Forgeax CSM defaults and the Game3D template's shadow distance are unchanged.

## Inspect and compare

```ts
const capture = await renderer.captureFrame(scene, camera);
const { renderer: nativeState, sources, receipt } = renderer.inspect();
await renderer.dispose();
```

Capture requires a ready scene and preserves the actual native RHI commands,
resources, source identities and submitted output. It does not capture Three's
reference renderer. The browser fixtures compare against a separate, actual r187
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

## TSL authoring and bounded material inputs

Import original TSL functions through the matching constructor family:

```ts
import * as THREE from '@forgeax/engine/three';
import { uniform, texture } from '@forgeax/engine/three/tsl';

const tint = uniform(new THREE.Color(0xff6633));
const material = new THREE.MeshStandardNodeMaterial({ transparent: true });
material.colorNode = tint;
material.opacityNode = uniform(0.75);
tint.value.setHex(0x33aaee); // caller-owned updates are read on the next draw
material.colorNode = texture(albedo); // ordinary 2D sampling; replaces map and color
```

The `TSL` namespace on the main facade exposes the same functions. The focused
`three/tsl` entry loads CPU authoring without native runtime packages or cooked
material program payloads. It does not supply a NodeBuilder or upstream GPU renderer.

| Input | Projected values | Boundary |
|:--|:--|:--|
| colorNode UniformNode | Color, vec3, or vec4; vec4 alpha multiplies opacity | Exact original UniformNode, finite RGB, alpha in [0, 1] |
| opacityNode UniformNode | Float in [0, 1] | Replaces opacity and alphaMap |
| colorNode TextureNode | Ordinary sampled 2D source, source UV channel/matrix and texture color space | Replaces map and color; texture alpha remains part of coverage |
| opacityNode TextureNode | Red-channel sampling, including the source texture's color-space conversion | Replaces alphaMap and opacity |
| roughnessNode / metalnessNode | Uniform float in [0, 1] on Standard and Physical | Replaces the ordinary value and corresponding map |
| emissiveNode | Uniform Color or vec3 on Lambert, Standard and Physical | Replaces emissive, emissiveIntensity and emissiveMap |
| clearcoatNode / clearcoatRoughnessNode / sheenRoughnessNode / specularIntensityNode | Uniform float in [0, 1] on Physical | Replaces the ordinary value and corresponding map |
| sheenNode / specularColorNode | Uniform Color or vec3 on Physical | Replaces sheenColor * sheen / specularColor and the corresponding map |
| iorNode | Uniform finite float >= 1 on Physical | Replaces ior |
| iridescenceNode / iridescenceIORNode / iridescenceThicknessNode | Uniform floats in [0, 1], >= 1 and >= 0 on Physical | Replaces iridescence/maps, IOR and the absolute film thickness; native min/max both receive that thickness |
| transmissionNode / thicknessNode | Uniform floats in [0, 1] and >= 0 on Physical | Replaces transmission/thickness and corresponding maps |
| attenuationDistanceNode / attenuationColorNode | Uniform finite float > 0 and Color/vec3 in [0, 1] on Physical | Replaces absorption parameters; null retains ordinary Infinity distance semantics |
| positionNode / rotationNode / scaleNode | Uniform Vector3, finite float, and positive finite Vector2 on SpriteNodeMaterial | Local position, billboard rotation and multiplicative world scale; Points fields remain unsupported |
| offsetNode / dashScaleNode / dashSizeNode / gapSizeNode | Uniform finite floats; dashSize > 0, gapSize >= 0 on LineDashedNodeMaterial | Existing affine lineDistance admission; signed and zero dash scale are supported |

These inputs work on Basic, Lambert, Standard, Physical, LineBasic, LineDashed,
Points and Sprite models. Existing line/point UV restrictions still reject
texture inputs. The additional lit inputs accept UniformNode or the direct
material-reference leaves below, with finite RGB values. Normal and Matcap keep their null-input boundary. Unlisted node
inputs remain null. Operators, ConstNode (including TSL.color), Fn, custom node
subclasses, update callbacks, precision overrides, custom UV/LOD/gradient/offset
nodes, comparison/fetch sampling and GPU-only attachment textures are rejected.
Use ordinary material color for fixed values and UniformNode for editable inputs.

Sprite scale must stay positive and nonsingular. Position preparation reads values
only from exact UniformNode leaves, so rejected self-referential texture getters
are never evaluated before admission. Transform-only edits retain material handles
and publish no material assets. anisotropyNode remains unsupported: an equivalent
Core material reproduces the captured native anisotropy pixel gap.

Admission checks fixed leaf shapes and original method references; it neither
walks a graph nor mirrors nodes or materials. Successful leaf admission reuses
one Result. Existing material revisions, texture caches and resource lifetimes
own publication, edits and retirement; unchanged values keep native handles.
`renderAsync` and scene override precedence use the same selected inputs.
`physicalTextureRecipe` accepts a Physical NodeMaterial and derives the effective
selected bindings through the same player helper. Additional Physical texture
combinations still require an explicit build-only cook; they are not added to
the default program payload. Inherited upstream declaration/JSON discrepancies
remain visible; for example, PackFloatNode does not serialize its encoding.

### Node JSON loading and storage descriptors

NodeLoader, NodeMaterialLoader and NodeObjectLoader accept explicit upstream
node/material registries. They retain original node constructors, shared input
references and shared scene resources. NodeObjectLoader.parseAsync uses the same
hydration route. The facade repairs two pinned r187 load-time defects: restoring
the getter-only Node.uuid through its existing backing field, and restoring a
Physical material's JSON null attenuationDistance to its default Infinity.
Hydration does not patch global prototypes or compile graphs. Loaded materials
must pass the same bounded input admission before native publication. The pinned
upstream registry declarations incorrectly describe constructors as instances;
the facade corrects them to constructor registries and NodeLoader.loadAsync to a
single Node. Fluent loader settings retain that corrected contract. These are
type-only corrections; the inherited source runtime methods are unchanged.

StorageTexture, StorageArrayTexture and Storage3DTexture preserve original CPU
descriptors, resize/dispose and clone behavior. They require native GPU storage
ownership and are rejected before ordinary pending-image allocation, including
when supplied through TextureNode. Export presence does not supply compute,
storage binding, dispatch, upload, copy or readback compatibility.

### Additional CPU graph interfaces

| Group | Original CPU constructors |
|:--|:--|
| Compute / synchronization | ComputeNode, ComputeBuiltinNode, BuiltinNode, AtomicFunctionNode, BarrierNode, SubgroupFunctionNode, WorkgroupInfoNode |
| Storage operands | StorageBufferNode, StorageArrayElementNode, StorageTextureNode, StorageTexture3DNode |
| Lighting descriptions | LightingModel, LightingNode, LightsNode, LightingContextNode, AONode, IrradianceNode, PhongLightingModel, PhysicalLightingModel |
| Light node data | AnalyticLightNode, AmbientLightNode, DirectionalLightNode, HemisphereLightNode, IESSpotLightNode, LightProbeNode, PointLightNode, ProjectorLightNode, RectAreaLightNode, SpotLightNode |
| Outputs / tools / light data | MRTNode, RenderOutputNode, ClippingNode, DebugNode, InspectorNode, InspectorBase, ProjectorLight |

These preserve original constructors, operand references, scopes, access flags,
callbacks as data, MRT outputs, blend/clear metadata and CPU lifecycle. They do
not install a native lighting model, inspector or projector, compile graphs,
dispatch compute, bind GPU storage, or enable MRT. Non-null graphs still fail
material admission. Source callbacks are never automatically driven by the facade.
ComputeNode uses mutable count/dispatchSize; declared-only setCount/getCount are
omitted, including after fluent naming. StorageBufferNode exposes the real
setAtomic and typed storage elements, omitting setAtmoic and bufferObject.
The compute, computeKernel, storage and storageElement TSL factories return these
corrected facade types through both the root namespace and the focused subpath.
Their runtime functions retain upstream identity, with no wrapper. Compute accepts
a numeric count or explicit dispatch array. Storage accepts an ordinary
BufferAttribute with explicit type/count; literal buffer types and fluent
access/name/atomic chains preserve the corrected element type. Other NodeElements
paths still inherit upstream declarations; declaration and JSON limitations are
not exhaustively corrected. Light-node CPU updates preserve original source
references, color/falloff, SH coefficients and area axes when explicitly called;
the native renderer does not execute their graph or drive their callbacks.

Transmission ordering follows Three's node presence, including a zero-valued
transmissionNode: sorted transparency, override inheritance and double-sided
transmission passes use the same predicate. Ordinary Core material policy stays
on that shared path. Default material programs and layouts are unchanged.

The optical fixtures retain an explicit IOR=1 uniform through JSON. r187's
NodeMaterial JSON omits ordinary IOR, so use iorNode when that value must survive
serialization. A separate captured IOR=1.5 transmission case still exceeds the
pixel gate for both Core and NodeMaterial; their native outputs match exactly.
That native refraction gap remains deferred, independently of uniform projection.

### Direct material parameter references

```ts
const definition = new THREE.MeshStandardNodeMaterial();
definition.colorNode = THREE.TSL.materialReference('tint', 'color');
definition.opacityNode = THREE.TSL.materialReference('alpha', 'float');
const instance = new THREE.NodeMaterialInstance(definition);
Object.assign(instance, { tint: new THREE.Color(0x55dd88), alpha: 0.8 });
```

An exact original MaterialReferenceNode reads one direct material property with an ASCII identifier name on the
current selected material or instance. An explicit material target selects that
material instead. Replacing the property value is observed on the next draw;
shared nodes do not share per-instance parameter values. The original factory and
constructor infer the literal node type through both public entries.

Float, Color/vec3 and vec4 references use the same supported surface fields,
model restrictions, bounds and map replacement as uniforms. Sprite position,
rotation and scale remain UniformNode-only. Dotted paths, arrays, textures,
arbitrary ReferenceNode graphs, callbacks and method/precision overrides fail
admission. Reference JSON hydration is not supplied. Missing or incompatible
values fail admission before native asset publication.

Projection reads one property directly; it does not update reference/node caches,
call NodeFrame, build a graph or mirror parameters. An existing pristine scalar/
color UniformNode cache is admitted but ignored for value selection. Current
material revisions and native handles remain authoritative; quiet syncs publish
no unchanged assets. Default programs, layouts and passes are unchanged.

### Explicit object and userData parameter stores

```ts
const parameters = { tint: new THREE.Color(0x55dd88), alpha: 0.8 };
material.colorNode = THREE.TSL.reference('tint', 'color', parameters);
material.opacityNode = THREE.TSL.userData('alpha', 'float', parameters);
parameters.tint = new THREE.Color(0xff6633);
```

Exact ReferenceNode, ReferenceBaseNode and UserDataNode leaves can read an
explicit object using the same direct ASCII property, scalar/color/vec4 bounds,
model restrictions and map replacement as MaterialReferenceNode. UserDataNode
reads its explicit userData field; ReferenceNode/Base read object. Replacing that
selector or its property is observed on the next draw, even when the source
reference/uniform cache still points at an older store. The original constructors
and factories infer literal node types; the legacy object-first generic parameter
on ReferenceBaseNode remains available.

These stores can be maintained by ordinary authoring code or native gameplay
systems. Projection does not clone stores, mirror native entities, drive NodeFrame
or allocate per-object material variants. Existing revision checks and material
handles own updates; quiet synchronization publishes nothing. Share a store for
shared parameters or bind separate stores to separate materials.

Implicit frame.object / frame.object.userData lookup is not supplied: it needs
object-specific material ownership when a material is shared. Such references,
Sprite pose fields, paths, array/buffer/texture values and custom hooks fail
admission before native publication. Reference serialization is unchanged.

### Additional CPU pass descriptors

GLSLNodeParser parses original GLSL function signatures and code without compiling
or executing shaders. RTTNode owns its original CPU render target, resolution
controls and disposal. ReflectorNode retains explicit target, color/depth views,
virtual-camera and render-target caches. ToonOutlinePassNode retains scene,
camera, outline inputs and target lifecycle. Their original TSL factories share
these constructors. These three pass/texture nodes remain rejected as native
material inputs; exporting them does not add RTT, mirror or toon rendering.

### Shared node material instances

```ts
const definition = new THREE.MeshStandardNodeMaterial();
const left = new THREE.NodeMaterialInstance(definition);
const right = new THREE.NodeMaterialInstance(definition);
left.color = new THREE.Color(0xff5533);
right.color = new THREE.Color(0x3355ff);
// Node inputs are read-only on instances and shared through the definition:
definition.colorNode = THREE.TSL.uniform(new THREE.Color(0x55dd88));
definition.needsUpdate = true;
```

The original constructor copies ordinary model data and shares node references.
Colors are shared initially, so assign a new Color for an independent instance.
userData values use the original first-level clone rules; textures stay shared.
The typed facade exposes copied data, getter-only node fields and correct fluent
clone/copy/fromJSON results without copying shader methods onto instances.
A Sprite accepts its original material instance without a cast. sizeAttenuation
belongs to the Sprite definition; it is not copied onto an instance. The native
billboard reads that same definition, including sizeAttenuation=false. The Sprite
material property retains the upstream SpriteMaterial declaration.

Native instance admission uses the existing model table, fixed input scan and
source hook identities. Instance build/cache-key overrides, invalid or nested
definitions, changed model families and unsupported graph leaves fail admission.
Shared uniform edits retain each instance's native material handle; quiet syncs
publish no unchanged assets. No graph traversal, additional material mirror,
callback loop, default program, layout or render pass is introduced.

Physical instances remain CPU descriptors: r187 copies own properties but omits
Physical prototype accessors such as clearcoat and dispersion. Their native draw
is rejected. Configure a supported Physical NodeMaterial directly. A distinct
instance used as scene.overrideMaterial is rejected before coverage projection;
use a compatible shared definition for an override instead. Direct instance
materials remain supported. Instance JSON hydration and arbitrary
materialReference graphs are not enabled by this addition.

Additional original BasicEnvironmentNode, BasicLightMapNode, EnvironmentNode,
CubeMapNode, PMREMNode, ShadowBaseNode, ShadowNode, PointShadowNode, VelocityNode,
ViewportTextureNode, ViewportSharedTextureNode, ViewportDepthTextureNode, PassNode
and CubeRenderTarget exports preserve CPU references, descriptor sizing, sharing,
explicit history updates and disposal. Shadow constructors admit their actual
optional shadow argument and expose shadow/map/depth-layer metadata. Their
native environment conversion, framebuffer copies, shadow graphs, pass/MRT
execution and motion-vector generation remain unsupported; the renderer does
not drive their GPU setup/update callbacks. Viewport/pass texture leaves fail
native material admission before publication.
