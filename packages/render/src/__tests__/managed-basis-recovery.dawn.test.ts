import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { assert, expect, it } from 'vitest';
import { completeReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { basisImages } from '../../../app/__tests__/render-worker-basis-data';
import { loadRhiPack } from '../assembly/backend-contract';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import { perspective } from '../components/camera';
import { Materials } from '../materials';

it('rehydrates an encoded texture before publishing a replacement renderer generation', async () => {
  const manifest = URL.createObjectURL(
    new Blob([JSON.stringify(await buildEngineShaderManifest())], { type: 'application/json' }),
  );
  let device: GPUDevice | undefined,
    target: GPUTexture | undefined,
    format: GPUTextureFormat = 'rgba8unorm';
  let lose: (() => void) | undefined;
  const failures: unknown[] = [];
  const context = {
    configure(input: GPUCanvasConfiguration) {
      device = input.device;
      format = input.format;
      device.addEventListener('uncapturederror', (event) => failures.push(event.error));
      target?.destroy();
      target = device.createTexture({
        size: [64, 64],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        viewFormats: input.viewFormats ?? [],
      });
    },
    getCurrentTexture() {
      assert(target);
      return target;
    },
    unconfigure() {},
  };
  const implementation = await createRenderer(
    { width: 64, height: 64, getContext: () => context },
    {},
    { shaderManifestUrl: manifest },
    loadRhiPack(webgpu, {
      deviceLost: () =>
        new Promise((resolve) => {
          lose = () => resolve({ reason: 'unknown', message: 'encoded texture recovery' });
        }),
    }),
  );
  assert((await implementation.initialization).ok);
  implementation.onError((error) => failures.push(error));
  const renderer = exposeRenderer(implementation),
    assets = implementation.assetRegistry;
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const attached = renderer.attach(world);
  assert(attached.ok);
  const lease = attached.value;
  const image = (index: number) => ({
    kind: 'texture' as const,
    encoding: 'ktx2' as const,
    shape: { viewDimension: '2d' as const, extent: { width: 16, height: 16 } },
    format: 'rgba8unorm-srgb' as const,
    colorSpace: 'srgb' as const,
    mips: { kind: 'packed' as const, levelCount: 5 },
    data:
      basisImages[index] ??
      (() => {
        throw new Error('Missing encoded fixture');
      })(),
  });
  const texture = assets.create(image(0)).unwrap();
  const material = assets
    .create(Materials.unlit([1, 1, 1, 1], { baseColorTexture: { texture } }))
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: MeshFilter,
        data: { assetHandle: assets.create(createPrimitiveMesh('cube').unwrap()).unwrap() },
      },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: 1, aspect: 1, near: 0.1, far: 10 }),
          tonemap: 0,
          antialias: 0,
          bloom: 0,
        },
      },
    )
    .unwrap();
  let frames = 0;
  const draw = async (green: boolean) => {
    for (let i = 0; i < 20; i++) {
      world.update(1 / 60).unwrap();
      await completeReadyFrame(async () => {
        const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
        assert(drawn.ok);
        const receipt = drawn.value;
        assert((await receipt.completed).ok);
        return receipt;
      });
      frames++;
    }
    assert(device && target);
    const buffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: target, origin: [32, 32] },
      { buffer, bytesPerRow: 256 },
      [1, 1],
    );
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const pixel = new Uint8Array(buffer.getMappedRange());
    expect(pixel[green ? 1 : format.startsWith('bgra') ? 2 : 0]).toBeGreaterThan(240);
    expect(pixel[green ? (format.startsWith('bgra') ? 2 : 0) : 1]).toBeLessThan(15);
    buffer.unmap();
    buffer.destroy();
  };
  try {
    await draw(false);
    assets.replace(texture, image(1)).unwrap();
    await draw(true);
    expect(failures).toEqual([]);
    assert(lose);
    lose();
    await expect.poll(() => renderer.state()).toBe('device-lost');
    const recovered = await renderer.recover();
    assert(recovered.ok, JSON.stringify(recovered));
    await draw(true);
    expect(frames).toBe(60);
    expect(failures).toMatchObject([{ code: 'device-lost' }]);
  } finally {
    assert((await renderer.dispose()).ok);
    target?.destroy();
    URL.revokeObjectURL(manifest);
  }
}, 120_000);
