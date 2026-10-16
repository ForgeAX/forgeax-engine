import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createMeshBuilder } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack';
import { ANTIALIAS_NONE, Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';

export async function verifyVertexColorPublication(options: {
  url: string;
  guid: string;
  shaderManifestUrl: string;
  warmupFrames?: number;
}) {
  const errors: unknown[] = [];
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  let format: GPUTextureFormat = 'rgba8unorm';
  const canvas = {
    width: 64,
    height: 64,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        device = config.device;
        format = config.format;
        device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        target = device.createTexture({
          size: [64, 64],
          format,
          viewFormats: [format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          usage: 0x10 | 0x01,
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
    addEventListener() {},
    removeEventListener() {},
  };
  const host = await constructRuntimeRendererHost(
    canvas,
    {},
    { shaderManifestUrl: options.shaderManifestUrl },
  );
  if (!host.ok) throw host.error;
  const { renderer, assets } = host.value;
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const world = new World();
  const transforms = registerPropagateTransforms(world);
  try {
    assets.configurePackIndex(options.url);
    const guid = AssetGuid.parse(options.guid);
    if (!guid.ok) throw guid.error;
    const loaded = await assets.loadByGuid(guid.value);
    if (!loaded.ok) throw loaded.error;
    if (loaded.value.kind !== 'material') throw new Error('expected cooked material');
    const readiness = assets.getMaterialReadiness(options.guid);
    expect(readiness?.status, JSON.stringify(readiness)).toBe('Ready');
    expect(assets.getMaterialProjectionForPayload(loaded.value)).toBeDefined();
    const material = world.internSharedRef('MaterialAsset', loaded.value);
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const plain = world.internSharedRef('MeshAsset', mesh);
    const colorMesh = (rgb: readonly number[]) => {
      const color = new Float32Array((mesh.attributes.position.length / 3) * 4);
      for (let index = 0; index < color.length; index += 4) color.set([...rgb, 1], index);
      return world.internSharedRef(
        'MeshAsset',
        createMeshBuilder({ ...mesh, attributes: { ...mesh.attributes, color } })
          .build()
          .unwrap(),
      );
    };
    const red = colorMesh([1, 0, 0]);
    const green = colorMesh([0, 1, 0]);
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: red } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100, antialias: ANTIALIAS_NONE },
        },
      )
      .unwrap();
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
    try {
      for (const lane of ['direct', 'auto'] as const) {
        for (const [handle, expected] of [
          [red, [1, 0, 0]],
          [plain, [1, 1, 1]],
          [green, [0, 1, 0]],
          [red, [1, 0, 0]],
        ] as const) {
          world.set(entity, MeshFilter, { assetHandle: handle }).unwrap();
          for (let frame = 0; frame < (options.warmupFrames ?? 60); frame++) {
            world.update(1 / 60).unwrap();
            const drawn = renderer.draw({
              leases: [lease],
              camera: { lease, entityKey: camera },
              environment: { lease },
              ...(lane === 'direct' ? { geometryLane: 'direct' as const } : {}),
            });
            if (!drawn.ok) throw drawn.error;
            const completed = await drawn.value.completed;
            if (!completed.ok) throw completed.error;
          }
          if (device === undefined || target === undefined) throw new Error('missing GPU target');
          const buffer = device.createBuffer({ size: 256, usage: 0x08 | 0x01 });
          try {
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer(
              { texture: target, origin: [32, 32] },
              { buffer, bytesPerRow: 256 },
              [1, 1],
            );
            device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(0x01);
            const pixel = [...new Uint8Array(buffer.getMappedRange()).slice(0, 4)];
            buffer.unmap();
            if (format === 'bgra8unorm') [pixel[0], pixel[2]] = [pixel[2] ?? 0, pixel[0] ?? 0];
            for (const [channel, value] of expected.entries()) {
              if (value === 1) expect(pixel[channel], `${lane}: ${pixel}`).toBeGreaterThan(150);
              else expect(pixel[channel], `${lane}: ${pixel}`).toBeLessThanOrEqual(12);
            }
          } finally {
            buffer.destroy();
          }
        }
      }
      expect(errors).toEqual([]);
    } finally {
      lease.dispose();
    }
  } finally {
    transforms();
    unsubscribe();
    await renderer.dispose();
    target?.destroy();
  }
}
