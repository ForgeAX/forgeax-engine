import assert from 'node:assert/strict';
import { emitSmokeReceipt, smokeFrameBudget } from '../../../shared/scripts/smoke-receipt.mjs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SMOKE_MIN_FRAMES = smokeFrameBudget();

const WIDTH = 320;
const HEIGHT = 240;

// --- 1. dawn.node binding setup ---

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
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: gpu,
  configurable: true,
  writable: true,
});
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalAmbientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await originalAmbientRequestAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return rawAdapter;
};

// --- 2. Mock canvas ---

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

const { World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import(
  '@forgeax/engine-runtime/internal/renderer-host'
);
const { createGizmoScene } = await import('../src/scene.ts');
const { Transform } = await import('@forgeax/engine-scene');
const { writeReferencePng } = await import('../../../shared/png-codec.mjs');
const { mkdirSync, writeFileSync } = await import('node:fs');
const here = dirname(fileURLToPath(import.meta.url));
const manifest = readFileSync(resolve(here, '../dist/shaders/manifest.json'), 'utf8');
const host = await constructRuntimeRendererHost(
  mockCanvas,
  {},
  { shaderManifestUrl: `data:application/json,${encodeURIComponent(manifest)}` },
);
assert(host.ok, JSON.stringify(host.error));
const renderer = host.value.renderer,
  world = new World();
const attachment = renderer.attach(world).unwrap(),
  scene = createGizmoScene(world, WIDTH, HEIGHT);
scene.gizmo.configure({ size: 55 });
const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push(event.error);
});
let framesObserved = 0;
async function draw() {
  world.update().unwrap();
  scene.sync();
  const receipt = renderer
    .draw({
      leases: [attachment],
      camera: { lease: attachment },
      environment: { lease: attachment },
    })
    .unwrap();
  const observed = await renderer.observe(receipt, { include: ['draws'] });
  assert(observed.ok, JSON.stringify(observed.error));
  await sharedDevice.queue.onSubmittedWorkDone();
  framesObserved++;
}
async function pixels() {
  const stride = Math.ceil((WIDTH * 4) / 256) * 256;
  const buffer = sharedDevice.createBuffer({
    size: stride * HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = sharedDevice.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer, bytesPerRow: stride },
    { width: WIDTH, height: HEIGHT },
  );
  sharedDevice.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const raw = new Uint8Array(buffer.getMappedRange()),
    out = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++)
    out.set(raw.subarray(y * stride, y * stride + WIDTH * 4), y * WIDTH * 4);
  buffer.unmap();
  buffer.destroy();
  return out;
}
const evidence = [];
const outDir = process.env.GIZMO_EVIDENCE_DIR;
if (outDir) mkdirSync(outDir, { recursive: true });
try {
  // Same scene and camera, overlay-off baseline. Each mode contributes real completed frames.
  scene.enable(false);
  for (let i = 0; i < 4; i++) await draw();
  const baseline = await pixels();
  for (const mode of ['translate', 'rotate', 'scale']) {
    scene.gizmo.configure({ mode });
    scene.enable(process.env.GIZMO_FALSIFY !== '1');
    for (let i = 0; i < Math.ceil(SMOKE_MIN_FRAMES / 3); i++) await draw();
    const image = await pixels();
    let changed = 0;
    const color = [0, 0, 0];
    for (let i = 0; i < image.length; i += 4) {
      if (
        Math.abs(image[i] - baseline[i]) +
          Math.abs(image[i + 1] - baseline[i + 1]) +
          Math.abs(image[i + 2] - baseline[i + 2]) >
        60
      )
        changed++;
      for (let c = 0; c < 3; c++)
        if (
          image[i + c] > 140 &&
          image[i + c] > image[i + ((c + 1) % 3)] * 1.35 &&
          image[i + c] > image[i + ((c + 2) % 3)] * 1.35
        )
          color[c]++;
    }
    assert(changed > 100, `${mode}: missing overlay pixels ${changed}`);
    assert(
      color.every((n) => n > 12),
      `${mode}: axis color coverage ${color}`,
    );
    evidence.push({ mode, changedPixels: changed, axisColorPixels: color });
    if (outDir)
      writeFileSync(resolve(outDir, `dawn-${mode}.png`), writeReferencePng(image, WIDTH, HEIGHT));
  }
  scene.gizmo.configure({ mode: 'translate' });
  scene.sync();
  const f = scene.gizmo.frame;
  const start = f.project(f.origin.map((n, i) => n + f.axes[0][i] * f.radius * 0.75));
  assert(scene.gizmo.begin(start[0], start[1]));
  assert(scene.gizmo.move(start[0] + 20, start[1]));
  scene.gizmo.commit();
  assert(world.get(scene.target, Transform).unwrap().pos[0] > 0.1);
  scene.presentation.dispose();
  await draw();
  assert.equal(world.inspect().entityCount, 5);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log(
    JSON.stringify(
      {
        framesObserved,
        backend: renderer.inspect().capabilities.backendKind,
        resolution: [WIDTH, HEIGHT],
        pixels: evidence,
        errors,
      },
      null,
      2,
    ),
  );
  emitSmokeReceipt('hello-transform-gizmo/smoke', framesObserved);
} finally {
  renderer.dispose();
  sharedDevice.destroy();
}
process.exit(0);
