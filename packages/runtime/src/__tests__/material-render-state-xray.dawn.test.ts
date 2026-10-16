import { shaderManifestUrl } from './shader-manifest-url.fixture';
// Real Dawn regression for MaterialPass depthCompare 'always' in a late queue.
//
// The opaque wall is claimed by the GPU-driven indirect raster while the
// unlit overlay stays on the CPU draw list. Queue order requires the indirect
// opaque batch to land before the queue-3000 overlay; otherwise the wall is
// rasterized over the x-ray draw and the overlay stays hidden.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { drawPublished } from './draw-published';

const WIDTH = 64;
const HEIGHT = 64;
const BYTES_PER_ROW = 256;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

const ENGINE_MANIFEST_URL = shaderManifestUrl(
  await (await import('@forgeax/engine-vite-plugin-shader')).buildEngineShaderManifest(),
);

function spawnScene(world: World, xray: boolean): void {
  const wall = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.2, 0.2, 0.2, 1], roughness: 1 }),
  );
  const overlay = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit(
      [1, 0, 0, 1],
      xray
        ? {
            castShadow: false,
            queue: 3000,
            renderState: { depthCompare: 'always', depthWriteEnabled: false },
          }
        : { castShadow: false },
    ),
  );
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [4, 4, 0.2] },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [wall] } },
  );
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, -2], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [overlay] } },
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 6], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    {
      component: Camera,
      data: {
        fov: (45 * Math.PI) / 180,
        aspect: 1,
        near: 0.1,
        far: 100,
        clearColor: [0, 0, 0, 1],
      },
    },
  );
  world.spawn({
    component: DirectionalLight,
    data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 3, castShadow: false },
  });
}

async function renderCenter(xray: boolean): Promise<{ rgb: number[]; errors: unknown[] }> {
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
    globalThis.navigator.gpu,
  );
  globalThis.navigator.gpu.requestAdapter = async (options) => {
    const adapter = await originalRequestAdapter(options);
    if (adapter === null) return adapter;
    const originalRequestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const created = await originalRequestDevice(descriptor);
      device ??= created;
      return created;
    };
    return adapter;
  };
  const canvas = {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(descriptor: { device: GPUDevice; format?: GPUTextureFormat }) {
          target ??= descriptor.device.createTexture({
            size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
            format: descriptor.format ?? 'rgba8unorm',
            usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
            viewFormats: ['rgba8unorm-srgb'],
          });
        },
        unconfigure() {},
        getCurrentTexture(): GPUTexture {
          if (target === undefined) throw new Error('render target requested before configure');
          return target;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;

  let renderer: Renderer | undefined;
  const errors: unknown[] = [];
  try {
    const host = await constructRuntimeRendererHost(
      canvas,
      {},
      { shaderManifestUrl: ENGINE_MANIFEST_URL },
    );
    if (!host.ok) throw host.error;
    renderer = host.value.renderer;
    renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    const world = new World();
    spawnScene(world, xray);
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    for (let frame = 0; frame < 3; frame += 1) {
      const receipt = drawPublished(renderer, world);
      if (!receipt.ok) throw receipt.error;
      const completed = await receipt.value.completed;
      if (!completed.ok) throw completed.error;
    }
    if (device === undefined || target === undefined) throw new Error('Dawn target missing');
    const buffer = device.createBuffer({
      size: BYTES_PER_ROW * HEIGHT,
      usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer, bytesPerRow: BYTES_PER_ROW, rowsPerImage: HEIGHT },
      { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(MAP_MODE_READ);
    const pixels = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();
    attached.value.dispose();
    const at = (HEIGHT / 2) * BYTES_PER_ROW + (WIDTH / 2) * 4;
    const rgb = [pixels[at] ?? 0, pixels[at + 1] ?? 0, pixels[at + 2] ?? 0];
    // Canvas storage may be BGRA; normalize so index 0 is red.
    return {
      rgb: target.format === 'bgra8unorm' ? [rgb[2] ?? 0, rgb[1] ?? 0, rgb[0] ?? 0] : rgb,
      errors,
    };
  } finally {
    globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
    renderer?.dispose();
    target?.destroy();
    device?.destroy();
  }
}

describe('MaterialPass render state x-ray (Dawn)', () => {
  it('draws a queue-3000 depthCompare always overlay over the GPU-driven opaque wall', async () => {
    const { rgb, errors } = await renderCenter(true);
    expect(errors).toEqual([]);
    const [red, green, blue] = rgb;
    expect(red).toBeGreaterThan(200);
    expect(green).toBeLessThan(60);
    expect(blue).toBeLessThan(60);
  }, 120000);

  it('keeps the default depth test hiding the same overlay (falsifier)', async () => {
    const { rgb, errors } = await renderCenter(false);
    expect(errors).toEqual([]);
    const [red, green, blue] = rgb;
    expect(red).toBeGreaterThan(10);
    expect(Math.abs((red ?? 0) - (green ?? 0))).toBeLessThan(20);
    expect(Math.abs((green ?? 0) - (blue ?? 0))).toBeLessThan(20);
  }, 120000);
});
