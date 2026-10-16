import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { Camera, Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { type MaterialAsset, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { renderValue } from './standard-gbuffer-replay.fixture';

const MATERIAL_GUID = '4b9e0c51-2f63-4d8a-9a57-6c1e2d7f0a31';
const LIGHTWEIGHT = import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1';
const WARMUP = LIGHTWEIGHT ? 4 : 20;
const FRAMES = LIGHTWEIGHT ? 24 : 120;

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const mean = sorted.reduce((sum, v) => sum + v, 0) / Math.max(1, sorted.length);
  return {
    n: sorted.length,
    mean: +mean.toFixed(4),
    p50: +at(0.5).toFixed(4),
    p95: +at(0.95).toFixed(4),
  };
}

async function measure(width: number, height: number, mode: 'zero-copy' | 'copy') {
  const display = document.createElement('canvas');
  display.width = display.height = 256;
  document.body.append(display);
  const counters = { importExternal: 0, copies: 0 };
  const host = renderValue(
    await constructRuntimeRendererHost(
      display,
      {
        rhi: webgpu.rhi,
        gpuPassTiming: { maxPassesPerFrame: 64, maxFramesInFlight: 2, retentionFrames: 8 },
        rhiInstrumentation: {
          resolveSurfaceDevice: (device) => {
            const raw = webgpu._internal_getRawDevice(device);
            if (raw !== undefined) {
              const importExternal = raw.importExternalTexture.bind(raw);
              raw.importExternalTexture = (descriptor) => {
                counters.importExternal += 1;
                return importExternal(descriptor);
              };
              const copy = raw.queue.copyExternalImageToTexture.bind(raw.queue);
              raw.queue.copyExternalImageToTexture = (...args) => {
                counters.copies += 1;
                return copy(...args);
              };
            }
            return ok(device);
          },
        },
      },
      { shaderManifestUrl: '/shaders/manifest.json' },
    ),
  );
  const { renderer, assets } = host;
  assets.configurePackIndex('/__external-texture-material/pack-index.json');
  const guid = assets.parseGuid(MATERIAL_GUID);
  (await assets.loadByGuid<MaterialAsset>(guid)).unwrap();
  const producer = document.createElement('canvas');
  producer.width = width;
  producer.height = height;
  const context = producer.getContext('2d');
  if (context === null) throw new Error('2D context unavailable');
  const paint = (frame: number) => {
    context.fillStyle = `hsl(${(frame * 7) % 360} 80% 50%)`;
    context.fillRect(0, 0, width, height);
  };
  paint(0);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  const stream = producer.captureStream(60);
  video.srcObject = stream;
  document.body.append(video);
  const world = new World();
  const owner = await createWorldContext(world, [scenePlugin()]);
  try {
    await video.play();
    await expect.poll(() => video.readyState >= 2 && video.videoWidth === width).toBe(true);
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
          },
        },
      )
      .unwrap();
    const handle = renderValue(await renderer.importTexture({ kind: 'video', source: video }));
    const source = world.allocSharedRef('ExternalTextureSource', handle.source);
    const material = world.allocSharedRef(
      'MaterialAsset',
      mode === 'copy'
        ? Materials.unlit([1, 1, 1, 1], { baseColorTexture: source })
        : { kind: 'material', parent: guid, values: { videoTexture: source } },
    );
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0], scale: [3, 3, 1] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    const lease = renderValue(renderer.attach(world));
    const cpuMs: number[] = [];
    const completedMs: number[] = [];
    const gpuMs: number[] = [];
    let timingStatus = 'none';
    let before = { ...counters };
    for (let frame = 0; frame < WARMUP + FRAMES; frame++) {
      paint(frame);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (frame === WARMUP) before = { ...counters };
      world.update(1 / 60).unwrap();
      const start = performance.now();
      const receipt = renderValue(
        renderer.draw({
          leases: [lease],
          camera: { lease },
          environment: { lease },
          geometryLane: 'direct',
        }),
      );
      const submitted = performance.now();
      renderValue(await receipt.completed);
      const completed = performance.now();
      const observed = await renderer.observe(receipt, { include: ['timings'] });
      if (frame < WARMUP) continue;
      cpuMs.push(submitted - start);
      completedMs.push(completed - start);
      const timings = observed.ok ? observed.value.timings : undefined;
      timingStatus = timings?.status ?? (observed.ok ? 'omitted' : observed.error.code);
      if (timings?.status === 'complete' || timings?.status === 'partial')
        gpuMs.push(timings.frame.measuredPassNanoseconds / 1e6);
    }
    const imports = counters.importExternal - before.importExternal;
    const copies = counters.copies - before.copies;
    if (mode === 'zero-copy') {
      expect(imports).toBeGreaterThanOrEqual(FRAMES);
      expect(copies).toBe(0);
    } else {
      expect(imports).toBe(0);
      expect(copies).toBeGreaterThan(0);
    }
    renderValue(handle.release());
    lease.release?.();
    return {
      resolution: `${width}x${height}`,
      mode,
      frames: FRAMES,
      importExternalTextureCalls: imports,
      copyExternalImageToTextureCalls: copies,
      cpuSubmitMs: stats(cpuMs),
      submitToCompletedMs: stats(completedMs),
      gpuPassMs: gpuMs.length > 0 ? stats(gpuMs) : null,
      gpuTimingStatus: timingStatus,
    };
  } finally {
    video.pause();
    video.srcObject = null;
    for (const track of stream.getTracks()) track.stop();
    video.remove();
    renderValue(await renderer.dispose());
    await owner.dispose?.();
    display.remove();
  }
}

it('measures zero-copy video against the copy path at two source resolutions', async () => {
  if (!navigator.gpu) throw new Error('WebGPU is required');
  const rows = [];
  // This is a diagnostic, not a resolution-specific performance threshold.
  // Keep two source sizes and both native paths on software GPU CI.
  const resolutions = LIGHTWEIGHT
    ? ([
        [960, 540],
        [1280, 720],
      ] as const)
    : ([
        [1280, 720],
        [1920, 1080],
      ] as const);
  for (const [width, height] of resolutions) {
    for (const mode of ['zero-copy', 'copy'] as const)
      rows.push(await measure(width, height, mode));
  }
  const text = JSON.stringify(
    {
      environment: {
        userAgent: navigator.userAgent,
        note: 'Local headless Chromium; the copy row samples through an ordinary unlit slot. copyExternalImageToTexture runs on the queue outside timestamped passes, so its GPU cost appears in submitToCompletedMs, not gpuPassMs.',
      },
      rows,
    },
    null,
    2,
  );
  await commands.writeFile('artifacts/pr-evidence/external-texture-video/perf.json', text);
}, 300_000);
