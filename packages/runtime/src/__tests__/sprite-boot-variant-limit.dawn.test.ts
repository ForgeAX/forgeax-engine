import { shaderManifestUrl } from './shader-manifest-url.fixture';
// Frame-1 sprite readiness across the device atmosphere axis. A storage-capable
// device below the atmosphere sampled-texture floor resolves sprite requests to
// ATMOSPHERE_AVAILABLE=false; boot must seed those exact module labels, or the
// first frame skips the draw while the lazy module compiles.

import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_NONE,
  Camera,
  MeshFilter,
  MeshRenderer,
  TONEMAP_NONE,
} from '@forgeax/engine-render';
import {
  SPRITE_PREMULTIPLIED_ALPHA_BLEND,
  SpriteInstances,
} from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';

const WIDTH = 128;
const HEIGHT = 128;

const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

const ENGINE_MANIFEST_URL = shaderManifestUrl(
  await (async () => {
    const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
    return buildEngineShaderManifest();
  })(),
);

async function readPixels(device: GPUDevice, target: GPUTexture): Promise<Uint8Array> {
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: target },
    { buffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(MAP_MODE_READ);
  const mapped = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  }
  return pixels;
}

function centreLitPixels(pixels: Uint8Array): number {
  let count = 0;
  for (let y = HEIGHT / 2 - 16; y < HEIGHT / 2 + 16; y++) {
    for (let x = WIDTH / 2 - 16; x < WIDTH / 2 + 16; x++) {
      const i = (y * WIDTH + x) * 4;
      if ((pixels[i] ?? 0) > 100) count++;
    }
  }
  return count;
}

async function firstFrameLitPixels(
  sampledTextureLimit: number | undefined,
  instanced: boolean,
): Promise<number> {
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
    globalThis.navigator.gpu,
  );
  globalThis.navigator.gpu.requestAdapter = async (options) => {
    const adapter = await originalRequestAdapter(options);
    if (adapter === null) return adapter;
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const next = await requestDevice(
        sampledTextureLimit === undefined
          ? descriptor
          : {
              ...descriptor,
              requiredLimits: {
                ...descriptor?.requiredLimits,
                maxSampledTexturesPerShaderStage: sampledTextureLimit,
              },
            },
      );
      device ??= next;
      return next;
    };
    return adapter;
  };
  const canvas = {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
          target ??= desc.device.createTexture({
            size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
            format: desc.format ?? 'rgba8unorm',
            usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
            viewFormats: ['rgba8unorm-srgb'],
          });
        },
        unconfigure() {},
        getCurrentTexture(): GPUTexture {
          if (target === undefined) throw new Error('render target was not configured');
          return target;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;

  let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>>;
  try {
    host = await constructRuntimeRendererHost(
      canvas,
      {},
      { shaderManifestUrl: ENGINE_MANIFEST_URL },
    );
  } finally {
    globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
  }
  if (!host.ok) throw host.error;
  const { renderer } = host.value;
  if (device === undefined) throw new Error('GPUDevice not captured');
  if (sampledTextureLimit !== undefined) {
    expect(device.limits.maxSampledTexturesPerShaderStage).toBe(sampledTextureLimit);
  }

  const world = new World();
  const texture = world.allocSharedRef('TextureAsset', {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format: 'rgba8unorm-srgb',
    data: new Uint8Array([230, 40, 30, 255]),
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  } as never);
  const sampler = world.allocSharedRef('SamplerAsset', {
    kind: 'sampler',
    magFilter: 'nearest',
    minFilter: 'nearest',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  } as never);
  const material = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::sprite' },
        renderState: {
          blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND,
          tags: { LightMode: 'Forward' },
          queue: 3000,
        },
      },
    ],
    values: {
      colorTint: [1, 1, 1, 1],
      baseColorTexture: texture,
      sampler,
      region: [0, 0, 1, 1],
      pivotAndSize: [0.5, 0.5, 1, 1],
    },
  } as never);
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [material as never] } },
    ...(instanced
      ? [
          {
            component: SpriteInstances,
            data: { transforms: identity, regions: new Float32Array([0, 0, 1, 1]) },
          },
        ]
      : []),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    {
      component: Camera,
      data: {
        fov: Math.PI / 4,
        aspect: 1,
        near: 0.1,
        far: 100,
        tonemap: TONEMAP_NONE,
        antialias: ANTIALIAS_NONE,
      } as Record<string, unknown> as never,
    },
  );
  const attachment = renderer.attach(world);
  if (!attachment.ok) throw attachment.error;
  world.update(1 / 60).unwrap();
  const drawn = renderer.draw({
    leases: [attachment.value],
    camera: { lease: attachment.value },
    environment: { lease: attachment.value },
  });
  expect(drawn.ok).toBe(true);
  await device.queue.onSubmittedWorkDone();
  if (target === undefined) throw new Error('render target was not configured');
  const lit = centreLitPixels(await readPixels(device, target));
  renderer.dispose();
  return lit;
}

describe('sprite boot variants follow the device atmosphere axis (dawn)', () => {
  for (const sampledTextureLimit of [undefined, 16] as const) {
    for (const instanced of [false, true]) {
      it(`draws a ${instanced ? 'SpriteInstances' : 'per-entity'} sprite on frame 1 at limit ${sampledTextureLimit ?? 'default'}`, async () => {
        expect(await firstFrameLitPixels(sampledTextureLimit, instanced)).toBeGreaterThan(128);
      });
    }
  }
});
