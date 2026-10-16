import { rhi } from '@forgeax/engine-rhi-webgpu';
import { describe, expect, it } from 'vitest';
import { GpuScene } from '../gpu-scene';
import { GPU_SCENE_LAYOUTS, gpuSceneFieldOffset } from '../gpu-scene-schema';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

const material = {
  baseColor: new Float32Array([0.25, 0.5, 0.75]),
  metallic: 0.2,
  roughness: 0.8,
  baseColorTexture: 23,
  materialHandle: 17,
} as MaterialSnapshot;
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
      },
    ],
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
  };
}

function updateSnapshot(value: RenderableSnapshot) {
  return {
    kind: 'update' as const,
    worldId: value.worldId,
    entityKey: value.entityKey,
    snapshot: value,
  };
}

describe('GpuScene Dawn residency', () => {
  it('uploads all five schema-derived tables to real GPU buffers', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const availability = GpuScene.create(device, 2).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    const projection = new RenderScene();
    const first = snapshot(7, 3);
    const firstDraw = first.gpuDrivenDraws?.[0];
    const secondMaterial = {
      ...material,
      baseColor: new Float32Array([0.9, 0.1, 0.2]),
      materialHandle: 18,
    } as MaterialSnapshot;
    if (firstDraw === undefined) throw new Error('GPU draw fixture unavailable');
    availability.scene
      .sync(
        projection.apply([
          updateSnapshot({
            ...first,
            materials: [material, secondMaterial],
            gpuDrivenDraws: [firstDraw, { ...firstDraw, first: 39, materialSlot: 1 }],
          }),
          updateSnapshot(snapshot(8, 9)),
        ]),
      )
      .unwrap();

    const sources = {
      primitive: availability.scene.primitiveBuffer,
      instance: availability.scene.instanceBuffer,
      transform: availability.scene.transformBuffer,
      drawTemplate: availability.scene.drawTemplateBuffer,
      material: availability.scene.materialBuffer,
    } as const;
    const readbacks = Object.fromEntries(
      Object.entries(sources).map(([name]) => {
        const layout = GPU_SCENE_LAYOUTS[name as keyof typeof GPU_SCENE_LAYOUTS];
        return [
          name,
          device
            .createBuffer({
              label: `gpu-scene-${name}-readback`,
              size:
                layout.stride *
                (name === 'transform' ? 4 : name === 'drawTemplate' || name === 'material' ? 3 : 2),
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
      encoder.copyBufferToBuffer(
        source,
        0,
        readbacks[name],
        0,
        GPU_SCENE_LAYOUTS[name].stride *
          (name === 'transform' ? 4 : name === 'drawTemplate' || name === 'material' ? 3 : 2),
      );
    }
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();

    const views = {} as Record<keyof typeof sources, DataView>;
    for (const [name, readback] of Object.entries(readbacks) as Array<
      [keyof typeof sources, import('@forgeax/engine-rhi').Buffer]
    >) {
      const mapped = (await readback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      views[name] = new DataView(mapped.getMappedRange().unwrap().slice(0));
      mapped.unmap();
    }

    expect(
      views.primitive.getUint32(
        gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'assetHandle'),
        true,
      ),
    ).toBe(48);
    expect(
      views.primitive.getUint32(
        GPU_SCENE_LAYOUTS.primitive.stride +
          gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'materialIndex'),
        true,
      ),
    ).toBe((2 * GPU_SCENE_LAYOUTS.material.stride) / 16);
    expect(
      views.instance.getUint32(
        gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.instance, 'primitiveIndex'),
        true,
      ),
    ).toBe(0);
    expect(
      views.instance.getUint32(
        gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.instance, 'transformIndex'),
        true,
      ),
    ).toBe(0);
    expect(
      views.transform.getFloat32(
        gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.transform, 'currentWorld'),
        true,
      ),
    ).toBe(1);
    expect(
      views.transform.getFloat32(
        gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.transform, 'previousWorld'),
        true,
      ),
    ).toBe(1);
    const firstTransformIndex = views.primitive.getUint32(
      gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'transformIndex'),
      true,
    );
    expect(firstTransformIndex).toBe(1);
    expect(
      views.transform.getFloat32(
        firstTransformIndex * GPU_SCENE_LAYOUTS.transform.stride +
          gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.transform, 'currentWorld') +
          12 * 4,
        true,
      ),
    ).toBe(3);
    const secondTransformIndex = views.primitive.getUint32(
      GPU_SCENE_LAYOUTS.primitive.stride +
        gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'transformIndex'),
      true,
    );
    expect(secondTransformIndex).toBe(2);
    expect(
      views.transform.getFloat32(
        secondTransformIndex * GPU_SCENE_LAYOUTS.transform.stride +
          gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.transform, 'previousWorld') +
          12 * 4,
        true,
      ),
    ).toBe(9);
    expect(
      views.drawTemplate.getUint32(
        gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.drawTemplate, 'indexCount'),
        true,
      ),
    ).toBe(36);
    expect(
      views.drawTemplate.getInt32(
        gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.drawTemplate, 'baseVertex'),
        true,
      ),
    ).toBe(-2);
    expect(
      views.drawTemplate.getUint32(
        GPU_SCENE_LAYOUTS.drawTemplate.stride +
          gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.drawTemplate, 'materialIndex'),
        true,
      ),
    ).toBe(GPU_SCENE_LAYOUTS.material.stride / 16);
    expect(
      views.material.getFloat32(
        GPU_SCENE_LAYOUTS.material.stride +
          gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.material, 'baseColor'),
        true,
      ),
    ).toBeCloseTo(0.9);
    expect(
      views.material.getFloat32(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.material, 'baseColor'), true),
    ).toBeCloseTo(0.25);
    expect(
      views.material.getFloat32(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.material, 'metallic'), true),
    ).toBeCloseTo(0.2);
    expect(
      views.material.getFloat32(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.material, 'roughness'), true),
    ).toBeCloseTo(0.8);

    availability.scene.dispose();
    for (const readback of Object.values(readbacks)) device.destroyBuffer(readback);
  });
});
