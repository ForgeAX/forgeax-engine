import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { BindGroup, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { createMaterialShaderProgram } from '../../../shader/src/material/program';
import { BatchTopology } from '../gpu-driven/batch-topology';
import {
  collectGpuDrivenMaterialArtifacts,
  GpuDrivenMaterialProgramProjection,
} from '../gpu-driven/material-artifacts';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { GpuScene } from '../gpu-scene';
import { GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { MaterialResource } from '../material-resource';
import { buildMaterialSlotPlan } from '../record/fold-buckets';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import { RenderBundleCache } from '../record/render-bundle-cache';
import type { RenderPipelineFrame } from '../render-pipeline';
import { MaterialDispatch } from '../scene/material-dispatch';
import { RenderScene } from '../scene/render-scene';
import {
  mesh,
  preparedPbrSnapshot,
  snapshot,
  standardPbrInputs,
  updateSnapshot,
} from './gpu-driven-production-fixture';

it.each([
  { required: false, dynamicOffsetCount: 0 },
  { required: false, dynamicOffsetCount: 1 },
  { required: true, dynamicOffsetCount: 1 },
] as const)('records reordered material slots with uniformRequired=$required and dynamicOffsets=$dynamicOffsetCount', async ({
  required,
  dynamicOffsetCount,
}) => {
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const viewGroup = device.createBindGroup({ layout, entries: [] }).unwrap();
  const materialBuffer = device
    .createBuffer({ size: 32 * 256, usage: GPU_BUFFER_USAGE_UNIFORM })
    .unwrap();
  const materialLayout = device
    .createBindGroupLayout({
      entries:
        dynamicOffsetCount === 0
          ? []
          : [{ binding: 0, visibility: 3, buffer: { type: 'uniform', hasDynamicOffset: true } }],
    })
    .unwrap();
  const group = () =>
    device
      .createBindGroup({
        layout: materialLayout,
        entries:
          dynamicOffsetCount === 0
            ? []
            : [
                {
                  binding: 0,
                  resource: { kind: 'buffer', value: { buffer: materialBuffer, size: 16 } },
                },
              ],
      })
      .unwrap();
  let materialGroup = group();
  const inputs = standardPbrInputs(device, shader, layout, materialLayout);
  if (inputs.materialArtifact === undefined) throw new Error('expected artifact');
  const artifact = {
    ...inputs.materialArtifact,
    program: createMaterialShaderProgram(`
      @group(1) @binding(0) var<uniform> params: vec4f;
      ${required ? 'fn helper() -> vec4f { return params; }' : ''}
    `),
  };
  expect(artifact.program.materialUniformRequired).toBe(required);
  const projection = new RenderScene();
  const rows = Array.from({ length: 32 }, (_, index) => {
    const source = preparedPbrSnapshot(snapshot(index + 1, index + 10));
    const material = new MaterialResource({
      ...source.material.snapshot,
      standardTextureMask: index % 2 === 0 ? 0 : 4,
    });
    return { ...source, material, materials: [material] };
  });
  const scene = GpuScene.create(device, 64).unwrap();
  if (scene.status !== 'available') throw new Error('expected GPU Scene');
  scene.scene.sync(projection.apply(rows.map(updateSnapshot))).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const sharedMesh = mesh(device);
  const dispatch = new MaterialDispatch();
  for (const slot of projection.slotsSnapshot()) dispatch.bind(slot.slot, slot.snapshot);
  const selected = collectGpuDrivenMaterialArtifacts({
    batches: topology.query(topology.sourcePlan(), undefined).active.batches,
    programs: new GpuDrivenMaterialProgramProjection().project(
      dispatch.query(projection.slotsSnapshot()),
      dispatch.materials(),
    ),
    resolve: () => artifact,
    clustered: false,
    reflectionFallback: false,
    probeBlend: false,
    demand: 'forward',
  });
  const prepared = production
    .prepare({
      ...inputs,
      materialArtifact: artifact,
      ...selected,
      scene: {
        scene: scene.scene,
        plan: topology.query(topology.sourcePlan(), undefined).active,
        slots: projection.slotsSnapshot(),
        slotAt: projection.slotAt,
      },
      camera: makeZeroCameraFallbackSnapshot(),
      meshByBinding: new Map(
        topology.query(topology.sourcePlan(), undefined).active.batches.map((batch) => {
          assert(batch.binding);
          return [batch.binding, sharedMesh] as const;
        }),
      ),
      viewBindGroupLayout: layout,
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
  let frame = -1;
  graph
    .addRasterPass('material-order', {
      accesses: [...gpu.accesses, { resource: view, usage: 'color-attachment' }],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      encode: ({ pass, resources }) => {
        const offset = frame < 3 ? 0 : frame % rows.length;
        const ordered = [...rows.slice(offset), ...rows.slice(0, offset)];
        const slots = buildMaterialSlotPlan(ordered.map((row) => row.materials));
        const indices = new Map(
          slots.slots.map((material, index) => [material, new Map([['', index]])]),
        );
        const group = materialGroup;
        const frameResources = {
          ...prepared.standardPbrFrameResources,
          prepareMaterialBinding: (slot: number) =>
            slots.slots[slot] === undefined
              ? undefined
              : { group, byteOffset: slot * 256, dynamicOffsetCount },
          materialSlotIndicesByBinding: indices,
        };
        const encode = (target: RhiRenderPassEncoder) => {
          let material: { group: BindGroup; offsets: number[] } | undefined;
          let draws = 0;
          const observed = new Proxy(target, {
            get(object, key, receiver) {
              if (key === 'setBindGroup')
                return (...args: Parameters<typeof target.setBindGroup>) => {
                  const [index, group, values, start = 0, length] = args;
                  if (index === 1)
                    material = {
                      group,
                      offsets: Array.from(values ?? []).slice(
                        start,
                        length === undefined ? undefined : start + length,
                      ),
                    };
                  target.setBindGroup(...args);
                };
              if (key === 'drawIndexedIndirect')
                return (...args: Parameters<typeof target.drawIndexedIndirect>) => {
                  const row = rows[draws++];
                  assert(row, 'Expected an original material row');
                  expect(material).toEqual({
                    group,
                    offsets:
                      dynamicOffsetCount === 0
                        ? []
                        : [required ? (indices.get(row.material)?.get('') ?? -1) * 256 : 0],
                  });
                  target.drawIndexedIndirect(...args);
                };
              const value = Reflect.get(object, key, receiver);
              return typeof value === 'function' ? value.bind(object) : value;
            },
          });
          gpu.encode(viewGroup, observed, resources, frameResources);
          expect(draws).toBe(rows.length);
        };
        if (frame < 0) encode(pass);
        else cache.encode(device, pass, encode, counters);
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
    render();
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
    device.destroyBuffer(materialBuffer).unwrap();
  }
});
