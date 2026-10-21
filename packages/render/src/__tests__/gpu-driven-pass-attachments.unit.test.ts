import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { ok, type RenderPipeline, type TextureFormat } from '@forgeax/engine-rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { GpuScene } from '../gpu-scene';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import { STANDARD_OPAQUE_FRAGMENT_ENTRY } from '../record/standard-opaque-entry';
import type { RenderPipelineFrame } from '../render-pipeline';
import { RenderScene } from '../scene/render-scene';
import {
  admitGpuFixture,
  mesh,
  preparedSnapshot,
  standardPbrInputs,
  updateSnapshot,
} from './gpu-driven-production-fixture';

it('observes ordered attachment formats once per pass even when one array is reused', async () => {
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const group = device.createBindGroup({ layout, entries: [] }).unwrap();
  const scene = new RenderScene();
  const batchCount = 8;
  const delta = scene.apply(
    Array.from({ length: batchCount }, (_, i) => updateSnapshot(preparedSnapshot(i + 1, i + 1))),
  );
  const availability = GpuScene.create(device, batchCount).unwrap();
  if (availability.status !== 'available') throw Error('GPU scene unavailable');
  availability.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(scene.slotsSnapshot());
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const prepared = production
    .prepare(
      admitGpuFixture({
        ...standardPbrInputs(device, shader, layout),
        scene: {
          scene: availability.scene,
          plan: topology.query(topology.sourcePlan(), undefined),
          slots: scene.slotsSnapshot(),
          slotAt: scene.slotAt,
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map(Array.from({ length: batchCount }, (_, i) => [i, mesh(device)])),
        viewBindGroupLayout: layout,
      }),
    )
    .unwrap();
  if (prepared?.standardPbrFrameResources === undefined) throw Error('missing GPU projection');

  const pipelines = new Map<RenderPipeline, readonly TextureFormat[]>();
  const createPipeline = device.createRenderPipeline.bind(device);
  const creation = vi.spyOn(device, 'createRenderPipeline').mockImplementation((descriptor) => {
    const result = createPipeline(descriptor);
    if (result.ok)
      pipelines.set(
        result.value,
        descriptor.fragment?.targets.map((target) => {
          if (target === null) throw new Error('fixture expects contiguous color targets');
          return target.format;
        }) ?? [],
      );
    return result;
  });
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const gpu = prepared.project(graph, 'rgba8unorm', 1, undefined, undefined, false, true).unwrap();
  const formats: TextureFormat[] = [];
  const joins = vi.spyOn(formats, 'join');
  const frameResources = {
    ...prepared.standardPbrFrameResources,
    materialSlotIndicesByBinding: new Map(),
    prepareMaterialBinding: (
      (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
      (slot: number) => {
        const group = groups[slot];
        return group === undefined ? undefined : { group, byteOffset: slot * 1280 };
      }
    )([group]),
    colorFormats: formats,
  };
  const attachments: readonly TextureFormat[][] = [
    ['rgba8unorm', 'rgba16float'],
    ['rgba16float', 'rgba8unorm'],
    ['rgba8unorm'],
  ];
  const recorded: Array<readonly TextureFormat[]> = [];
  for (const [index, targets] of attachments.entries()) {
    const views = targets.map((format, target) =>
      graph
        .view(
          graph
            .createTexture(`color-${index}-${target}`, { format, size: { width: 1, height: 1 } })
            .unwrap(),
        )
        .unwrap(),
    );
    graph
      .addRasterPass(`attachments-${index}`, {
        accesses: [
          ...gpu.accesses,
          ...views.map((resource) => ({ resource, usage: 'color-attachment' as const })),
        ],
        colorAttachments: views.map((view) => ({
          view,
          loadOp: 'clear' as const,
          storeOp: 'store' as const,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        })),
        encode: ({ pass, resources }) => {
          formats.splice(0, formats.length, ...targets);
          const setPipeline = pass.setPipeline.bind(pass);
          pass.setPipeline = (pipeline) => {
            recorded.push(pipelines.get(pipeline) ?? []);
            setPipeline(pipeline);
          };
          gpu.encode(
            group,
            pass,
            resources,
            frameResources,
            undefined,
            STANDARD_OPAQUE_FRAGMENT_ENTRY,
          );
        },
      })
      .unwrap();
  }
  const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  try {
    for (let frame = 0; frame < 3; frame++) {
      const encoder = device.createCommandEncoder().unwrap();
      compiled
        .execute({ viewBindGroup: group, encoder } as unknown as RenderPipelineFrame)
        .unwrap();
      encoder.finish().unwrap();
    }
    expect(recorded).toEqual([...attachments, ...attachments, ...attachments]);
    expect(device.totalDrawCount).toBe(3 * attachments.length * batchCount);
    expect(creation).toHaveBeenCalledTimes(attachments.length);
    expect(joins).toHaveBeenCalledTimes(3 * attachments.length);
  } finally {
    joins.mockRestore();
    creation.mockRestore();
    await compiled.retire();
    production.dispose();
    availability.scene.dispose();
  }
});
