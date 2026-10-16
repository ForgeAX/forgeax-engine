#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../bevy/scripts/renderer-smoke.mjs";
// apps/collectathon — dawn-node structural smoke.
//
// Grows per milestone (structural-only, no pixel readback, OOS-7; uses
// createRenderer directly to validate the GPU stack without the full app
// bootstrap). Each milestone replicates its spawn shape inline using the built
// engine packages (the smoke imports built packages, not the un-built
// collectathon TS source):
//   M1: GPU stack + Camera + DirectionalLight presence.
//   M2: player parent/child separation (KCC + ChildOf + AnimationPlayer) +
//       humanoid.fbx parse (skeleton/skin/animation).
//   M3: procedural level (ground + 4 boundary walls) + N emissive Core sensors +
//       1 Portal sensor; assert entity count >= 21 + 0 RhiError.
//
// Real full-level baseline + pixel readback lock in M5.
//
// Output literals (grep-friendly):
//   - `[collectathon] backend=webgpu`
//   - `[smoke] frames=<N>`
//   - `[smoke] PASS` / `[smoke] FAIL`

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { emitSmokeReceipt } from '../../shared/scripts/smoke-receipt.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);

const WIDTH = 200;
const HEIGHT = 150;

const here = dirname(fileURLToPath(import.meta.url));

// --- 1. dawn.node binding setup ------------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

// --- 2. Mock canvas with offscreen render target -------------------------------

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return adapter;
};

let renderTarget;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}

const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
      },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) {
          if (!sharedDevice) throw new Error('no shared device captured');
          ensureRenderTarget(sharedDevice, 'rgba8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// --- 3. Engine bootstrap -------------------------------------------------------

const { World } = await import('@forgeax/engine-ecs');
const { AnimationPlayer } = await import('@forgeax/engine-animation');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { ChildOf, Transform } = await import('@forgeax/engine-scene');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { Materials } = await import('@forgeax/engine-render');
const { createCylinderGeometry, createPlaneGeometry, createSphereGeometry } = await import(
  '@forgeax/engine-geometry'
);
const {
  CharacterController,
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
} = await import('@forgeax/engine-physics');
const { fbxImporter } = await import('@forgeax/engine-fbx');

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = URL.createObjectURL(new Blob([readFileSync(MANIFEST_PATH)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(MANIFEST_URL));

let renderer;
try {
  const created = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!created.ok) throw created.error;
  renderer = created.value;
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}

console.log(`[collectathon] backend=${renderer.inspect().capabilities.backendKind}`);

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;

// Spawn Camera + DirectionalLight for empty-scene structural smoke.
// Track entity handles to verify existence after render loop.
const camSpawn = world.spawn(
  {
    component: Transform,
    data: { pos: [0, 6, 12], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
  },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
);
if (!camSpawn.ok) {
  console.error(`[smoke] FAIL - Camera spawn failed: ${camSpawn.error.code}`);
  process.exit(1);
}
const cameraEntity = camSpawn.value;

const lightSpawn = world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.4, -1, -0.3], color: [1, 1, 1], intensity: 1 },
});
if (!lightSpawn.ok) {
  console.error(`[smoke] FAIL - DirectionalLight spawn failed: ${lightSpawn.error.code}`);
  process.exit(1);
}
const lightEntity = lightSpawn.value;

// --- 3b. M2 player parent/child structural assembly ----------------------------
//
// The dawn-node path uses createRenderer (no PhysicsWorld resource), so
// moveAndSlide cannot run here -- that runtime behavior is covered by the unit
// tests (player-move) + human/sandbox runtime. What this smoke CAN prove is the
// structural M2 contract: humanoid.fbx parses to skeleton/skin/anim, and the
// parent (KCC) / child (Skin + AnimationPlayer + ChildOf) separation assembles
// without error -- the AC-04 architecture shape.

const HUMANOID_FBX = resolve(here, '..', '..', '..', 'forgeax-engine-assets', 'vendor', 'fbx-test', 'humanoid.fbx');
const HUMANOID_META = JSON.parse(readFileSync(`${HUMANOID_FBX}.meta.json`, 'utf8'));
let fbxResults;
try {
  fbxResults = await fbxImporter.import({
    source: HUMANOID_FBX,
    // ufbx parses ctx.readSource() bytes in-memory (the old SDK importer read
    // the source path from disk itself, so the M2 smoke passed an empty
    // Uint8Array; that path no longer works). Read the real .fbx bytes here.
    readSource: async () => ({ ok: true, value: new Uint8Array(readFileSync(HUMANOID_FBX)) }),
    readSibling: async () => ({ ok: false, error: { code: 'source-read-failed' } }),
    decodeImage: async () => ({ ok: false, error: { code: 'image-decode-failed' } }),
    subAssets: HUMANOID_META.subAssets,
    importSettings: {},
  });
} catch (err) {
  console.error(`[smoke] FAIL - fbxImporter.import threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (!fbxResults.ok) {
  console.error(`[smoke] FAIL - fbxImporter failed: ${fbxResults.error.code}`);
  process.exit(1);
}

const importedAssets = fbxResults.value.assets;
const hasSkeleton = importedAssets.some((a) => a.kind === 'skeleton');
const hasSkin = importedAssets.some((a) => a.kind === 'skin');
const hasAnimation = importedAssets.some((a) => a.kind === 'animation-clip');
console.log(`[smoke] humanoid skeleton=${hasSkeleton} skin=${hasSkin} animation=${hasAnimation}`);

// Parent: kinematic capsule + CharacterController (KCC physics writer).
const parentSpawn = world.spawn(
  { component: Transform, data: { pos: [0, 0.8, 0]} },
  { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
  { component: Collider, data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.5 } },
  { component: CharacterController, data: {} },
);
if (!parentSpawn.ok) {
  console.error(`[smoke] FAIL - player parent spawn failed: ${parentSpawn.error.code}`);
  process.exit(1);
}
const playerParent = parentSpawn.value;

// Child: AnimationPlayer-carrying visual child with ChildOf(parent). The real
// app builds the full skinned hierarchy via assets.instantiate (skeleton/skin
// handle resolution is validated by the production build + human runtime); a
// headless createRenderer cannot register the SkeletonAsset the way instantiate
// does, so this smoke asserts the parent/child SEPARATION shape (KCC parent +
// AnimationPlayer child + ChildOf edge) without re-implementing instantiate's
// skeleton resolution. The parsed assets are asserted above; use a procedural
// rigid mesh for this placeholder so the smoke does not pretend a skinned
// vertex layout can render without the Skin/palette contract.
const placeholderMesh = createSphereGeometry(0.5, 8, 6);
const meshHandle = placeholderMesh.ok
  ? world.allocSharedRef('MeshAsset', placeholderMesh.value)
  : 0;
// The headless smoke deliberately instantiates a rigid placeholder rather than
// the full scene Skin component (the production browser path covers that
// wiring).  A skinned FBX material cannot be used by that placeholder: its
// pbr-skin shader requires the palette bind group.  Keep the imported material
// catalogued for the parser assertion, but give the rigid placeholder the
// ordinary Standard PBR contract it actually owns.
const matHandle = world.allocSharedRef(
  'MaterialAsset',
  Materials.standard({ baseColor: [0.55, 0.6, 0.65, 1], roughness: 0.65 }),
);
const clipAsset = importedAssets.find((a) => a.kind === 'animation-clip');
const clipHandle = clipAsset ? world.allocSharedRef('AnimationClip', clipAsset.payload) : 0;
const childSpawn = world.spawn(
  { component: Transform, data: { pos: [0, -0.8, 0], scale: [1 / 90, 1 / 90, 1 / 90]} },
  { component: MeshFilter, data: { assetHandle: meshHandle } },
  { component: MeshRenderer, data: { materials: [matHandle] } },
  {
    component: AnimationPlayer,
    data: { clips: [clipHandle, clipHandle], times: [0, 0], weights: [0, 1], speeds: [1, 0] },
  },
  { component: ChildOf, data: { parent: playerParent } },
);
let playerChild = null;
let childWired = false;
if (childSpawn.ok) {
  playerChild = childSpawn.value;
  const hasKcc = world.get(playerParent, CharacterController).ok;
  const hasChildOf = world.get(playerChild, ChildOf).ok;
  const hasAnim = world.get(playerChild, AnimationPlayer).ok;
  childWired = hasKcc && hasChildOf && hasAnim;
} else {
  console.error(`[smoke] WARN - player child spawn failed: ${childSpawn.error.code}`);
}
console.log(`[smoke] playerParent=${playerParent !== undefined} playerChild=${playerChild !== null} childWired=${childWired}`);

// --- 3c. M3 level + Core + Portal structural assembly --------------------------
//
// Mirrors the M2 inline approach (the smoke replicates the app spawn shape using
// the built engine packages rather than importing the un-built collectathon TS
// source). Proves the M3 procedural geometry + emissive Core + sensor colliders
// + Portal assemble without RhiError and lands the entity count in range. The
// real full-level baseline (with the instantiated player descendants) locks in
// M5 -- here we count the explicit M3 set only (ground + 4 walls + N cores + 1
// portal).

const LEVEL_HALF = 15;
const CORE_COUNT = 12; // mirrors CORE_POSITIONS.length in spawn-core.ts
const m3Entities = [];

// Ground: plane + thin cuboid collider.
{
  const planeRes = createPlaneGeometry(LEVEL_HALF * 2, LEVEL_HALF * 2);
  const groundMesh = planeRes.ok ? world.allocSharedRef('MeshAsset', planeRes.value) : 0;
  const groundMat = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.28, 0.3, 0.34, 1] }),
  );
  // Mirror spawn-level.ts: visible plane rotated -90deg about X (createPlaneGeometry
  // is an XY plane facing +Z; without the rotation the ground stands as a vertical
  // wall that occludes the scene). Structural replica keeps the plane + collider on
  // ONE entity (count fidelity); the real app splits them so the collider stays
  // axis-aligned while the visual rotates.
  const FLOOR_QX = Math.sin(-Math.PI / 4);
  const FLOOR_QW = Math.cos(-Math.PI / 4);
  const g = world.spawn(
    { component: Transform, data: { pos: [0, -0.1, 0], quat: [FLOOR_QX, 0, 0, FLOOR_QW]} },
    { component: MeshFilter, data: { assetHandle: groundMesh } },
    { component: MeshRenderer, data: { materials: [groundMat] } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
    {
      component: Collider,
      data: { shape: ColliderShapeValue.cuboid, halfExtents: [LEVEL_HALF, 0.1, LEVEL_HALF] },
    },
  );
  if (g.ok) m3Entities.push(g.value);
}

// 4 invisible boundary walls (cuboid colliders, no mesh).
for (const pos of [
  { x: 0, z: LEVEL_HALF },
  { x: 0, z: -LEVEL_HALF },
  { x: LEVEL_HALF, z: 0 },
  { x: -LEVEL_HALF, z: 0 },
]) {
  const w = world.spawn(
    { component: Transform, data: { pos: [pos.x, 2, pos.z]} },
    { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
    { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents: [1, 2, 1] } },
  );
  if (w.ok) m3Entities.push(w.value);
}

// N emissive Core sensors (sphere + emissive standard PBR + sensor collider).
let coresSpawned = 0;
let emissiveCoreOk = false;
for (let i = 0; i < CORE_COUNT; i++) {
  const sphereRes = createSphereGeometry(0.3, 16, 12);
  const coreMesh = sphereRes.ok ? world.allocSharedRef('MeshAsset', sphereRes.value) : 0;
  const coreMat = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [1, 0.8, 0.3, 1], emissive: [1, 0.7, 0.3], emissiveIntensity: 2 }),
  );
  const c = world.spawn(
    { component: Transform, data: { pos: [(i - 6) * 2, 1, 0]} },
    { component: MeshFilter, data: { assetHandle: coreMesh } },
    { component: MeshRenderer, data: { materials: [coreMat] } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
    { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.35, isSensor: true } },
  );
  if (c.ok) {
    m3Entities.push(c.value);
    coresSpawned++;
    if (sphereRes.ok) emissiveCoreOk = true;
  }
}

// 1 Portal (cylinder mesh + sensor collider).
let portalSpawned = false;
{
  const cylRes = createCylinderGeometry(1.2, 1.2, 3, 24, 1);
  const portalMesh = cylRes.ok ? world.allocSharedRef('MeshAsset', cylRes.value) : 0;
  const portalMat = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.2, 0.25, 0.35, 1], emissive: [0.05, 0.08, 0.12], emissiveIntensity: 0.3 }),
  );
  const p = world.spawn(
    { component: Transform, data: { pos: [0, 1.5, -13]} },
    { component: MeshFilter, data: { assetHandle: portalMesh } },
    { component: MeshRenderer, data: { materials: [portalMat] } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
    { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 1.4, isSensor: true } },
  );
  if (p.ok) {
    m3Entities.push(p.value);
    portalSpawned = true;
  }
}
console.log(
  `[smoke] m3Level=${m3Entities.length} cores=${coresSpawned} portal=${portalSpawned} emissiveCore=${emissiveCoreOk}`,
);

// --- 3d. M4 Guardian structural assembly ---------------------------------------
//
// Mirrors the inline approach (the smoke replicates the app spawn shape using
// built engine packages, not the un-built collectathon TS source). Proves the M4
// Guardian assembles without RhiError: a KCC body (kinematic capsule +
// CharacterController + dark-red standard PBR cylinder) plus an attack-sensor
// child (sphere sensor, ChildOf body). 1-3 Guardians + their sensors. The AI /
// hit / arbiter behavior is covered by the unit tests + human/sandbox runtime;
// this smoke counts the entities and asserts the assembly succeeds.

const GUARDIAN_COUNT = 3; // mirrors GUARDIAN_SPAWNS.length in spawn-guardian.ts
const m4Entities = [];
let guardianBodies = 0;
let guardianSensors = 0;
for (let i = 0; i < GUARDIAN_COUNT; i++) {
  const cylRes = createCylinderGeometry(0.4, 0.4, (0.4 + 0.8) * 2, 16, 1);
  const bodyMesh = cylRes.ok ? world.allocSharedRef('MeshAsset', cylRes.value) : 0;
  const bodyMat = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.55, 0.08, 0.08, 1], emissive: [0.15, 0, 0], emissiveIntensity: 0.6 }),
  );
  const body = world.spawn(
    { component: Transform, data: { pos: [(i - 1) * 5, 1.2, -3]} },
    { component: MeshFilter, data: { assetHandle: bodyMesh } },
    { component: MeshRenderer, data: { materials: [bodyMat] } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
    { component: Collider, data: { shape: ColliderShapeValue.capsule, radius: 0.4, halfHeight: 0.8 } },
    { component: CharacterController, data: {} },
  );
  if (!body.ok) {
    console.error(`[smoke] WARN - guardian body spawn failed: ${body.error.code}`);
    continue;
  }
  m4Entities.push(body.value);
  guardianBodies++;
  const sensor = world.spawn(
    { component: Transform, data: { pos: [0, 0, 0]} },
    { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
    { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 1.5, isSensor: true } },
    { component: ChildOf, data: { parent: body.value } },
  );
  if (sensor.ok) {
    m4Entities.push(sensor.value);
    guardianSensors++;
  } else {
    console.error(`[smoke] WARN - guardian sensor spawn failed: ${sensor.error.code}`);
  }
}
console.log(
  `[smoke] m4Guardians=${m4Entities.length} bodies=${guardianBodies} sensors=${guardianSensors}`,
);

// --- 4. Error tracking ---------------------------------------------------------

const errors = [];
const unsubscribe = renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
});

// --- 5. Render loop ------------------------------------------------------------


let framesObserved = 0;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update().unwrap();
  const r = renderer.draw({
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  });
  // Track draw errors via onError — do not fail on individual frames.
  void r;
  framesObserved++;
  // Keep this heavy structural scene paced like a real rAF loop. Without a
  // bounded drain, lavapipe retains every shadow/material command until the
  // final submission and can exhaust the 16 GiB smoke cgroup before 60 frames.
  if (sharedDevice && i % 16 === 15) {
    await sharedDevice.queue.onSubmittedWorkDone();
  }
}
// The final fence makes the completed-frame boundary explicit before the
// structural assertions and mirrors the native shadow-fields smoke contract.
if (sharedDevice) await sharedDevice.queue.onSubmittedWorkDone();
console.log(`[smoke] frames=${framesObserved}`);

// --- 6. Structural assertions --------------------------------------------------

// Verify Camera entity still exists (world.get succeeds).
const camCheck = world.get(cameraEntity, Camera);
const cameraFound = camCheck.ok;

// Verify DirectionalLight entity still exists.
const lightCheck = world.get(lightEntity, DirectionalLight);
const lightFound = lightCheck.ok;

// M5 baseline LOCKED. This dawn smoke counts the EXPLICIT structural replica it
// spawns (it imports built engine packages, not the un-built collectathon TS,
// and replaces the instantiated humanoid hierarchy with a single placeholder
// child). The deterministic explicit set is:
//   Camera(1) + DirectionalLight(1) + player parent(1) + player child(1)
//   + ground(1) + 4 walls + 12 Cores + Portal(1) + 3 Guardian bodies
//   + 3 Guardian attack sensors = 28.
// Here we lock the structural-replica count to a tight [28, 30] band: a drift
// below means a spawn regressed; above means a stray entity leaked in.
const playerParentFound = world.get(playerParent, CharacterController).ok;
const playerChildFound = playerChild !== null && world.get(playerChild, ChildOf).ok;
const baseEntities = 2 + (playerParentFound ? 1 : 0) + (playerChildFound ? 1 : 0);
const entityCount = baseEntities + m3Entities.length + m4Entities.length;
const ENTITY_BASELINE_MIN = 28;
const ENTITY_BASELINE_MAX = 30;

console.log(
  `[smoke] cameraFound=${cameraFound} lightFound=${lightFound} playerParent=${playerParentFound} playerChild=${playerChildFound} entityCount=${entityCount}`,
);

const failures = [];
if (renderer.inspect().capabilities.backendKind !== 'webgpu') {
  failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
}
if (framesObserved < SMOKE_MIN_FRAMES) {
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
}
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}
if (!cameraFound) {
  failures.push('(d) Camera entity not found after render loop');
}
if (!lightFound) {
  failures.push('(e) DirectionalLight entity not found after render loop');
}
if (!hasSkeleton || !hasSkin || !hasAnimation) {
  failures.push(`(f) humanoid.fbx parse: skeleton=${hasSkeleton} skin=${hasSkin} animation=${hasAnimation} (all required)`);
}
if (!playerParentFound) {
  failures.push('(g) player parent (CharacterController) not found');
}
if (!childWired) {
  failures.push('(h) player child parent/child wiring (KCC + ChildOf + AnimationPlayer) incomplete');
}
if (entityCount < ENTITY_BASELINE_MIN || entityCount > ENTITY_BASELINE_MAX) {
  failures.push(
    `(i) entityCount=${entityCount} outside locked [${ENTITY_BASELINE_MIN}, ${ENTITY_BASELINE_MAX}] (Camera + Light + player(2) + ground + 4 walls + ${CORE_COUNT} cores + portal + 3 Guardian bodies + 3 sensors = 28)`,
  );
}
if (coresSpawned !== CORE_COUNT) {
  failures.push(`(j) cores spawned=${coresSpawned} != ${CORE_COUNT}`);
}
if (!portalSpawned) {
  failures.push('(k) Portal entity not spawned');
}
if (!emissiveCoreOk) {
  failures.push('(l) Core sphere geometry / emissive material assembly failed');
}
if (guardianBodies !== GUARDIAN_COUNT) {
  failures.push(`(m) Guardian bodies spawned=${guardianBodies} != ${GUARDIAN_COUNT}`);
}
if (guardianSensors !== GUARDIAN_COUNT) {
  failures.push(`(n) Guardian attack sensors spawned=${guardianSensors} != ${GUARDIAN_COUNT}`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - backend=webgpu, frames=${framesObserved}, camera=${cameraFound}, light=${lightFound}, player wired=${childWired}, level+cores+portal=${m3Entities.length}, guardians=${m4Entities.length}, entityCount=${entityCount}, RhiError=0`,
);

emitSmokeReceipt('collectathon/smoke', framesObserved);

if (sharedDevice) sharedDevice.destroy?.();
unsubscribe();
await renderer.dispose();
delete globalThis.navigator.gpu;
process.exit(0);
