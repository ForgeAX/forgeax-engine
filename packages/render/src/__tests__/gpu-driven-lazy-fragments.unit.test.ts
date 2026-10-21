import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { MaterialAbiRasterAdapter } from '../gpu-driven/production-raster-material';
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

it('shares renderer-owned raster fragments across physical meshes and retries a failed first use', async () => {
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const viewBindGroup = device.createBindGroup({ layout: viewLayout, entries: [] }).unwrap();
  const inputs = standardPbrInputs(device, shader, viewLayout);
  const sourceArtifact = inputs.materialArtifact;
  if (sourceArtifact === undefined) throw Error('missing material artifact');
  let artifactCopies = 0;
  // deps is not a pipeline input. Its stable getter witnesses actual artifact
  // copies without replacing production projection or pipeline selection.
  const artifact = Object.freeze({
    ...sourceArtifact,
    get deps() {
      artifactCopies += 1;
      return sourceArtifact.deps;
    },
  });
  const classCount = 32;
  const scene = new RenderScene();
  const delta = scene.apply(
    Array.from({ length: classCount }, (_, index) =>
      updateSnapshot(preparedSnapshot(index + 1, index + 1)),
    ),
  );
  const availability = GpuScene.create(device, classCount).unwrap();
  if (availability.status !== 'available') throw Error('GPU scene unavailable');
  availability.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(scene.slotsSnapshot());
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const prepared = production
    .prepare(
      admitGpuFixture({
        ...inputs,
        materialArtifact: artifact,
        scene: {
          scene: availability.scene,
          plan: topology.query(topology.sourcePlan(), undefined),
          slots: scene.slotsSnapshot(),
          slotAt: scene.slotAt,
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map(
          Array.from({ length: classCount }, (_, index) => [index, mesh(device)]),
        ),
        viewBindGroupLayout: viewLayout,
      }),
    )
    .unwrap();
  if (prepared?.standardPbrFrameResources === undefined) throw Error('missing GPU projection');
  const pipelineQueries = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'pipeline');
  const createPipeline = device.createRenderPipeline.bind(device);
  let refuseGbuffer = true;
  const pipelines = vi.spyOn(device, 'createRenderPipeline').mockImplementation((descriptor) => {
    if (descriptor.fragment?.entryPoint === 'fs_gbuffer' && refuseGbuffer) {
      refuseGbuffer = false;
      return err(
        new RhiError({
          code: 'shader-compile-failed',
          expected: 'a successful first G-buffer pipeline',
          hint: 'injected first-use failure; the next frame must retry',
        }),
      );
    }
    return createPipeline(descriptor);
  });
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  // Admission owns the immutable artifact; projection and recording must not copy it.
  artifactCopies = 0;
  const gpu = prepared.project(graph, 'rgba8unorm', 1, undefined, undefined, false, true).unwrap();
  try {
    expect(pipelineQueries).toHaveBeenCalledTimes(1);
    expect(artifactCopies).toBe(0);
    expect(pipelineQueries.mock.calls.every((call) => call[7]?.fragmentEntry === 'fs_opaque')).toBe(
      true,
    );
    const color = graph
      .createTexture('fragment-color', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
      .unwrap();
    const colorView = graph.view(color).unwrap();
    const frameResources = {
      ...prepared.standardPbrFrameResources,
      materialSlotIndicesByBinding: new Map(),
      prepareMaterialBinding: (
        (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
        (slot: number) => {
          const group = groups[slot];
          return group === undefined ? undefined : { group, byteOffset: slot * 1280 };
        }
      )([viewBindGroup]),
    };
    let fragment = STANDARD_OPAQUE_FRAGMENT_ENTRY;
    graph
      .addRasterPass('fragment', {
        accesses: [...gpu.accesses, { resource: colorView, usage: 'color-attachment' }],
        colorAttachments: [
          {
            view: colorView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
        encode: ({ pass, resources }) =>
          gpu.encode(viewBindGroup, pass, resources, frameResources, undefined, fragment),
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const encode = () => {
      const encoder = device.createCommandEncoder().unwrap();
      const result = compiled.execute({
        encoder,
        viewBindGroup,
        gpuDrivenStandardPbrFrameResources: frameResources,
      } as unknown as RenderPipelineFrame);
      encoder.finish().unwrap();
      return result;
    };
    try {
      for (let frame = 0; frame < 60; frame += 1) encode().unwrap();
      expect(device.totalDrawCount).toBe(60 * classCount);
      expect(artifactCopies).toBe(0);
      expect(pipelineQueries).toHaveBeenCalledTimes(1);
      fragment = 'fs_gbuffer';
      const failed = encode();
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error.code).toBe('pass-encode-failed');
      expect(artifactCopies).toBe(0);
      const failedArtifact = pipelineQueries.mock.calls.at(-1)?.[7];
      encode().unwrap();
      expect(artifactCopies).toBe(0);
      expect(pipelineQueries.mock.calls[2]?.[7]).toBe(failedArtifact);
      expect(pipelineQueries).toHaveBeenCalledTimes(3);
      const admittedGbuffer = pipelines.mock.calls.filter(
        ([descriptor]) => descriptor.fragment?.entryPoint === 'fs_gbuffer',
      );
      expect(admittedGbuffer).toHaveLength(2);
      for (let frame = 0; frame < 60; frame += 1) encode().unwrap();
      fragment = STANDARD_OPAQUE_FRAGMENT_ENTRY;
      encode().unwrap();
      expect(artifactCopies).toBe(0);
      expect(pipelineQueries).toHaveBeenCalledTimes(3);
      expect(device.totalDrawCount).toBe(122 * classCount);
    } finally {
      await compiled.retire();
    }
  } finally {
    pipelineQueries.mockRestore();
    pipelines.mockRestore();
    production.dispose();
    availability.scene.dispose();
  }
});
