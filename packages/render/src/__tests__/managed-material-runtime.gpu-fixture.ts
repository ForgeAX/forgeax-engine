import { World } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createPrimitiveMesh,
  meshFromInterleaved,
  packInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { assert, expect } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { samplerContribution } from '../assets/asset-decoders';
import { Camera, MeshFilter, MeshRenderer, SpriteRegionOverride } from '../components';
import { Materials, SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '../materials';

const BUILTIN_QUAD = createPrimitiveMesh('quad').unwrap();

export async function verifyRuntimeMaterial(
  kind: 'mesh' | 'sprite' | 'sprite-flip' | 'mesh-structure',
  url: string,
) {
  const structural = kind === 'mesh-structure';
  const sprite = kind === 'sprite' || kind === 'sprite-flip';
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  let format: GPUTextureFormat = 'rgba8unorm';
  const failures: unknown[] = [];
  const context = {
    configure(descriptor: GPUCanvasConfiguration) {
      device = descriptor.device;
      device.addEventListener('uncapturederror', (event) => failures.push(event.error.message));
      format = descriptor.format;
      target?.destroy();
      target = device.createTexture({
        size: [64, 64],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        viewFormats: descriptor.viewFormats ?? [],
      });
    },
    getCurrentTexture() {
      if (target === undefined) throw new Error('Missing configured target');
      return target;
    },
    unconfigure() {},
  };
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: (kind: string) => (kind === 'webgpu' ? context : null) },
    undefined,
    { shaderManifestUrl: url },
    {
      rhi,
      createShaderModule: (device, descriptor) => rhi.createShaderModule(device, descriptor),
    },
  );
  renderer.onError((error) => failures.push(error));
  const initialized = await renderer.initialization;
  assert(initialized.ok, initialized.ok ? undefined : initialized.error.message);
  const assets = renderer.assetRegistry;
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const world = new World({ assets });
  const attached = renderer.attach(world);
  assert(attached.ok, attached.ok ? undefined : attached.error.message);
  const lease = attached.value;
  registerPropagateTransforms(world);
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: 0 } },
    )
    .unwrap();
  const texture = sprite
    ? assets
        .create({
          kind: 'texture',
          shape: {
            viewDimension: '2d',
            extent: { width: kind === 'sprite-flip' ? 4 : 2, height: 2 },
          },
          format: 'rgba8unorm',
          colorSpace: 'linear',
          mips: { kind: 'none' },
          data:
            kind === 'sprite-flip'
              ? new Uint8Array([
                  255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255, 255, 0, 0, 255,
                  0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
                ])
              : new Uint8Array(16).fill(255),
        })
        .unwrap()
    : undefined;
  const sampler =
    kind === 'sprite-flip'
      ? assets
          .create({
            kind: 'sampler',
            minFilter: 'nearest',
            magFilter: 'nearest',
            mipmapFilter: 'nearest',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
          })
          .unwrap()
      : undefined;
  const materialData: MaterialAsset = !sprite
    ? Materials.unlit([1, 0, 0, 1])
    : {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'forgeax::sprite' },
            renderState: {
              tags: { LightMode: 'Forward' },
              queue: 3000,
              blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND,
              depthWriteEnabled: false,
              cullMode: 'none',
            },
          },
        ],
        parameters: [
          { name: 'baseColorTexture', type: 'texture' },
          { name: 'colorTint', type: 'color' },
          { name: 'region', type: 'vec4' },
          { name: 'pivotAndSize', type: 'vec4' },
          { name: 'slicesAndMode', type: 'vec4' },
          { name: 'flipX', type: 'f32', default: 0 },
          { name: 'flipY', type: 'f32', default: 0 },
        ],
        values: {
          ...(texture === undefined
            ? {}
            : { baseColorTexture: sampler === undefined ? texture : { texture, sampler } }),
          colorTint: kind === 'sprite-flip' ? [1, 1, 1, 1] : [1, 0, 0, 1],
          region: [0, 0, 1, 1],
          pivotAndSize: [0.5, 0.5, 1.3, 1.3],
          slicesAndMode: [0, 0, 0, 0],
        },
      };
  const material = assets.create(materialData).unwrap();
  const green = structural ? assets.create(Materials.unlit([0, 1, 0, 1])).unwrap() : undefined;
  const positions = Float32Array.of(
    -1.5,
    -0.7,
    0,
    -0.5,
    -0.7,
    0,
    -0.5,
    0.7,
    0,
    -1.5,
    0.7,
    0,
    0.5,
    -0.7,
    0,
    1.5,
    -0.7,
    0,
    1.5,
    0.7,
    0,
    0.5,
    0.7,
    0,
  );
  const attributes = {
    position: positions,
    normal: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1),
    uv: Float32Array.of(0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0),
  };
  const structure: MeshAsset = {
    ...meshFromInterleaved(
      packInterleavedVertexAttributes(attributes, 8).unwrap().vertices,
      Uint16Array.of(0, 1, 2, 2, 3, 0, 4, 5, 6, 6, 7, 4),
    ).unwrap(),
    submeshes: [
      { indexOffset: 0, indexCount: 6, vertexCount: 4, topology: 'triangle-list', materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'left', defaultMaterial: material }],
    aabb: Float32Array.of(-1.5, -0.7, 0, 1.5, 0.7, 0),
  };
  const mesh = assets
    .create(
      structural ? structure : !sprite ? createBoxGeometry(1.3, 1.3, 1).unwrap() : BUILTIN_QUAD,
    )
    .unwrap();
  for (const x of structural ? [0] : [-1, 1])
    world
      .spawn(
        { component: Transform, data: { pos: [x, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: structural ? [] : [material] } },
        ...(sprite
          ? [{ component: SpriteRegionOverride, data: { region: [x < 0 ? 0 : 0.5, 0, 0.5, 1] } }]
          : []),
      )
      .unwrap();
  const read = async () => {
    for (let frame = 0; frame < (structural ? 15 : 3); frame++) {
      world.update().unwrap();
      const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
      if (!drawn.ok) expect(failures).toEqual([]);
      assert(drawn.ok, drawn.ok ? undefined : drawn.error.message);
      if (device === undefined) throw new Error('Missing configured GPU device');
      await device.queue.onSubmittedWorkDone();
    }
    if (device === undefined || target === undefined)
      throw new Error('Missing configured GPU target');
    const nativeDevice = device,
      renderTarget = target;
    const buffer = nativeDevice.createBuffer({
      size: 64 * 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = nativeDevice.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: renderTarget }, { buffer, bytesPerRow: 256 }, [64, 64]);
    nativeDevice.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(buffer.getMappedRange());
    const samples = (kind === 'sprite-flip' ? [16, 24, 40, 48] : [20, 44]).map((x) => {
      const offset = 32 * 256 + x * 4;
      return [
        pixels[offset + (format.startsWith('bgra') ? 2 : 0)],
        pixels[offset + 1],
        pixels[offset + (format.startsWith('bgra') ? 0 : 2)],
      ];
    });
    buffer.unmap();
    buffer.destroy();
    return samples;
  };
  try {
    const before = await read();
    expect(failures).toEqual([]);
    if (structural) {
      assert(green !== undefined);
      const dominant = (samples: (number | undefined)[][]) =>
        samples.map((sample) => sample.map((value) => ((value ?? 0) > 128 ? 1 : 0)));
      expect(dominant(before)).toEqual([
        [1, 0, 0],
        [0, 0, 0],
      ]);
      const left = structure.submeshes[0];
      assert(left);
      const right = { ...left, indexOffset: 6, materialSlot: 1 };
      assets
        .update(mesh, {
          submeshes: [left, right],
          materialSlots: [
            { slotName: 'left', defaultMaterial: material },
            { slotName: 'right', defaultMaterial: green },
          ],
        })
        .unwrap();
      expect(dominant(await read())).toEqual([
        [1, 0, 0],
        [0, 1, 0],
      ]);
      assets.update(mesh, { submeshes: [right] }).unwrap();
      expect(dominant(await read())).toEqual([
        [0, 0, 0],
        [0, 1, 0],
      ]);
      assets
        .update(mesh, { submeshes: structure.submeshes, materialSlots: structure.materialSlots })
        .unwrap();
      expect(dominant(await read())).toEqual([
        [1, 0, 0],
        [0, 0, 0],
      ]);
      expect(failures).toEqual([]);
      return;
    }
    assets
      .update(material, {
        values: !sprite
          ? { baseColor: [0, 1, 0, 1] }
          : kind === 'sprite-flip'
            ? { flipX: 1, flipY: 1 }
            : {
                colorTint: [0, 1, 0, 1],
                flipX: 1,
                flipY: 1,
                slicesAndMode: [0.1, 0.1, 0.1, 0.1],
              },
      })
      .unwrap();
    const after = await read();
    if (kind === 'sprite-flip') {
      const dominant = (samples: (number | undefined)[][]) =>
        samples.map((sample) => sample.map((value) => ((value ?? 0) > 128 ? 1 : 0)));
      expect(dominant(before)).toEqual([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [1, 1, 0],
      ]);
      expect(dominant(after)).toEqual([
        [0, 1, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 0, 1],
      ]);
    } else {
      for (const sample of before) {
        expect(sample[0]).toBeGreaterThan(150);
        expect(sample[1]).toBeLessThan(30);
      }
      for (const sample of after) {
        expect(sample[1]).toBeGreaterThan(150);
        expect(sample[0]).toBeLessThan(30);
      }
    }
    expect(failures).toEqual([]);
  } finally {
    const disposed = renderer.dispose();
    assert(disposed.ok, disposed.ok ? undefined : disposed.error.message);
    target?.destroy();
  }
}
