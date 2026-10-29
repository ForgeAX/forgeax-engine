import { GCProfiler, getHeapStatistics } from 'node:v8';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { DEFAULT_WEBGPU_STUB_PROFILE, installWebGpuStub, rhi } from '@forgeax/engine-rhi-webgpu';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { buildEngineShaderManifest } from '../../../vite-plugin-shader/src/index';
import { createRenderer } from '../assembly/factory';
import { Camera } from '../components/camera';
import { DirectionalLight } from '../components/directional-light';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { Materials } from '../materials';

// Low-count steady-frame constants on the ordinary WebGPU adapter (stub
// device, no GPU execution). A frame with no or few authored changes must not
// rebuild per-frame native objects, and its JS allocation stays bounded by a
// small constant. Budgets carry generous headroom over the measured value so
// JIT tiering and unrelated small additions do not flake; a structural
// regression (per-entity or per-pass rebuilds, per-frame inspection
// snapshots) exceeds them by multiples.
// Newer Node reports V8's cumulative counter (its bundled typings predate it).
// Older Node (CI's pinned release) derives the same quantity: heap growth over
// the window plus the bytes every collection inside it reclaimed.
const cumulativeAllocatedBytes = (): number | undefined =>
  (getHeapStatistics() as ReturnType<typeof getHeapStatistics> & { total_allocated_bytes?: number })
    .total_allocated_bytes;
async function allocatedAcross(run: () => Promise<void>): Promise<number> {
  const before = cumulativeAllocatedBytes();
  if (before !== undefined) {
    await run();
    return (cumulativeAllocatedBytes() ?? before) - before;
  }
  const profiler = new GCProfiler();
  const startUsed = getHeapStatistics().used_heap_size;
  profiler.start();
  await run();
  const endUsed = getHeapStatistics().used_heap_size;
  let reclaimed = 0;
  for (const gc of profiler.stop()?.statistics ?? [])
    reclaimed += gc.beforeGC.heapStatistics.usedHeapSize - gc.afterGC.heapStatistics.usedHeapSize;
  return endUsed - startUsed + reclaimed;
}
const ENTITIES = 64;
const WARMUP = 60;
const FRAMES = 60;
// Measured 2026-10-25 (Node, Apple Silicon, stub backend): idle ~1.5 MB, pose D=8 ~1.4 MB.
const IDLE_BYTES_PER_FRAME = 2_300_000;
const POSE_BYTES_PER_FRAME = 2_100_000;

class TestCanvas {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  getContext(_type: string): unknown {
    return null;
  }
}
(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement ??= TestCanvas;
installWebGpuStub(DEFAULT_WEBGPU_STUB_PROFILE);
const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());

interface NativeCounts {
  createBindGroup: number;
  createTextureView: number;
  createBuffer: number;
  createTexture: number;
}

function countingCanvas(counts: NativeCounts, counting: () => boolean) {
  let configuration: { device: GPUDevice; format: GPUTextureFormat } | undefined;
  let texture: GPUTexture | undefined;
  const wrapped = new WeakSet<object>();
  const wrap = (device: GPUDevice): void => {
    if (wrapped.has(device)) return;
    wrapped.add(device);
    for (const method of ['createBindGroup', 'createBuffer', 'createTexture'] as const) {
      const original = device[method].bind(device) as (...args: unknown[]) => unknown;
      (device as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        if (counting()) counts[method] += 1;
        const created = original(...args);
        if (method === 'createTexture') wrapTexture(created as GPUTexture);
        return created;
      };
    }
  };
  const wrapTexture = (created: GPUTexture): void => {
    const original = created.createView.bind(created);
    created.createView = (descriptor?: GPUTextureViewDescriptor) => {
      if (counting()) counts.createTextureView += 1;
      return original(descriptor);
    };
  };
  return {
    width: 64,
    height: 64,
    addEventListener() {},
    removeEventListener() {},
    getContext: () => ({
      configure(options: { device: GPUDevice; format: GPUTextureFormat }) {
        configuration = options;
        wrap(options.device);
        texture?.destroy();
        texture = undefined;
      },
      unconfigure() {},
      getCurrentTexture() {
        if (configuration === undefined) throw new Error('canvas context is not configured');
        texture ??= configuration.device.createTexture({
          size: [64, 64],
          format: configuration.format,
          usage: 0x11,
        });
        return texture;
      },
    }),
  };
}

async function steadyFrames(moved: number) {
  const counts: NativeCounts = {
    createBindGroup: 0,
    createTextureView: 0,
    createBuffer: 0,
    createTexture: 0,
  };
  let counting = false;
  const renderer = await createRenderer(
    countingCanvas(counts, () => counting) as never,
    { rhi },
    { shaderManifestUrl: manifestUrl },
  );
  const initialized = await renderer.initialization;
  if (!initialized.ok) throw initialized.error;
  const assets = new AssetRegistry();
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const mesh = assets.create(createBoxGeometry(0.1, 0.1, 0.1).unwrap()).unwrap();
  const material = assets.create(Materials.standard({ baseColor: [0.7, 0.4, 0.3, 1] })).unwrap();
  const entities: EntityHandle[] = [];
  for (let index = 0; index < ENTITIES; index++)
    entities.push(
      world
        .spawn(
          {
            component: Transform,
            data: { pos: [(index % 8) * 0.2 - 0.7, (index >> 3) * 0.2 - 0.7, 0] },
          },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap(),
    );
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 3] } },
      { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 20 } },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { intensity: 2, direction: [-0.3, -0.5, -1], castShadow: true, mapSize: 256 },
    })
    .unwrap();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const input = {
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  };
  const frame = async (tick: number): Promise<string> => {
    for (let index = 0; index < moved; index++) {
      const entity = entities[(tick * 7 + index) % ENTITIES] as EntityHandle;
      world.set(entity, Transform, { pos: [0, 0, Math.sin(tick + index) * 0.01] }).unwrap();
    }
    expect(world.update(1 / 60).ok).toBe(true);
    const drawn = renderer.draw(input);
    if (!drawn.ok) throw drawn.error;
    if (drawn.value === undefined) throw new Error('expected a submitted receipt');
    expect((await drawn.value.completed).ok).toBe(true);
    return drawn.value.presentation;
  };
  let ready = 0;
  let tick = 0;
  for (; tick < 600 && ready < WARMUP; tick++) {
    ready = (await frame(tick)) === 'pending' ? 0 : ready + 1;
  }
  expect(ready).toBe(WARMUP);
  counting = true;
  const bytes = await allocatedAcross(async () => {
    for (let index = 0; index < FRAMES; index++, tick++)
      expect(await frame(tick)).not.toBe('pending');
  });
  const bytesPerFrame = bytes / FRAMES;
  counting = false;
  await renderer.dispose();
  return { bytesPerFrame, counts };
}

describe('low-count steady frames (WebGPU stub)', () => {
  it('an idle frame creates no native objects and allocates a bounded constant', {
    timeout: 300_000,
  }, async () => {
    const { bytesPerFrame, counts } = await steadyFrames(0);
    expect(counts).toEqual({
      createBindGroup: 0,
      createTextureView: 0,
      createBuffer: 0,
      createTexture: 0,
    });
    expect(bytesPerFrame).toBeLessThan(IDLE_BYTES_PER_FRAME);
  });

  it('a frame moving eight entities stays within a bounded constant', {
    timeout: 300_000,
  }, async () => {
    const { bytesPerFrame, counts } = await steadyFrames(8);
    expect(counts.createTextureView).toBe(0);
    expect(counts.createTexture).toBe(0);
    expect(bytesPerFrame).toBeLessThan(POSE_BYTES_PER_FRAME);
  });
});
