import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { BindGroup } from '@forgeax/engine-rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createMaterialShaderProgram } from '../../../shader/src/material/program';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { GpuScene } from '../gpu-scene';
import { buildMaterialSlotPlan } from '../record/fold-buckets';
import { makeZeroCameraFallbackSnapshot, worldEntityKey } from '../record/frame-snapshot';
import { RenderBundleCache } from '../record/render-bundle-cache';
import type { RenderPipelineFrame } from '../render-pipeline';
import { RenderScene } from '../scene/render-scene';
import {
  mesh,
  preparedPbrSnapshot,
  snapshot,
  standardPbrInputs,
  updateSnapshot,
} from './gpu-driven-production-fixture';

it.each([
  false,
  true,
])('records reordered material slots with uniformRequired=%s', async (required) => {
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const group = () => device.createBindGroup({ layout, entries: [] }).unwrap();
  const viewGroup = group();
  let materialGroup = group();
  const inputs = standardPbrInputs(device, shader, layout);
  if (inputs.standardPbrArtifact === undefined) throw new Error('expected artifact');
  const artifact = {
    ...inputs.standardPbrArtifact,
    program: createMaterialShaderProgram(`
      @group(1) @binding(0) var<uniform> params: vec4f;
      ${required ? 'fn helper() -> vec4f { return params; }' : ''}
    `),
  };
  expect(artifact.program.materialUniformRequired).toBe(required);
  const projection = new RenderScene();
  const rows = Array.from({ length: 32 }, (_, index) => {
    const source = preparedPbrSnapshot(snapshot(index + 1, index + 10));
    const material = { ...source.material, standardTextureMask: index % 2 === 0 ? 0 : 4 };
    return { ...source, material, materials: [material] };
  });
  const scene = GpuScene.create(device, 64).unwrap();
  if (scene.status !== 'available') throw new Error('expected GPU Scene');
  scene.scene.sync(projection.apply(rows.map(updateSnapshot))).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const sharedMesh = mesh(device);
  const prepared = production
    .prepare({
      ...inputs,
      standardPbrArtifact: artifact,
      scene: {
        scene: scene.scene,
        plan: topology.plan(),
        slots: projection.slotsSnapshot(),
        slotAt: projection.slotAt,
      },
      camera: makeZeroCameraFallbackSnapshot(),
      meshBySlot: new Map(projection.slotsSnapshot().map(({ slot }) => [slot, sharedMesh])),
      viewBindGroupLayout: layout,
      meshResidencyEpoch: 1,
    })
    .unwrap();
  if (!prepared) throw new Error('expected production');
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const gpu = prepared.project(graph, 'rgba8unorm', 1).unwrap();
  const texture = graph
    .createTexture('material-order', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
    .unwrap();
  const view = graph.view(texture).unwrap();
  const cache = new RenderBundleCache({ colorFormats: ['rgba8unorm'] });
  const counters = { hits: 0, misses: 0 };
  let frame = 0;
  graph
    .addRasterPass('material-order', {
      accesses: [...gpu.accesses, { resource: view, usage: 'color-attachment' }],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      encode: ({ pass, resources }) => {
        const offset = frame < 3 ? 0 : frame % rows.length;
        const ordered = [...rows.slice(offset), ...rows.slice(0, offset)];
        const slots = buildMaterialSlotPlan(ordered.map((row) => row.materials));
        const indices = new Map(
          ordered.map((row, index) => [
            worldEntityKey(0, row.entityKey),
            slots.slotIndices[index] ?? [],
          ]),
        );
        const frameResources = {
          ...prepared.standardPbrFrameResources,
          materialStride: 256,
          materialBindGroups: Array.from({ length: slots.slots.length }, () => materialGroup),
          materialSlotIndicesByEntity: indices,
        };
        cache.encode(
          device,
          pass,
          (target) => {
            let material: { group: BindGroup; offset: number } | undefined;
            let draws = 0;
            const observed = new Proxy(target, {
              get(object, key, receiver) {
                if (key === 'setBindGroup')
                  return (index: number, group: BindGroup, offsets?: readonly number[]) => {
                    if (index === 1) material = { group, offset: offsets?.[0] ?? 0 };
                    target.setBindGroup(index, group, offsets);
                  };
                if (key === 'drawIndexedIndirect')
                  return (...args: Parameters<typeof target.drawIndexedIndirect>) => {
                    const row = rows[draws++];
                    if (row === undefined) throw new Error('unexpected draw');
                    expect(material).toEqual({
                      group: materialGroup,
                      offset: required
                        ? (indices.get(worldEntityKey(0, row.entityKey))?.[0] ?? -1) * 256
                        : 0,
                    });
                    target.drawIndexedIndirect(...args);
                  };
                const value = Reflect.get(object, key, receiver);
                return typeof value === 'function' ? value.bind(object) : value;
              },
            });
            gpu.encode(viewGroup, observed, resources, frameResources);
            expect(draws).toBe(rows.length);
          },
          counters,
        );
      },
    })
    .unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  const render = () => {
    const encoder = device.createCommandEncoder().unwrap();
    const execution = compiled.execute({ encoder } as RenderPipelineFrame);
    if (!execution.ok && execution.error.detail && 'cause' in execution.error.detail)
      throw execution.error.detail.cause;
    execution.unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
  };
  try {
    for (frame = 0; frame < 6; frame++) render();
    expect(counters).toEqual(required ? { hits: 32, misses: 160 } : { hits: 128, misses: 64 });
    if (!required) {
      // A changed texture/probe binding is still a physical command dependency.
      materialGroup = group();
      render();
      expect(counters).toEqual({ hits: 128, misses: 96 });
    }
  } finally {
    compiled.retire();
    production.dispose();
    scene.scene.dispose();
  }
});
