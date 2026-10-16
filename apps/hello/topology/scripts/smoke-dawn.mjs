#!/usr/bin/env node
// hello-topology Dawn smoke: public geometry factories, 60 frames, and
// intentionally red topology/degenerate/threshold falsifiers.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

const WIDTH = 200;
const HEIGHT = 150;
const TOTAL_PIXELS = WIDTH * HEIGHT;
const FRAMES = Math.max(60, Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10));
const CLEAR_RGBA = [0, 0, 0, 1];
const FOREGROUND_CHANNEL_MIN = 24;
const FILLED_FACE_CEILING = Math.floor(TOTAL_PIXELS * 0.35);
const FALSIFY = process.env.FALSIFY ?? '';
const here = dirname(fileURLToPath(import.meta.url));

const FOCUSED_EVIDENCE_CASES = [
  'points-square-circle',
  'lines-1-4-16px',
  'indexed-nonindexed',
  'depth-alpha-sort',
  'resize-dpr',
  'frustum-edge',
  'lane-provenance',
];
const FOCUSED_FALSIFIERS = ['point-square', 'line-width', 'depth-sort', 'lane'];

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (error) {
  console.error(`[smoke] FAIL - dawn.node import failed: ${errorMessage(error)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}

let gpu;
try {
  gpu = create([]);
} catch (error) {
  console.error(`[smoke] FAIL - dawn-node create failed: ${errorMessage(error)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    const device = await originalRequestDevice(descriptor);
    sharedDevice ??= device;
    return device;
  };
  return adapter;
};

let renderTarget;
function ensureRenderTarget(device, format) {
  renderTarget ??= device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x04 | 0x01,
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
      configure(descriptor) {
        ensureRenderTarget(descriptor.device, descriptor.format ?? 'rgba8unorm');
      },
      unconfigure() {},
      getCurrentTexture() {
        if (renderTarget === undefined) {
          if (sharedDevice === undefined) throw new Error('no shared device captured');
          ensureRenderTarget(sharedDevice, 'rgba8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { buildMeshAttributeMapForUvSets, createBoxGeometry, createEdgesGeometry, createWireframeGeometry } =
  await import('@forgeax/engine-geometry');
const { Camera, Lines, Materials, MeshFilter, MeshRenderer, PointShapeValue, Points, perspective } =
  await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');

const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
let manifestUrl;
try {
  manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
} catch (error) {
  console.error(`[smoke] FAIL - missing built manifest at ${manifestPath}: ${errorMessage(error)}`);
  console.error('  run pnpm --filter @forgeax/hello-topology build first');
  process.exit(1);
}

let renderer;
let hostAssets;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: manifestUrl });
  if (!constructed.ok) {
    console.error(`[smoke] FAIL - renderer construction: ${constructed.error.code}`);
    process.exit(1);
  }
  renderer = constructed.value.renderer;
  hostAssets = constructed.value.assets;
} catch (error) {
  console.error(`[smoke] FAIL - renderer construction threw: ${errorMessage(error)}`);
  process.exit(1);
} finally {
  gpu.requestAdapter = originalRequestAdapter;
}

const backend = renderer.inspect().capabilities.backendKind;
console.log(`[hello-topology] backend=${backend}`);
if (hostAssets === null) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

function expectOk(label, result) {
  if (result.ok) return result.value;
  const detail = result.error.detail;
  console.error(
    `[smoke] FAIL - ${label}: ${result.error.code} ` +
      `field=${detail?.field ?? '<none>'} value=${String(detail?.value)} ` +
      `reason=${detail?.reason ?? result.error.hint}`,
  );
  process.exit(1);
}

const source = expectOk('createBoxGeometry', createBoxGeometry(1.4, 1.4, 1.4));
const wireframe = expectOk('createWireframeGeometry', createWireframeGeometry(source));
const surfaceEdges = expectOk('createEdgesGeometry', createEdgesGeometry(source, 1));

if (FALSIFY === 'threshold') {
  const rejected = createEdgesGeometry(source, 181);
  if (rejected.ok) {
    console.error('[smoke] FAIL - threshold falsifier accepted an out-of-range threshold');
    process.exit(1);
  }
  console.error(`[smoke] FAIL - threshold falsifier: ${rejected.error.code}`);
  process.exit(1);
}

function cloneAsDegenerate(mesh) {
  const positions = new Float32Array(mesh.attributes.position);
  const vertices = new Float32Array(mesh.vertices);
  positions.fill(0);
  vertices.fill(0);
  return { ...mesh, vertices, attributes: { ...mesh.attributes, position: positions } };
}

const meshPayload = FALSIFY === 'topology-triangle-list'
  ? source
  : FALSIFY === 'degenerate'
    ? cloneAsDegenerate(wireframe)
    : wireframe;
const meshSubmesh = meshPayload.submeshes[0];
if (meshSubmesh === undefined) {
  console.error('[smoke] FAIL - factory output has no submesh');
  process.exit(1);
}
const edgeCount = meshSubmesh.vertexCount / 2;
const surfaceEdgeCount = (surfaceEdges.submeshes[0]?.vertexCount ?? 0) / 2;

const pointPositions = [
  [-0.4, 0.45, 0],
  [0, 0.65, 0],
  [0.4, 0.45, 0],
];
const pointVertices = new Float32Array(pointPositions.length * 12);
const pointAttribute = new Float32Array(pointPositions.length * 3);
for (let index = 0; index < pointPositions.length; index += 1) {
  const position = pointPositions[index];
  pointVertices.set(position, index * 12);
  pointAttribute.set(position, index * 3);
}
const pointMeshPayload = {
  kind: 'mesh',
  vertices: pointVertices,
  attributes: { ...buildMeshAttributeMapForUvSets(1), position: pointAttribute },
  submeshes: [{
    indexOffset: 0,
    indexCount: 0,
    vertexCount: pointPositions.length,
    topology: 'point-list',
    materialSlot: 0,
  }],
  materialSlots: [{ slotName: 'Points' }],
};
console.log(
  `[smoke] geometry=${JSON.stringify({
    factory: FALSIFY === '' ? 'createWireframeGeometry' : 'createWireframeGeometry:falsified',
    surfaceFactory: 'createEdgesGeometry',
    edgeCount,
    surfaceEdgeCount,
    topology: meshSubmesh.topology,
    indexed: meshPayload.indices !== undefined,
    falsify: FALSIFY || '<none>',
  })}`,
);

const device = sharedDevice;
if (device === undefined) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}

const world = new World();
const attached = renderer.attach(world);
if (!attached.ok) {
  console.error(`[smoke] FAIL - renderer.attach: ${attached.error.code}`);
  process.exit(1);
}
const meshHandle = world.allocSharedRef('MeshAsset', meshPayload);
const pointMeshHandle = world.allocSharedRef('MeshAsset', pointMeshPayload);
const materialHandle = world.allocSharedRef(
  'MaterialAsset',
  Materials.unlit([0.1, 0.9, 1, 1], {
    ...(FALSIFY === 'depth-sort' ? { renderState: { depthWriteEnabled: false } } : {}),
  }),
);

const meshEntity = world.spawn(
  { component: Transform, data: { quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: MeshFilter, data: { assetHandle: meshHandle } },
  { component: MeshRenderer, data: { materials: [materialHandle] } },
  { component: Lines, data: { width: FALSIFY === 'line-width' ? 1 : 4 } },
);
if (!meshEntity.ok) {
  console.error(`[smoke] FAIL - mesh spawn: ${meshEntity.error.code}`);
  process.exit(1);
}
if (FALSIFY !== 'degenerate') {
  const pointEntity = world.spawn(
    { component: Transform, data: { pos: [0, 0, -2], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: pointMeshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
    {
      component: Points,
      data: {
        sizePx: 16,
        shape: FALSIFY === 'point-square' ? PointShapeValue.square : PointShapeValue.circle,
      },
    },
  );
  if (!pointEntity.ok) {
    console.error(`[smoke] FAIL - point spawn: ${pointEntity.error.code}`);
    process.exit(1);
  }
}
const cameraEntity = world.spawn(
  { component: Transform, data: { pos: [1.6, 1.4, 3.2], quat: [-0.1804578, 0.22576895, 0.04260031, 0.9563726] } },
  { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
);
if (!cameraEntity.ok) {
  console.error(`[smoke] FAIL - camera spawn: ${cameraEntity.error.code}`);
  process.exit(1);
}

const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
});

const frameRequest = {
  leases: [attached.value],
  camera: { lease: attached.value },
  environment: { lease: attached.value },
};
const warmUpdate = world.update();
if (!warmUpdate.ok) {
  console.error(`[smoke] FAIL - warmup update: ${warmUpdate.error.code}`);
  process.exit(1);
}
const warmDraw = renderer.draw(frameRequest);
if (!warmDraw.ok) {
  console.error(`[smoke] FAIL - warmup draw: ${warmDraw.error.code}`);
  process.exit(1);
}
await delay(0);
for (let frame = 1; frame < FRAMES; frame += 1) {
  const update = world.update();
  if (!update.ok) {
    console.error(`[smoke] FAIL - update at frame ${frame}: ${update.error.code}`);
    process.exit(1);
  }
  const draw = renderer.draw(frameRequest);
  if (!draw.ok) {
    console.error(`[smoke] FAIL - draw at frame ${frame}: ${draw.error.code}`);
    process.exit(1);
  }
}
await device.queue.onSubmittedWorkDone();
const pixels = await readPixels(device);
const pointsLinesInspection = renderer.inspect().renderScene.pointsLines ?? [];
const pointInspection = pointsLinesInspection.find((entry) => entry.component === 'Points');
const lineInspection = pointsLinesInspection.find((entry) => entry.component === 'Lines');
let foreground = 0;
for (let offset = 0; offset < pixels.length; offset += 4) {
  if (
    pixels[offset] >= FOREGROUND_CHANNEL_MIN ||
    pixels[offset + 1] >= FOREGROUND_CHANNEL_MIN ||
    pixels[offset + 2] >= FOREGROUND_CHANNEL_MIN
  ) foreground += 1;
}

console.log(
  `[smoke] lineReadback=${JSON.stringify({
    foreground,
    ceiling: FILLED_FACE_CEILING,
    totalPixels: TOTAL_PIXELS,
    frames: FRAMES,
    clear: CLEAR_RGBA,
    factory: 'createWireframeGeometry',
    edgeCount,
    surfaceEdgeCount,
    backend,
    falsify: FALSIFY || '<none>',
    pointsLines: pointsLinesInspection,
  })}`,
);

const failures = [];
if (backend !== 'webgpu') failures.push(`backend=${backend} expected webgpu`);
if (errors.length > 0) failures.push(`renderer errors=${JSON.stringify(errors)}`);
if (FRAMES < 60) failures.push(`frames=${FRAMES} < 60`);
if (FALSIFY === '') {
  if (meshSubmesh.topology !== 'line-list') failures.push('normal topology is not line-list');
  if (meshPayload.indices !== undefined) failures.push('normal output unexpectedly indexed');
  if (surfaceEdgeCount !== 12) failures.push(`boundary edge count=${surfaceEdgeCount} expected 12`);
  if (pointsLinesInspection.length !== 2) failures.push(`points-lines inspection count=${pointsLinesInspection.length} expected 2`);
  if (pointInspection?.style?.kind !== 'points' || pointInspection.style.sizePx !== 16) {
    failures.push('Points authoring did not remain resident in inspection');
  }
  if (lineInspection?.style?.kind !== 'lines' || lineInspection.style.width !== 4) {
    failures.push('Lines authoring did not remain resident in inspection');
  }
  if (foreground === 0) failures.push('line-list has zero foreground pixels');
  if (foreground >= FILLED_FACE_CEILING) failures.push('line-list foreground reached filled-face ceiling');
} else if (FALSIFY === 'degenerate') {
  if (foreground !== 0) failures.push(`degenerate falsifier foreground=${foreground} expected zero`);
  else failures.push('degenerate falsifier correctly made the oracle red');
} else if (FALSIFY === 'topology-triangle-list') {
  if (foreground < FILLED_FACE_CEILING) {
    failures.push(`topology falsifier foreground=${foreground} did not cross ceiling=${FILLED_FACE_CEILING}`);
  } else {
    failures.push('topology-triangle-list falsifier correctly made the oracle red');
  }
}

if (FALSIFY === 'point-square' && pointInspection?.style?.shape !== 'square') {
  failures.push('point-square falsifier did not reach Points authoring');
}
if (FALSIFY === 'line-width' && lineInspection?.style?.width !== 1) {
  failures.push('line-width falsifier did not reach Lines authoring');
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria: ${failures.join('; ')}`);
  device.destroy?.();
  delete globalThis.navigator.gpu;
  process.exit(1);
}

console.log(`[smoke] PASS - structural provenance and sparse foreground over ${FRAMES} frames`);
emitSmokeReceipt('hello-topology/smoke', FRAMES);
device.destroy?.();
delete globalThis.navigator.gpu;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function readPixels(currentDevice) {
  if (renderTarget === undefined) throw new Error('renderTarget never allocated');
  const bytesPerPixel = 4;
  const bytesPerRow = Math.ceil((WIDTH * bytesPerPixel) / 256) * 256;
  const buffer = currentDevice.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: 0x01 | 0x08,
  });
  const encoder = currentDevice.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  currentDevice.queue.submit([encoder.finish()]);
  await currentDevice.queue.onSubmittedWorkDone();
  await buffer.mapAsync(0x01);
  const raw = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const tight = new Uint8Array(TOTAL_PIXELS * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const source = y * bytesPerRow + x * bytesPerPixel;
      const target = (y * WIDTH + x) * 4;
      tight[target] = raw[source] ?? 0;
      tight[target + 1] = raw[source + 1] ?? 0;
      tight[target + 2] = raw[source + 2] ?? 0;
      tight[target + 3] = raw[source + 3] ?? 0;
    }
  }
  return tight;
}
