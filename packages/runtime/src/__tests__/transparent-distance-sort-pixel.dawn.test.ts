import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { shaderManifestUrl } from './shader-manifest-url.fixture';
// Distance-mode transparent sorting must decide the blended draw order on the
// real record path. Unlit publishes a ShadowCaster pass in the opaque queue;
// those entries must not pin the view rows to spawn order ahead of the sorted
// transparent entries. The far panel is spawned last, so a spawn-order draw
// puts it on top from the front camera.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { TransparentSort } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import { RenderQueue } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';

const WIDTH = 64;
const HEIGHT = 64;

const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = shaderManifestUrl(ENGINE_MANIFEST);

const BLEND = {
  depthWriteEnabled: false,
  blend: {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  },
} as const;

async function centerPixel(
  device: GPUDevice,
  renderTarget: GPUTexture,
): Promise<{ r: number; b: number }> {
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const buf = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
  });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: buf, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
  await device.queue.onSubmittedWorkDone();
  await buf.mapAsync(MAP_MODE_READ);
  const bytes = new Uint8Array(buf.getMappedRange().slice(0));
  buf.unmap();
  buf.destroy();
  const at = (HEIGHT / 2) * bytesPerRow + (WIDTH / 2) * 4;
  const bgra = renderTarget.format.startsWith('bgra');
  return {
    r: bytes[at + (bgra ? 2 : 0)] ?? 0,
    b: bytes[at + (bgra ? 0 : 2)] ?? 0,
  };
}

describe('transparent distance sort (dawn)', () => {
  it('draws the nearer blended panel last from either side, not in spawn order', async () => {
    if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function')
      throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');

    let sharedDevice: GPUDevice | undefined;
    const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
      globalThis.navigator.gpu,
    );
    globalThis.navigator.gpu.requestAdapter = async (opts) => {
      const rawAdapter = await originalRequestAdapter(opts);
      if (rawAdapter === null) return rawAdapter;
      const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
      rawAdapter.requestDevice = async (desc) => {
        const dev = await originalRequestDevice(desc);
        if (sharedDevice === undefined) sharedDevice = dev;
        return dev;
      };
      return rawAdapter;
    };

    let renderTarget: GPUTexture | undefined;
    const ensureRenderTarget = (device: GPUDevice, format: GPUTextureFormat): GPUTexture => {
      if (renderTarget !== undefined) return renderTarget;
      renderTarget = device.createTexture({
        size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
        format,
        usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
        viewFormats: ['rgba8unorm-srgb'],
      });
      return renderTarget;
    };
    const mockCanvas = {
      width: WIDTH,
      height: HEIGHT,
      getContext(kind: string): unknown {
        if (kind !== 'webgpu') return null;
        return {
          configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
            ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
          },
          unconfigure() {},
          getCurrentTexture(): GPUTexture {
            if (renderTarget === undefined) {
              if (sharedDevice === undefined)
                throw new Error('render target requested before device captured');
              return ensureRenderTarget(sharedDevice, 'rgba8unorm');
            }
            return renderTarget;
          },
        };
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement;

    let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>>;
    try {
      host = await constructRuntimeRendererHost(
        mockCanvas,
        {},
        { shaderManifestUrl: ENGINE_MANIFEST_URL },
      );
    } finally {
      globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
    }
    if (!host.ok) throw host.error;
    const { renderer } = host.value;
    const device = sharedDevice;
    if (device === undefined) throw new Error('GPUDevice not captured');

    const world = new World();
    const attachment = renderer.attach(world);
    if (!attachment.ok) throw attachment.error;
    TransparentSort.configure(world, { mode: TransparentSort.distance, yzAlpha: 1 });

    const panel = (rgba: readonly [number, number, number, number], z: number) =>
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, z], scale: [2, 2, 0.05] } },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          {
            component: MeshRenderer,
            data: {
              materials: [
                world.allocSharedRef(
                  'MaterialAsset',
                  Materials.unlit(rgba, { queue: RenderQueue.Transparent, renderState: BLEND }),
                ),
              ],
            },
          },
        )
        .unwrap();
    panel([1, 0, 0, 0.85], 1);
    panel([0, 0, 1, 0.85], -1);
    world
      .spawn({
        component: DirectionalLight,
        data: {
          castShadow: true,
          mapSize: testQuality.shadowMapSize,
          cascadeCount: testQuality.cascadeCount,
          direction: [-0.4, -0.6, -0.7],
          color: [1, 1, 1],
          intensity: 1,
        },
      })
      .unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 6] } },
        {
          component: Camera,
          data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } as Record<
            string,
            unknown
          > as never,
        },
      )
      .unwrap();

    const frame = async () => {
      world.update(1 / 60).unwrap();
      const drawn = renderer.draw({
        leases: [attachment.value],
        camera: { lease: attachment.value },
        environment: { lease: attachment.value },
      });
      expect(drawn.ok).toBe(true);
      await device.queue.onSubmittedWorkDone();
      if (renderTarget === undefined) throw new Error('renderTarget not configured');
      return centerPixel(device, renderTarget);
    };

    await frame();
    const front = await frame();
    expect(front.r, `front view: red is nearer (${JSON.stringify(front)})`).toBeGreaterThan(
      front.b,
    );

    world.set(camera, Transform, { pos: [0, 0, -6], quat: [0, 1, 0, 0] }).unwrap();
    await frame();
    const back = await frame();
    expect(back.b, `back view: blue is nearer (${JSON.stringify(back)})`).toBeGreaterThan(back.r);
  });
});
