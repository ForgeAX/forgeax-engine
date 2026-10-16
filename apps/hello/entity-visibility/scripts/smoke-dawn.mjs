#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

const WIDTH = 200;
const HEIGHT = 150;
const TARGET_ROI = { x0: 280, y0: 225, x1: 360, y1: 315 };
const SHADOW_ROI = { x0: 220, y0: 310, x1: 320, y1: 355 };
const CHILD_ROI = { x0: 380, y0: 200, x1: 480, y1: 310 };

function describeStructuredError(error) {
  if (typeof error !== 'object' || error === null) return error;
  return {
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    detail: error.detail,
    message: error.message,
  };
}

function createMockCanvas(sharedDevice, renderTargetRef) {
  const ensureTarget = (device, format) => {
    renderTargetRef.value ??= device.createTexture({
      size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      format,
      usage: 0x10 | 0x01,
      viewFormats: ['rgba8unorm-srgb'],
    });
    return renderTargetRef.value;
  };
  return {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind) {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc) {
          ensureTarget(desc.device, desc.format ?? 'rgba8unorm');
        },
        unconfigure() {},
        getCurrentTexture() {
          if (renderTargetRef.value === undefined) ensureTarget(sharedDevice.value, 'rgba8unorm');
          return renderTargetRef.value;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

async function createDawn() {
  const { create, globals } = await import('@forgeax/engine-dawn-node');
  Object.assign(globalThis, globals);
  if (globalThis.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  }
  const gpu = create([]);
  gpu.getPreferredCanvasFormat = () => 'rgba8unorm';
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: gpu,
    configurable: true,
    writable: true,
  });
  return gpu;
}

function spawnScene(world, render, scenePackage) {
  const {
    Camera,
    DirectionalLight,
    Materials,
    MeshFilter,
    MeshRenderer,
    perspective,
  } = render;
  const { resolveVisibility, Visibility, VisibilityStateValue } = render;
  const { ChildOf, Transform } = world.scene;
  const { HANDLE_CUBE } = world.assets;
  const material = (color) =>
    world.value.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: color, roughness: 0.55 }),
    );
  const floor = material([0.24, 0.28, 0.34, 1]);
  const blue = material([0.08, 0.3, 0.95, 1]);
  const red = material([0.9, 0.12, 0.08, 1]);
  const gold = material([0.95, 0.65, 0.08, 1]);
  const mesh = (position, scale, materialRef, parent) =>
    world.value
      .spawn(
        { component: Transform, data: { pos: position, quat: [0, 0, 0, 1], scale } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [materialRef] } },
        { component: Visibility, data: { state: VisibilityStateValue.inherited } },
        ...(parent === undefined ? [] : [{ component: ChildOf, data: { parent } }]),
      )
      .unwrap();
  world.value
    .spawn(
      { component: Transform, data: { pos: [0, -1.35, 0], scale: [5, 0.15, 3] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [floor] } },
    )
    .unwrap();
  mesh([-1.6, 0, 0], [0.8, 0.8, 0.8], blue);
  const target = mesh([0, 0, 0], [0.8, 0.8, 0.8], red);
  const ancestor = world.value
    .spawn(
      { component: Transform, data: { pos: [1.7, 0, 0] } },
      { component: Visibility, data: { state: VisibilityStateValue.inherited } },
    )
    .unwrap();
  const visibleChild = mesh([0, 0, 0], [0.72, 0.72, 0.72], blue, ancestor);
  world.value.set(visibleChild, Visibility, { state: VisibilityStateValue.visible }).unwrap();
  const inheritedDescendant = mesh([0, 0.95, 0], [0.32, 0.32, 0.32], gold, visibleChild);
  world.value
    .spawn(
      { component: Transform, data: { pos: [0, 1.4, 7], quat: [0, 0, 0, 1] } },
      {
        component: Camera,
        data: perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 }),
      },
    )
    .unwrap();
  world.value
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.5, -1, -0.35], color: [1, 1, 1], intensity: 1.5, castShadow: true,
        // This 200x150 fixture checks visibility and shadow participation.
        // Cover its small scene with one real shadow map; the default four
        // 2048px cascades made 60 frames exceed 120s on software Vulkan.
        cascadeCount: 1, mapSize: 256, shadowDistance: 20,
      },
    })
    .unwrap();
  return {
    setTargetHidden: () =>
      world.value.set(target, Visibility, { state: VisibilityStateValue.hidden }).unwrap(),
    setTargetVisible: () =>
      world.value.set(target, Visibility, { state: VisibilityStateValue.visible }).unwrap(),
    setAncestorHidden: () =>
      world.value.set(ancestor, Visibility, { state: VisibilityStateValue.hidden }).unwrap(),
    evidence: () => {
      const snapshot = resolveVisibility(world.value);
      return {
        target: snapshot.effective(target),
        visibleChild: snapshot.effective(visibleChild),
        inheritedDescendant: snapshot.effective(inheritedDescendant),
      };
    },
  };
}

function scaledRoi(roi) {
  return {
    x0: Math.floor((roi.x0 / 640) * WIDTH),
    y0: Math.floor((roi.y0 / 360) * HEIGHT),
    x1: Math.ceil((roi.x1 / 640) * WIDTH),
    y1: Math.ceil((roi.y1 / 360) * HEIGHT),
  };
}

function colorCount(frame, roi, color) {
  const area = scaledRoi(roi);
  let count = 0;
  for (let y = area.y0; y < area.y1; y += 1) {
    for (let x = area.x0; x < area.x1; x += 1) {
      const offset = y * frame.bytesPerRow + x * 4;
      const red = frame.data[offset] ?? 0;
      const green = frame.data[offset + 1] ?? 0;
      const blue = frame.data[offset + 2] ?? 0;
      if (color === 'red' && red > 60 && red > green * 1.35 && red > blue * 1.2) count += 1;
      if (color === 'blue' && blue > 55 && blue > red * 1.2 && blue > green * 1.05) count += 1;
      if (color === 'gold' && red > 60 && green > 35 && red > blue * 1.5 && green > blue * 1.2)
        count += 1;
    }
  }
  return count;
}

function roiDelta(first, second, roi) {
  const area = scaledRoi(roi);
  let changedPixels = 0;
  let totalL1 = 0;
  let pixels = 0;
  for (let y = area.y0; y < area.y1; y += 1) {
    for (let x = area.x0; x < area.x1; x += 1) {
      const firstOffset = y * first.bytesPerRow + x * 4;
      const secondOffset = y * second.bytesPerRow + x * 4;
      const l1 =
        Math.abs((first.data[firstOffset] ?? 0) - (second.data[secondOffset] ?? 0)) +
        Math.abs((first.data[firstOffset + 1] ?? 0) - (second.data[secondOffset + 1] ?? 0)) +
        Math.abs((first.data[firstOffset + 2] ?? 0) - (second.data[secondOffset + 2] ?? 0));
      if (l1 > 12) changedPixels += 1;
      totalL1 += l1;
      pixels += 1;
    }
  }
  return { changedPixels, meanL1: totalL1 / pixels };
}

async function readback(device, texture) {
  await device.queue.onSubmittedWorkDone();
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const data = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return { data, bytesPerRow };
}

async function capturePhase(scene, diagnostics, device, texture) {
  const frame = await readback(device, texture);
  return {
    frame,
    scene: scene.evidence(),
    explicitlyHidden: diagnostics.visibilityStats.explicitlyHidden,
    shadowPasses: diagnostics.perFramePassNames.filter((name) => name.includes('shadow')),
  };
}

export async function runVisibilityDawnSmoke({ frames = 60 } = {}) {
  const gpu = await createDawn();
  const sharedDevice = { value: undefined };
  const renderTarget = { value: undefined };
  const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (options) => {
    const adapter = await originalRequestAdapter(options);
    if (adapter === null) return adapter;
    const originalRequestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const device = await originalRequestDevice(descriptor);
      sharedDevice.value ??= device;
      return device;
    };
    return adapter;
  };
  const canvas = createMockCanvas(sharedDevice, renderTarget);
  const [{ createWorldContext, World }, render, scenePackage, assets] = await Promise.all([
    import('@forgeax/engine-ecs'),
    import('@forgeax/engine-render'),
    import('@forgeax/engine-scene'),
    import('@forgeax/engine-assets-runtime'),
  ]);
  const world = { value: new World(), scene: scenePackage, assets };
  await createWorldContext(world.value, [scenePackage.scenePlugin()]);
  const scene = spawnScene(world, render, scenePackage);
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  const engineManifest = await buildEngineShaderManifest();
  const manifestUrl = URL.createObjectURL(new Blob([JSON.stringify(engineManifest)], { type: 'application/json' }));
  process.once('exit', () => URL.revokeObjectURL(manifestUrl));
  const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
  const created = await constructRuntimeRendererHost(canvas, {}, { shaderManifestUrl: manifestUrl });
  if (!created.ok) throw new Error(JSON.stringify(describeStructuredError(created.error)));
  const renderer = created.value.renderer;
  // These are intentionally low-level harness diagnostics; the public
  // Renderer exposes only POD inspection and receipt-bound observation.
  const diagnostics = created.value.debugDrawHost;
  gpu.requestAdapter = originalRequestAdapter;
  const attachment = renderer.attach(world.value);
  if (!attachment.ok) throw new Error(JSON.stringify(describeStructuredError(attachment.error)));
  const errors = [];
  renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
  });
  const captureFrames = {
    baseline: Math.floor(frames * 0.3),
    hidden: Math.floor(frames * 0.63),
    restored: Math.floor(frames * 0.8),
    child: frames - 1,
  };
  const captures = {};
  for (let frame = 0; frame < frames; frame += 1) {
    if (frame === 0) scene.setTargetVisible();
    if (frame === Math.floor(frames / 3)) scene.setTargetHidden();
    if (frame === Math.floor((frames * 2) / 3)) scene.setTargetVisible();
    if (frame === Math.floor((frames * 5) / 6)) scene.setAncestorHidden();
    const updateResult = world.value.update(1 / 60);
    if (!updateResult.ok) errors.push(describeStructuredError(updateResult.error));
    const drawResult = renderer.draw({
      leases: [attachment.value],
      camera: { lease: attachment.value },
      environment: { lease: attachment.value },
    });
    if (!drawResult.ok) {
      errors.push(describeStructuredError(drawResult.error));
    } else {
      const completed = await drawResult.value.completed;
      if (!completed.ok) errors.push(describeStructuredError(completed.error));
    }
    for (const [phase, captureFrame] of Object.entries(captureFrames)) {
      if (frame === captureFrame) {
        captures[phase] = await capturePhase(scene, diagnostics, sharedDevice.value, renderTarget.value);
      }
    }
  }
  const { baseline, hidden, restored, child } = captures;
  if (
    baseline === undefined ||
    hidden === undefined ||
    restored === undefined ||
    child === undefined
  ) {
    throw new Error('one or more Dawn readback phases were not captured');
  }
  const targetRed = {
    baseline: colorCount(baseline.frame, TARGET_ROI, 'red'),
    hidden: colorCount(hidden.frame, TARGET_ROI, 'red'),
    restored: colorCount(restored.frame, TARGET_ROI, 'red'),
  };
  const childColors = {
    blue: colorCount(child.frame, CHILD_ROI, 'blue'),
    gold: colorCount(child.frame, CHILD_ROI, 'gold'),
  };
  const hiddenShadowDelta = roiDelta(baseline.frame, hidden.frame, SHADOW_ROI);
  const restoredShadowDelta = roiDelta(restored.frame, hidden.frame, SHADOW_ROI);
  const result = {
    backend: renderer.inspect().capabilities.backendKind,
    frames,
    targetRed,
    childColors,
    hiddenShadowDelta,
    restoredShadowDelta,
    hiddenTargetEffective: hidden.scene.target,
    restoredTargetEffective: restored.scene.target,
    visibleChildEffective: child.scene.visibleChild,
    inheritedDescendantEffective: child.scene.inheritedDescendant,
    hiddenVisibilityStats: hidden.explicitlyHidden,
    restoredShadowPasses: restored.shadowPasses,
    errors,
  };
  console.log(`[hello-entity-visibility] backend=${result.backend}`);
  console.log(`[smoke] frames observed=${result.frames}`);
  console.log(`[smoke] criteria=${JSON.stringify(result)}`);
  const failures = [];
  if (result.backend !== 'webgpu') failures.push('backend is not webgpu');
  if (result.frames < frames) failures.push(`fewer than ${frames} frames observed`);
  if (result.targetRed.baseline <= 80) failures.push('baseline target ROI has no red pixels');
  if (result.targetRed.hidden >= result.targetRed.baseline * 0.05)
    failures.push('hidden target remains in GPU readback');
  if (result.targetRed.restored <= result.targetRed.baseline * 0.8)
    failures.push('restored target is absent from GPU readback');
  if (result.hiddenShadowDelta.changedPixels <= 30 || result.hiddenShadowDelta.meanL1 <= 5) {
    failures.push('hidden target shadow remains in GPU readback');
  }
  if (result.restoredShadowDelta.changedPixels <= 30 || result.restoredShadowDelta.meanL1 <= 5) {
    failures.push('restored target shadow is absent from GPU readback');
  }
  if (result.childColors.blue <= 60 || result.childColors.gold <= 5)
    failures.push('visible child hierarchy is absent from GPU readback');
  if (result.hiddenTargetEffective !== 'hidden' || result.hiddenVisibilityStats < 1)
    failures.push('hidden visibility gate did not reject the target');
  if (result.restoredTargetEffective !== 'visible')
    failures.push('restored target did not resolve visible');
  if (
    result.visibleChildEffective !== 'visible' ||
    result.inheritedDescendantEffective !== 'visible'
  )
    failures.push('visible child override did not resolve visible');
  if (result.restoredShadowPasses.length < 1)
    failures.push('renderer shadow pass is absent');
  if (result.errors.length > 0) failures.push(`renderer errors: ${JSON.stringify(result.errors)}`);
  await renderer.dispose();
  renderTarget.value?.destroy?.();
  sharedDevice.value?.destroy?.();
  delete globalThis.navigator.gpu;
  if (failures.length > 0)
    throw new Error(`entity visibility smoke failed: ${failures.join('; ')}`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runVisibilityDawnSmoke({ frames: Math.max(60, Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10)) });
    emitSmokeReceipt('hello-entity-visibility/smoke', result.frames);
  } catch (error) {
    console.error(`[smoke] FAIL - ${JSON.stringify(describeStructuredError(error))}`);
    process.exit(1);
  }
}
