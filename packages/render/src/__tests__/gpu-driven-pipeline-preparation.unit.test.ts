import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { ok } from '@forgeax/engine-rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { GpuScene } from '../gpu-scene';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { RenderSystemInternals } from '../record/render-context';
import type { RenderPipelineFrame } from '../render-pipeline';
import { RenderScene } from '../scene/render-scene';
import { DEFERRED_COLOR_FORMATS } from '../standard-attachments';
import {
  mesh,
  preparedSnapshot,
  standardPbrInputs,
  updateSnapshot,
} from './gpu-driven-production-fixture';

it('waits for the exact declared scene-index fragment and targets without encoding or a synchronous fallback', async () => {
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const inputs = standardPbrInputs(device, shader, viewLayout);
  const scene = new RenderScene();
  const delta = scene.apply([
    updateSnapshot(preparedSnapshot(1, 1)),
    updateSnapshot(preparedSnapshot(2, 2)),
  ]);
  const available = GpuScene.create(device, 2).unwrap();
  if (available.status !== 'available') throw Error('GPU Scene unavailable');
  available.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(scene.slotsSnapshot());
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  let released = false;
  const pipeline = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap(),
      vertex: { module: shader, entryPoint: 'vs_scene_index', buffers: [] },
      fragment: {
        module: shader,
        entryPoint: 'fs_gbuffer',
        targets: DEFERRED_COLOR_FORMATS.map((format) => ({ format })),
      },
    })
    .unwrap();
  type Factory = NonNullable<RenderSystemInternals['getMaterialShaderPipelineEntry']>;
  const ordinary = vi.fn<Factory>(() => {
    throw Error('sync fallback must not qualify preparation');
  });
  const prepare = vi.fn<Factory>(() => (released ? { pipeline, group2Contract: 'mesh' } : null));
  try {
    const prepared = production
      .prepare({
        ...inputs,
        materialPipelineFactory: ordinary,
        materialPipelinePreparationFactory: prepare,
        scene: {
          scene: available.scene,
          plan: topology.plan(),
          slots: scene.slotsSnapshot(),
          slotAt: scene.slotAt,
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map([
          [0, mesh(device)],
          [1, mesh(device)],
        ]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
      })
      .unwrap();
    if (prepared === undefined) throw Error('missing prepared owner');
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const projected = prepared
      .project(graph, 'rgba16float', 1, undefined, undefined, false, true)
      .unwrap();
    expect(ordinary).not.toHaveBeenCalled();
    projected.registerPipelinePreparation?.(DEFERRED_COLOR_FORMATS, undefined, 'fs_gbuffer');
    expect(projected.preparePipelines?.()).toBe(false);
    expect(ordinary).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[15]).toBe('gpu-driven-pbr');
    expect(prepare.mock.calls[0]?.[16]).toBe('vs_scene_index');
    expect(prepare.mock.calls[0]?.[17]).toEqual(DEFERRED_COLOR_FORMATS.slice(1));
    expect(prepare.mock.calls[0]?.[19]).toBe('fs_gbuffer');
    released = true;
    expect(projected.preparePipelines?.()).toBe(true);
    expect(projected.preparePipelines?.()).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1]).toEqual(prepare.mock.calls[0]);
    expect(ordinary).not.toHaveBeenCalled();
  } finally {
    production.dispose();
    available.scene.dispose();
  }
});
