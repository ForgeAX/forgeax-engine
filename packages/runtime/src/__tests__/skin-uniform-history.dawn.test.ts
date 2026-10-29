// Real Dawn regression for storage-less Skin history. Without a GPU Scene or
// other frame owners the recording has no frame hooks; accepted submissions must
// still advance the Skin history and fence uniform task buffers.
import { World } from '@forgeax/engine-ecs';
import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { drawPublished } from './draw-published';
import { testAssets } from './helpers/runtime-assets';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const ENGINE_MANIFEST_URL = shaderManifestUrl(
  await (await import('@forgeax/engine-vite-plugin-shader')).buildEngineShaderManifest(),
);

function storageLessRhi(states: number[][]): typeof rhi {
  const restrict = (device: RhiDevice): RhiDevice => {
    Object.defineProperty(device, 'caps', { value: { ...device.caps, storageBuffer: false } });
    const labels = new WeakMap<Buffer, string>();
    const createBuffer = device.createBuffer.bind(device);
    device.createBuffer = (descriptor) => {
      const created = createBuffer(descriptor);
      if (created.ok) labels.set(created.value, descriptor.label ?? '');
      return created;
    };
    const queue = device.queue;
    const writeBuffer = queue.writeBuffer.bind(queue);
    queue.writeBuffer = (buffer, offset, data, dataOffset, size) => {
      // The uniform task state follows 255 matrices: count, then history flags.
      if (labels.get(buffer) === 'skin-task-data' && size === 16)
        states
          .at(-1)
          ?.push(
            new Uint32Array(
              data instanceof ArrayBuffer ? data : data.buffer,
              dataOffset ?? 0,
              4,
            )[1] ?? 0,
          );
      return writeBuffer(buffer, offset, data, dataOffset, size);
    };
    return device;
  };
  return {
    ...rhi,
    requestAdapter: async (options) => {
      const adapter = await rhi.requestAdapter(options);
      if (!adapter.ok) return adapter;
      return ok({
        ...adapter.value,
        requestDevice: async (descriptor) => {
          const device = await adapter.value.requestDevice(descriptor);
          return device.ok ? ok(restrict(device.value)) : device;
        },
      });
    },
  } as typeof rhi;
}

function spawnSkin(world: World): void {
  const attributes = {
    position: new Float32Array([-0.75, 0, 0, 0.75, 0, 0, 0, 1.2, 0]),
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uv: new Float32Array([0, 0, 1, 0, 0.5, 1]),
    tangent: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
    skinIndex: new Uint16Array(12),
    skinWeight: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  };
  const packed = packInterleavedVertexAttributes(attributes, 3).unwrap();
  const assets = testAssets(world);
  const mesh = assets
    .create({
      kind: 'mesh',
      vertices: packed.vertices,
      indices: new Uint16Array([0, 1, 2]),
      attributes,
      aabb: new Float32Array([-0.75, 0, 0, 0.75, 1.2, 0]),
      materialSlots: [{ slotName: 'Default' }],
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          materialSlot: 0,
          topology: 'triangle-list',
        },
      ],
    })
    .unwrap();
  const material = assets
    .create({
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::pbr-skin' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: { baseColor: [0.2, 0.5, 0.9, 1], metallic: 0, roughness: 0.6 },
    })
    .unwrap();
  const skeleton = assets
    .create({
      kind: 'skeleton',
      inverseBindMatrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      jointCount: 1,
    })
    .unwrap();
  const joint = world.spawn({ component: Transform, data: { pos: [0, 0, 0] } }).unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
      {
        component: Skin,
        data: { skeleton, joints: new Uint32Array([joint as unknown as number]) },
      },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0.6, 4] } },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
    )
    .unwrap();
}

it('advances uniform Skin history after accepted submissions without other frame owners', async () => {
  const states: number[][] = [];
  const target: { texture?: GPUTexture } = {};
  const canvas = {
    width: 64,
    height: 64,
    getContext: (kind: string) =>
      kind !== 'webgpu'
        ? null
        : {
            configure(descriptor: { device: GPUDevice; format?: GPUTextureFormat }) {
              target.texture ??= descriptor.device.createTexture({
                size: { width: 64, height: 64, depthOrArrayLayers: 1 },
                format: descriptor.format ?? 'rgba8unorm',
                usage: 0x10 | 0x01,
                viewFormats: ['rgba8unorm-srgb'],
              });
            },
            unconfigure() {},
            getCurrentTexture: () => target.texture,
          },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  const host = await constructRuntimeRendererHost(
    canvas,
    { rhi: storageLessRhi(states) },
    { shaderManifestUrl: ENGINE_MANIFEST_URL },
  );
  if (!host.ok) throw host.error;
  const renderer = host.value.renderer;
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  try {
    const world = new World();
    spawnSkin(world);
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    for (let frame = 0; frame < 3; frame++) {
      states.push([]);
      const receipt = await drawPublished(renderer, world);
      if (!receipt.ok) throw receipt.error;
      const completed = await receipt.value.completed;
      if (!completed.ok) throw completed.error;
    }
    expect(errors).toEqual([]);
    // The first actual draw seeds history (1); later accepted frames read it (3).
    expect(states.filter((frame) => frame.length > 0)).toEqual([[1], [3], [3]]);
    attached.value.dispose();
  } finally {
    unsubscribe();
    await renderer.dispose();
    target.texture?.destroy();
  }
});
