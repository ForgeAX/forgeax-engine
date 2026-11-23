import { vec3 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { describe, expect, it } from 'vitest';
import { GpuScene } from '../gpu-scene';
import { GPU_MATERIAL_DESCRIPTOR } from '../gpu-scene-inputs';
import { GPU_SCENE_LAYOUTS, gpuSceneFieldOffset } from '../gpu-scene-schema';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { MaterialResource } from '../material-resource';
import type { RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

const material = new MaterialResource({
  baseColor: vec3.create(0.25, 0.5, 0.75),
  metallic: 0.2,
  roughness: 0.8,
  baseColorTexture: 23 as import('@forgeax/engine-types').AssetHandle<'texture'>,
  materialHandle: 17,
  passes: [],
});
const GPU_MAP_MODE_READ = 0x0001;

function snapshot(entityKey: number, translationX: number): RenderableSnapshot {
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  world[12] = translationX;
  return {
    assetHandle: 41 + entityKey,
    transform: { world },
    localAabb: new Float32Array([-1, -2, -3, 1, 2, 3]),
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 3,
        count: 36,
        baseVertex: -2,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'forgeax::default-unlit',
        materialResourceClass: 'base-color-texture',
        geometry: {
          receipt: {
            identity: 'native-schema',
            vertexInputs: [],
            topology: 'triangle-list',
            indexed: true,
          },
          draw: { kind: 'indexed', first: 3, count: 36, baseVertex: -2, topology: 'triangle-list' },
          deformation: 'rigid',
        },
      },
    ],
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    entityKey,
  };
}

function updateSnapshot(value: RenderableSnapshot) {
  return {
    kind: 'update' as const,
    entityKey: value.entityKey,
    snapshot: value,
  };
}

describe('GpuScene Dawn residency', () => {
  it('reads the moving pose and its previous pose from the smaller physical table', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const available = GpuScene.create(device, 8).unwrap();
    if (available.status !== 'available') throw Error('Expected a Dawn GPU Scene');
    const scene = available.scene;
    const projection = new RenderScene();
    const count = 4096;
    const large = {
      ...snapshot(9, 0),
      instances: {
        instanceCount: count,
        transforms: new Float32Array(count * 16),
        archVersion: 1,
        cacheKey: 9,
      },
    };
    let readback: import('@forgeax/engine-rhi').Buffer | undefined;
    try {
      scene
        .sync(projection.apply([updateSnapshot(snapshot(7, 0)), updateSnapshot(large)]))
        .unwrap();
      scene.commitFrame().unwrap();
      const peak = scene.transformByteLength;
      for (let i = 1; i <= 40; i++) {
        const move = {
          kind: 'update' as const,
          entityKey: 7,
          world: snapshot(7, i).transform.world,
        };
        scene
          .sync(projection.apply(i === 2 ? [{ kind: 'remove', entityKey: 9 }, move] : [move]))
          .unwrap();
        scene.commitFrame().unwrap();
      }
      scene
        .sync(
          projection.apply([
            { kind: 'update', entityKey: 7, world: snapshot(7, 41).transform.world },
          ]),
        )
        .unwrap();
      const length = scene.transformByteLength;
      expect(length).toBeLessThan(peak / 4);
      const primitive = GPU_SCENE_LAYOUTS.primitive;
      const transform = GPU_SCENE_LAYOUTS.transform;
      readback = device
        .createBuffer({
          size: primitive.stride + length,
          usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
        })
        .unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      const index = scene.primitiveIndexForSlot(0);
      if (index === undefined) throw Error('Expected the surviving primitive');
      encoder.copyBufferToBuffer(
        scene.primitiveBuffer,
        index * primitive.stride,
        readback,
        0,
        primitive.stride,
      );
      encoder.copyBufferToBuffer(scene.transformBuffer, 0, readback, primitive.stride, length);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await readback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      try {
        const data = new DataView(mapped.getMappedRange().unwrap());
        const root = data.getUint32(gpuSceneFieldOffset(primitive, 'transformIndex'), true);
        const at = (row: number, field: string) =>
          primitive.stride + transform.stride * row + gpuSceneFieldOffset(transform, field);
        const prior = data.getUint32(at(root, 'previousIndex'), true);
        expect(data.getUint32(at(root, 'stamp'), true)).toBe(data.getUint32(at(0, 'stamp'), true));
        expect(data.getFloat32(at(root, 'currentWorld') + 48, true)).toBe(41);
        expect(data.getFloat32(at(prior, 'currentWorld') + 48, true)).toBe(40);
      } finally {
        mapped.unmap();
      }
    } finally {
      scene.dispose();
      projection.dispose();
      if (readback !== undefined) device.destroyBuffer(readback);
    }
  });

  it('uploads all five schema-derived tables to real GPU buffers', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const availability = GpuScene.create(device, 2).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    const projection = new RenderScene();
    const first = snapshot(7, 3);
    const firstDraw = first.gpuDrivenDraws?.[0];
    const secondMaterial = new MaterialResource({
      ...material.snapshot,
      baseColor: vec3.create(0.9, 0.1, 0.2),
      materialHandle: 18,
    });
    if (firstDraw === undefined) throw new Error('GPU draw fixture unavailable');
    availability.scene
      .sync(
        projection.apply([
          updateSnapshot({
            ...first,
            materials: [material, secondMaterial],
            gpuDrivenDraws: [
              firstDraw,
              {
                ...firstDraw,
                first: 39,
                materialSlot: 1,
                geometry: {
                  ...firstDraw.geometry,
                  draw: { ...firstDraw.geometry.draw, first: 39 },
                },
              },
            ],
          }),
          updateSnapshot(snapshot(8, 9)),
        ]),
      )
      .unwrap();

    const inputReads = availability.scene.inputs.capture();
    const input = inputReads.buffer().unwrap();
    inputReads.seal().unwrap();
    const sources = {
      input: input.buffer,
      primitive: availability.scene.primitiveBuffer,
      instance: availability.scene.instanceBuffer,
      transform: availability.scene.transformBuffer,
      material: availability.scene.materialBuffer,
    } as const;
    const byteLength = (name: keyof typeof sources) =>
      name === 'input' ? input.byteLength : availability.scene.inspect().tables[name].bytes;
    const readbacks = Object.fromEntries(
      Object.entries(sources).map(([name]) => {
        return [
          name,
          device
            .createBuffer({
              label: `gpu-scene-${name}-readback`,
              size: byteLength(name as keyof typeof sources),
              usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
            })
            .unwrap(),
        ];
      }),
    ) as Record<keyof typeof sources, import('@forgeax/engine-rhi').Buffer>;
    const encoder = device.createCommandEncoder({ label: 'gpu-scene-readback' }).unwrap();
    for (const [name, source] of Object.entries(sources) as Array<
      [keyof typeof sources, import('@forgeax/engine-rhi').Buffer]
    >) {
      encoder.copyBufferToBuffer(source, 0, readbacks[name], 0, byteLength(name));
    }
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    inputReads.release();

    const views = {} as Record<keyof typeof sources, DataView>;
    for (const [name, readback] of Object.entries(readbacks) as Array<
      [keyof typeof sources, import('@forgeax/engine-rhi').Buffer]
    >) {
      const mapped = (await readback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      views[name] = new DataView(mapped.getMappedRange().unwrap().slice(0));
      mapped.unmap();
    }

    const firstPrimitive = availability.scene.primitiveIndexForSlot(0);
    const secondPrimitive = availability.scene.primitiveIndexForSlot(1);
    if (firstPrimitive === undefined || secondPrimitive === undefined)
      throw new Error('Expected both retained primitive rows');
    const primitive = (row: number, field: string) =>
      views.primitive.getUint32(
        row * GPU_SCENE_LAYOUTS.primitive.stride +
          gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, field),
        true,
      );
    expect(primitive(firstPrimitive, 'sourceIndex')).toBe(0);
    expect(primitive(secondPrimitive, 'sourceIndex')).toBe(1);
    const firstMaterial = primitive(firstPrimitive, 'materialIndex');
    expect(primitive(secondPrimitive, 'materialIndex')).toBe(firstMaterial);
    expect(firstMaterial).toBe(availability.scene.materialIndexForSlot(0, 0));
    const otherMaterial = availability.scene.materialIndexForSlot(0, 1);
    if (otherMaterial === undefined) throw new Error('Expected second material descriptor');
    expect(otherMaterial).not.toBe(firstMaterial);
    const firstInstance = primitive(firstPrimitive, 'instanceStart');
    expect(
      views.instance.getUint32(
        firstInstance * GPU_SCENE_LAYOUTS.instance.stride +
          gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.instance, 'primitiveIndex'),
        true,
      ),
    ).toBe(firstPrimitive);
    expect(
      views.instance.getUint32(
        firstInstance * GPU_SCENE_LAYOUTS.instance.stride +
          gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.instance, 'transformIndex'),
        true,
      ),
    ).toBe(0);
    const transform = (row: number, field: string, element = 0) =>
      views.transform.getFloat32(
        row * GPU_SCENE_LAYOUTS.transform.stride +
          gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.transform, field) +
          element * 4,
        true,
      );
    // A row stamped with row 0's frame stamp reads its previous pose from `previousIndex`.
    const transformWord = (row: number, field: string) =>
      views.transform.getUint32(
        row * GPU_SCENE_LAYOUTS.transform.stride +
          gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.transform, field),
        true,
      );
    const previousRow = (row: number) =>
      transformWord(row, 'stamp') === transformWord(0, 'stamp')
        ? transformWord(row, 'previousIndex')
        : row;
    expect(transform(0, 'currentWorld')).toBe(1);
    expect(transform(previousRow(0), 'currentWorld')).toBe(1);
    const firstTransform = primitive(firstPrimitive, 'transformIndex');
    const secondTransform = primitive(secondPrimitive, 'transformIndex');
    expect(firstTransform).toBe(1);
    expect(secondTransform).toBe(2);
    expect(transform(firstTransform, 'currentWorld', 12)).toBe(3);
    expect(transform(previousRow(secondTransform), 'currentWorld', 12)).toBe(9);
    const materialPayload = (descriptor: number) =>
      views.input.getUint32((descriptor + GPU_MATERIAL_DESCRIPTOR.payload) * 4, true) * 16;
    const materialOffset = materialPayload(firstMaterial);
    const otherMaterialOffset = materialPayload(otherMaterial);
    expect(otherMaterialOffset - materialOffset).toBe(GPU_SCENE_LAYOUTS.material.stride);
    const materialValue = (base: number, field: string) =>
      views.material.getFloat32(
        base + gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.material, field),
        true,
      );
    expect(materialValue(otherMaterialOffset, 'baseColor')).toBeCloseTo(0.9);
    expect(materialValue(materialOffset, 'baseColor')).toBeCloseTo(0.25);
    expect(materialValue(materialOffset, 'metallic')).toBeCloseTo(0.2);
    expect(materialValue(materialOffset, 'roughness')).toBeCloseTo(0.8);

    availability.scene.dispose();
    for (const readback of Object.values(readbacks)) device.destroyBuffer(readback);
  });
});
