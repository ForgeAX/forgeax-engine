import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import {
  Camera,
  type ExternalTexture,
  Materials,
  MeshFilter,
  MeshRenderer,
  type RenderError,
} from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { type MaterialAsset, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { renderValue } from './standard-gbuffer-replay.fixture';

const SIZE = 128;
const EPSILON = Math.round(0.05 * 255);
const EVIDENCE = 'artifacts/pr-evidence/external-texture-video';
const MATERIAL_GUID = '4b9e0c51-2f63-4d8a-9a57-6c1e2d7f0a31';
const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const GREEN = [0, 255, 0];
const WHITE = [255, 255, 255];

async function save(name: string, bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  await commands.writeFile(`${EVIDENCE}/${name}`, btoa(binary), 'base64');
}

function saveJson(name: string, value: unknown) {
  return save(name, new TextEncoder().encode(JSON.stringify(value, null, 2)));
}

function sample(data: Uint8ClampedArray | Uint8Array, x: number, y: number, width = SIZE) {
  return [...data.slice((y * width + x) * 4, (y * width + x) * 4 + 3)];
}

function expectColor(actual: number[], expected: number[], label: string) {
  actual.forEach((value, i) => {
    expect(
      Math.abs(value - (expected[i] ?? Number.NaN)),
      `${label}: ${actual}`,
    ).toBeLessThanOrEqual(EPSILON);
  });
}

function paint(context: CanvasRenderingContext2D, top: string, bottom: string) {
  const { width, height } = context.canvas;
  context.fillStyle = top;
  context.fillRect(0, 0, width, height / 2);
  context.fillStyle = bottom;
  context.fillRect(0, height / 2, width, height / 2);
}

async function createHarness(label: string) {
  const display = document.createElement('canvas');
  display.width = display.height = SIZE;
  display.style.width = display.style.height = `${SIZE}px`;
  document.body.append(display);
  const recorder = attachRecorder(webgpu).unwrap();
  const validation: string[] = [];
  const counters = { importExternal: 0, externalCopies: 0 };
  let lose: (() => void) | undefined;
  let rawDevice: GPUDevice | undefined;
  const host = renderValue(
    await constructRuntimeRendererHost(
      display,
      {
        rhi: recorder.backend.rhi,
        rhiInstrumentation: {
          resolveSurfaceDevice: (device) => {
            const surfaceDevice = recorder.backend.unwrapDeviceForSurface(device).unwrap();
            const raw = webgpu._internal_getRawDevice(surfaceDevice);
            if (raw !== undefined) {
              rawDevice = raw;
              raw.addEventListener('uncapturederror', (event) => {
                validation.push(event.error.message);
              });
              const importExternal = raw.importExternalTexture.bind(raw);
              raw.importExternalTexture = (descriptor) => {
                counters.importExternal += 1;
                return importExternal(descriptor);
              };
            }
            return ok(surfaceDevice);
          },
          deviceLost(device) {
            const copy = device.queue.copyExternalImageToTexture.bind(device.queue);
            device.queue.copyExternalImageToTexture = (...args) => {
              counters.externalCopies += 1;
              return copy(...args);
            };
            return new Promise((resolve) => {
              if (lose === undefined)
                lose = () => {
                  recorder.deviceLost();
                  resolve({ reason: 'unknown', message: `${label} recovery regression` });
                };
            });
          },
        },
      },
      { shaderManifestUrl: '/shaders/manifest.json' },
    ),
  );
  const { renderer, assets } = host;
  const errors: RenderError[] = [];
  const other: unknown[] = [];
  renderer.subscribe((event) => {
    if (event.kind !== 'error') return;
    const coded = event.error instanceof Error && 'code' in event.error;
    if (coded && String(event.error.code).startsWith('external-texture-')) {
      errors.push(event.error as RenderError);
      return;
    }
    if (renderer.state() === 'device-lost') return;
    if (coded) errors.push(event.error as RenderError);
    else other.push(event.error);
  });
  assets.configurePackIndex('/__external-texture-material/pack-index.json');
  const materialGuid = assets.parseGuid(MATERIAL_GUID);
  (await assets.loadByGuid<MaterialAsset>(materialGuid)).unwrap();
  const world = new World();
  const owner = await createWorldContext(world, [scenePlugin()]);
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 3] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 10,
          antialias: 0,
          bloom: 0,
          tonemap: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  let frames = 0;
  const draw = async (count = 1, perFrame?: (frame: number) => void) => {
    for (let i = 0; i < count; i++) {
      perFrame?.(frames);
      world.update(1 / 60).unwrap();
      const receipt = renderValue(
        renderer.draw({
          leases: [lease],
          camera: { lease },
          environment: { lease },
          geometryLane: 'direct',
        }),
      );
      renderValue(await receipt.completed);
      frames++;
    }
  };
  const bind = (texture: ExternalTexture, ordinary = false) => {
    const source = world.allocSharedRef('ExternalTextureSource', texture.source);
    const material = world.allocSharedRef(
      'MaterialAsset',
      ordinary
        ? Materials.unlit([1, 1, 1, 1], { baseColorTexture: source })
        : { kind: 'material', parent: materialGuid, values: { videoTexture: source } },
    );
    return world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0], scale: [3, 3, 1] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  };
  const pixels = async (name: string) => {
    const shot = await page.elementLocator(display).screenshot({ base64: true });
    const base64 = typeof shot === 'string' ? shot : shot.base64;
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    await save(`${label}-${name}.png`, bytes);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const surface = new OffscreenCanvas(SIZE, SIZE);
    const ctx = surface.getContext('2d');
    if (ctx === null) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
    bitmap.close();
    return ctx.getImageData(0, 0, SIZE, SIZE).data;
  };
  const expectHalves = async (name: string, top: number[], bottom: number[]) => {
    const data = await pixels(name);
    expectColor(sample(data, 64, 32), top, `${name} top`);
    expectColor(sample(data, 64, 96), bottom, `${name} bottom`);
    return data;
  };
  const dispose = () => {
    lease.release?.();
    renderer.dispose();
    owner.dispose?.();
    display.remove();
  };
  return {
    renderer,
    world,
    recorder,
    validation,
    counters,
    errors,
    other,
    draw,
    bind,
    pixels,
    expectHalves,
    dispose,
    lose: () => lose?.(),
    rawDevice: () => rawDevice,
  };
}

function writeHalves(
  device: GPUDevice,
  top: number[],
  bottom: number[],
  usage = 0x04 | 0x02 | 0x01,
) {
  const texture = device.createTexture({
    label: 'caller-owned',
    size: { width: 16, height: 16 },
    format: 'rgba8unorm',
    usage,
  });
  const bytes = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) bytes.set([...(y < 8 ? top : bottom), 255], (y * 16 + x) * 4);
  device.queue.writeTexture({ texture }, bytes, { bytesPerRow: 64 }, { width: 16, height: 16 });
  return texture;
}

it('imports a caller GPUTexture into texture_external and ordinary slots through replace, loss and release', async () => {
  if (!navigator.gpu) throw new Error('WebGPU is required');
  const h = await createHarness('gpu-texture');
  try {
    const native = renderValue(h.renderer.nativeDevice());
    expect(native).toBeInstanceOf(GPUDevice);
    let destroyedByEngine = 0;
    const first = writeHalves(native, RED, BLUE);
    const destroy = first.destroy.bind(first);
    first.destroy = () => {
      destroyedByEngine += 1;
      destroy();
    };
    const handle = renderValue(
      await h.renderer.importTexture({ kind: 'gpu-texture', texture: first }),
    );
    const entity = h.bind(handle);
    await h.draw(60);
    await h.expectHalves('external-slot', RED, BLUE);

    h.world.despawn(entity).unwrap();
    const ordinary = h.bind(handle, true);
    await h.draw(3);
    const ordinaryPixels = await h.pixels('ordinary-slot');
    const tops = [sample(ordinaryPixels, 64, 32), sample(ordinaryPixels, 64, 96)];
    expect(tops.some((c) => c[0] > 200 && c[2] < 40)).toBe(true);
    expect(tops.some((c) => c[2] > 200 && c[0] < 40)).toBe(true);
    h.world.despawn(ordinary).unwrap();
    h.bind(handle);

    const second = writeHalves(native, GREEN, WHITE);
    renderValue(await handle.replace({ kind: 'gpu-texture', texture: second }));
    await h.draw(2);
    await h.expectHalves('replaced', GREEN, WHITE);

    const foreignAdapter = await navigator.gpu.requestAdapter();
    const foreignDevice = await foreignAdapter?.requestDevice();
    if (foreignDevice === undefined) throw new Error('second GPUDevice unavailable');
    const wrong = await h.renderer.importTexture({
      kind: 'gpu-texture',
      texture: writeHalves(foreignDevice, RED, RED),
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok)
      expect(wrong.error).toMatchObject({
        code: 'external-texture-invalid',
        detail: { operation: 'import', reason: 'device-mismatch' },
      });
    foreignDevice.destroy();

    const noBinding = await h.renderer.importTexture({
      kind: 'gpu-texture',
      texture: writeHalves(native, RED, RED, 0x02),
    });
    expect(noBinding.ok).toBe(false);
    if (!noBinding.ok) expect(noBinding.error.detail).toMatchObject({ reason: 'usage' });

    h.lose();
    await expect.poll(() => h.renderer.state()).toBe('device-lost');
    renderValue(await h.renderer.recover());
    await h.draw(2);
    const stale = h.errors.filter((e) => e.code === 'external-texture-state-invalid');
    expect(stale.map((e) => e.detail)).toEqual([
      { operation: 'bind', reason: 'stale-generation', generation: expect.any(Number) },
    ]);
    const recoveredNative = renderValue(h.renderer.nativeDevice());
    expect(recoveredNative).not.toBe(native);
    const oldDeviceImport = await h.renderer.importTexture({ kind: 'gpu-texture', texture: first });
    expect(oldDeviceImport.ok).toBe(false);
    renderValue(
      await handle.replace({
        kind: 'gpu-texture',
        texture: writeHalves(recoveredNative, BLUE, RED),
      }),
    );
    await h.draw(2);
    await h.expectHalves('recovered', BLUE, RED);

    renderValue(handle.release());
    const released = handle.release();
    expect(released.ok).toBe(false);
    await h.draw(2);
    expect(
      h.errors.filter((e) => e.code === 'external-texture-state-invalid').map((e) => e.detail),
    ).toContainEqual({ operation: 'bind', reason: 'released', generation: expect.any(Number) });
    expect(destroyedByEngine).toBe(0);
    await saveJson('gpu-texture-lifecycle.json', {
      frames: 60 + 3 + 2 + 2 + 2 + 2,
      epsilon: EPSILON,
      wrongDevice: wrong.ok ? null : wrong.error.detail,
      usage: noBinding.ok ? null : noBinding.error.detail,
      oldDeviceAfterRecovery: oldDeviceImport.ok ? null : oldDeviceImport.error.detail,
      stateErrors: h.errors
        .filter((e) => e.code === 'external-texture-state-invalid')
        .map((e) => e.detail),
      destroyedByEngine,
      validation: h.validation,
    });
    expect(h.validation).toEqual([]);
    expect(h.other).toEqual([]);
  } finally {
    h.dispose();
  }
}, 120_000);

it('zero-copies a live HTMLVideoElement and per-frame VideoFrames, rejecting an expired frame', async () => {
  if (!navigator.gpu) throw new Error('WebGPU is required');
  const h = await createHarness('video');
  const producer = document.createElement('canvas');
  producer.width = producer.height = 64;
  const context = producer.getContext('2d');
  if (context === null) throw new Error('2D context unavailable');
  paint(context, '#ff0000', '#0000ff');
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = producer.captureStream(60);
  document.body.append(video);
  try {
    await video.play();
    await expect.poll(() => video.readyState >= 2 && video.videoWidth > 0).toBe(true);
    expect(h.renderer.state()).toBe('alive');
    const handle = renderValue(await h.renderer.importTexture({ kind: 'video', source: video }));
    h.bind(handle);
    const importsBefore = h.counters.importExternal;
    const copiesBefore = h.counters.externalCopies;
    await h.draw(60, () => paint(context, '#ff0000', '#0000ff'));
    const videoImports = h.counters.importExternal - importsBefore;
    expect(videoImports).toBeGreaterThanOrEqual(60);
    expect(h.counters.externalCopies - copiesBefore).toBe(0);
    await h.expectHalves('html-video', RED, BLUE);

    paint(context, '#00ff00', '#ffffff');
    await expect
      .poll(async () => {
        await h.draw(1, () => paint(context, '#00ff00', '#ffffff'));
        const data = await h.pixels('html-video-live');
        return sample(data, 64, 32)[1] > 200 && sample(data, 64, 32)[0] < 40;
      })
      .toBe(true);
    await h.expectHalves('html-video-live', GREEN, WHITE);

    paint(context, '#0000ff', '#ff0000');
    let frame = new VideoFrame(producer, { timestamp: 0 });
    renderValue(await handle.replace({ kind: 'video', source: frame }));
    const frameImportsBefore = h.counters.importExternal;
    for (let i = 0; i < 60; i++) {
      await h.draw(1);
      const next = new VideoFrame(producer, { timestamp: (i + 1) * 16_667 });
      renderValue(await handle.replace({ kind: 'video', source: next }));
      frame.close();
      frame = next;
    }
    expect(h.counters.importExternal - frameImportsBefore).toBeGreaterThanOrEqual(60);
    expect(h.counters.externalCopies - copiesBefore).toBe(0);
    await h.draw(1);
    await h.expectHalves('video-frame', BLUE, RED);

    const liveCapture = h.recorder.captureFrame();
    (await h.recorder.frameBoundary()).unwrap();
    await h.draw(1);
    (await h.recorder.frameBoundary()).unwrap();
    const captured = (await liveCapture).unwrap();
    await save('video-frame.rhitape', captured.bytes);
    const livePixels = await h.expectHalves('video-frame-captured', BLUE, RED);

    frame.close();
    const errorsBefore = h.other.length + h.errors.length;
    await h.draw(3);
    const expired = [...h.other, ...h.errors].slice(errorsBefore);
    expect(expired.length).toBe(1);
    expect(expired[0]).toMatchObject({
      code: 'external-texture-state-invalid',
      detail: { operation: 'bind', reason: 'source-expired' },
    });
    expect(h.renderer.state()).toBe('alive');

    const tape = decodeTape(captured.bytes).unwrap();
    const model = buildFrameModel(tape);
    const snapshots = model.resources.filter(
      (row) =>
        row.kind === 'texture' && JSON.stringify(row.descriptor).includes('external-snapshot'),
    );
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    const snapshotIds = new Set(snapshots.map((row) => row.resourceId));
    const snapshotViews = new Set(
      model.resources
        .filter((row) => {
          const descriptor = row.descriptor;
          return (
            descriptor !== null &&
            typeof descriptor === 'object' &&
            'sourceHandleId' in descriptor &&
            snapshotIds.has(descriptor.sourceHandleId as string)
          );
        })
        .map((row) => row.resourceId),
    );
    const videoDraw = model.works.find(
      (row) =>
        (row.kind === 'draw' || row.kind === 'drawIndexed') &&
        row.bindings.some((b) => b.resourceId !== null && snapshotViews.has(b.resourceId)),
    );
    if (videoDraw === undefined) throw new Error('video draw missing from capture');
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const fresh = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    const replayValidation: string[] = [];
    webgpu._internal_getRawDevice(fresh)?.addEventListener('uncapturederror', (event) => {
      replayValidation.push(event.error.message);
    });
    const replay = (
      await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      // Bindings are captured model facts; only presented pixels need GPU replay.
      const last = model.works.at(-1);
      if (last === undefined) throw new Error('Missing presented work');
      const presented = (await replay.inspectWork(last.workIndex, ['pixels'])).unwrap().attachment;
      if (presented === undefined) throw new Error('Missing replay pixels');
      const screen = new Uint8ClampedArray(presented.bytes);
      if (presented.format?.startsWith('bgra'))
        for (let i = 0; i < screen.length; i += 4) {
          const red = screen[i];
          screen[i] = screen[i + 2] ?? 0;
          screen[i + 2] = red ?? 0;
        }
      const replayCanvas = new OffscreenCanvas(presented.width, presented.height);
      replayCanvas
        .getContext('2d')
        ?.putImageData(new ImageData(screen, presented.width, presented.height), 0, 0);
      await save(
        'video-frame-replay.png',
        new Uint8Array(await (await replayCanvas.convertToBlob()).arrayBuffer()),
      );
      const diff = [
        [64, 32],
        [64, 96],
      ].map(([x, y]) => {
        const live = sample(livePixels, x ?? 0, y ?? 0);
        const replayed = sample(screen, x ?? 0, y ?? 0, presented.width);
        return {
          x,
          y,
          live,
          replayed,
          maxAbs: Math.max(...live.map((v, i) => Math.abs(v - (replayed[i] ?? 0)))),
        };
      });
      for (const row of diff) expect(row.maxAbs, JSON.stringify(row)).toBeLessThanOrEqual(EPSILON);
      await saveJson('video-frame-replay.json', {
        digest: captured.digest,
        workIndex: videoDraw.workIndex,
        snapshotTextures: snapshots.map((row) => row.resourceId),
        unseededResources: model.unseededResources,
        bindings: videoDraw.bindings,
        liveVsReplay: diff,
        replayValidation,
      });
      expect(replayValidation).toEqual([]);
    } finally {
      (await replay.dispose()).unwrap();
      webgpu._internal_getRawDevice(fresh)?.destroy();
    }
    await saveJson('video-zero-copy.json', {
      htmlVideoFrames: 60,
      videoFrameFrames: 60,
      importExternalTextureCalls: h.counters.importExternal,
      copyExternalImageToTextureCalls: h.counters.externalCopies - copiesBefore,
      expiredFrameError:
        expired[0] instanceof Error
          ? { code: (expired[0] as { code?: string }).code, message: expired[0].message }
          : expired[0],
      validation: h.validation,
    });
    renderValue(handle.release());
    expect(h.validation).toEqual([]);
  } finally {
    video.pause();
    video.remove();
    h.dispose();
  }
}, 120_000);

it('copies video for ordinary slots and keeps texture_external slots unflipped', async () => {
  if (!navigator.gpu) throw new Error('WebGPU is required');
  const h = await createHarness('video-copy');
  const producer = document.createElement('canvas');
  producer.width = producer.height = 64;
  const context = producer.getContext('2d');
  if (context === null) throw new Error('2D context unavailable');
  paint(context, '#ff0000', '#0000ff');
  const frame = new VideoFrame(producer, { timestamp: 0 });
  try {
    const handle = renderValue(await h.renderer.importTexture({ kind: 'video', source: frame }));
    h.bind(handle, true);
    await h.draw(60);
    expect(h.counters.externalCopies).toBeGreaterThanOrEqual(1);
    const data = await h.pixels('ordinary-copy');
    const halves = [sample(data, 64, 32), sample(data, 64, 96)];
    expect(halves.some((c) => c[0] > 200 && c[2] < 40)).toBe(true);
    expect(halves.some((c) => c[2] > 200 && c[0] < 40)).toBe(true);
    expect(h.validation).toEqual([]);
    expect(h.errors).toEqual([]);
    renderValue(handle.release());
  } finally {
    frame.close();
    h.dispose();
  }
}, 120_000);
