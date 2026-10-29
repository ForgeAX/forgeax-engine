import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import {
  createMaterialShaderProgram,
  type MaterialShaderArtifact,
  STANDARD_SURFACE_DISCARDS_OVERRIDE,
} from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { GpuDrivenBatch } from '../gpu-driven/batch-topology';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { lodCoverageMayFade } from '../gpu-driven/production-raster-lod';
import {
  effectiveStandardSurfaceDiscards,
  requestMaterialAbiRasterPipeline,
  standardSurfaceDiscardMask,
} from '../gpu-driven/production-raster-material';
import { GpuScene } from '../gpu-scene';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import type { RenderPipelineFrame } from '../render-pipeline';
import { RenderScene } from '../scene/render-scene';
import {
  admitGpuFixture,
  mesh,
  preparedPbrSnapshot,
  snapshot,
  standardPbrInputs,
  updateSnapshot,
} from './gpu-driven-production-fixture';

const DECLARING = createMaterialShaderProgram(
  '@id(64000) override standardTextureMask: u32 = 0u;\n' +
    '@id(64001) override standardSurfaceDiscards: u32 = 3u;',
);

const rigid = (lod?: GpuDrivenBatch['lod'], material = 'forgeax::default-standard-pbr') =>
  ({
    prepared: { identity: { material, geometry: 'fixture', deformation: 'rigid' } },
    ...(lod === undefined ? {} : { lod }),
  }) as unknown as Pick<GpuDrivenBatch, 'prepared' | 'lod'>;

describe('GPU-driven Standard surface discard specialization', () => {
  it('maps reachable discards to bits 0..3', () => {
    expect(standardSurfaceDiscardMask(false, false)).toBe(0);
    expect(standardSurfaceDiscardMask(true, false)).toBe(1);
    expect(standardSurfaceDiscardMask(false, true)).toBe(2);
    expect(standardSurfaceDiscardMask(true, true)).toBe(3);
  });

  it('keeps LOD coverage only where the cull can write a nonzero fade', () => {
    expect(lodCoverageMayFade(rigid())).toBe(false);
    expect(lodCoverageMayFade(rigid({ coverages: [1] }))).toBe(false);
    expect(lodCoverageMayFade(rigid({ coverages: [1, 0.5] }))).toBe(true);
    // An explicit crossfade flag stays conservative for any material.
    expect(
      lodCoverageMayFade(rigid({ coverages: [1, 0.5], crossfade: true }, 'game::custom')),
    ).toBe(true);
    expect(lodCoverageMayFade(rigid({ coverages: [1, 0.5] }, 'game::custom'))).toBe(false);
  });

  it('passes the constant only to modules that declare it', async () => {
    const device = (
      await (await rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const base = standardPbrInputs(device, shader, viewLayout).materialArtifact;
    if (base === undefined) throw new Error('missing fixture artifact');
    const declaring: MaterialShaderArtifact = { ...base, program: DECLARING };
    expect(effectiveStandardSurfaceDiscards(base, 0)).toBeUndefined();
    expect(effectiveStandardSurfaceDiscards(declaring, 0)).toBe(0);
    expect(effectiveStandardSurfaceDiscards(declaring, undefined)).toBeUndefined();
    type Factory = NonNullable<RenderSystemInternals['getMaterialShaderPipelineEntry']>;
    const factory = vi.fn<Factory>(() => null);
    const input = {
      deformation: 'rigid' as const,
      format: 'rgba16float' as const,
      sampleCount: 1 as const,
      layoutProjection: mesh(device).layoutProjection,
      shaderUvSetCount: 1,
      topology: 'triangle-list' as const,
      stripIndexFormat: undefined,
      renderState: undefined,
      additionalColorFormats: [],
      standardTextureMask: 5,
      standardSurfaceDiscards: 2,
      forwardColorPass: true,
    };
    requestMaterialAbiRasterPipeline(factory, { ...input, artifact: declaring });
    requestMaterialAbiRasterPipeline(factory, { ...input, artifact: base });
    expect(factory.mock.calls.map((call) => call.at(-1))).toEqual([
      { '64000': 5, [STANDARD_SURFACE_DISCARDS_OVERRIDE]: 2 },
      { '64000': 5 },
    ]);
  });

  it('selects one pipeline per LOD fade class and recompiles on view clipping toggles', async () => {
    const device = (
      await (await rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const fixture = standardPbrInputs(device, shader, viewLayout);
    const base = fixture.materialArtifact;
    const state = fixture.materialPipelineState;
    if (base === undefined || state === undefined) throw new Error('missing fixture');
    // The legacy module is compiled from its producer artifact; declare the override there.
    const artifact: MaterialShaderArtifact = { ...base, program: DECLARING };
    const pbrInputs = {
      materialArtifact: artifact,
      materialPipelineState: {
        ...state,
        gpuDrivenPbrPrograms: new Map(
          [...(state.gpuDrivenPbrPrograms ?? [])].map(([key, program]) => [
            key,
            { ...program, artifact },
          ]),
        ),
      } as PipelineState,
    };
    const projection = new RenderScene();
    const availability = GpuScene.create(device, 2).unwrap();
    if (availability.status !== 'available') throw new Error('GPU scene unavailable');
    const topology = new BatchTopology();
    const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
    const sharedMesh = mesh(device, true, true);
    const meshes = new Map([
      [0, sharedMesh],
      [1, sharedMesh],
    ]);
    const pipelines = vi.spyOn(device, 'createRenderPipeline');
    const camera = makeZeroCameraFallbackSnapshot();
    const clipped = { ...camera, clipping: { planes: [[0, 1, 0, 0] as const] } };
    const prepare = (view: typeof camera) =>
      production
        .prepare(
          admitGpuFixture({
            ...pbrInputs,
            scene: {
              scene: availability.scene,
              plan: topology.query(topology.sourcePlan(), undefined),
              slots: projection.slotsSnapshot(),
              slotAt: projection.slotAt,
            },
            camera: view,
            meshBySlot: meshes,
            viewBindGroupLayout: viewLayout,
          }),
        )
        .unwrap();
    const discards = () =>
      new Set(
        pipelines.mock.calls.map(
          ([descriptor]) => descriptor.fragment?.constants?.[STANDARD_SURFACE_DISCARDS_OVERRIDE],
        ),
      );
    try {
      const lodRow = {
        ...preparedPbrSnapshot(snapshot(1, 3)),
        lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }],
      };
      availability.scene
        .sync(
          projection.apply([
            updateSnapshot(lodRow),
            updateSnapshot(preparedPbrSnapshot(snapshot(2, 3))),
          ]),
        )
        .unwrap();
      topology.rebuild(projection.slotsSnapshot());
      const plain = prepare(camera);
      plain?.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
      // Each prepared frame is submitted before the next one is prepared.
      plain?._commitResourceReplacement();
      expect(discards()).toEqual(new Set([0, 1]));
      for (const [descriptor] of pipelines.mock.calls)
        expect(descriptor.vertex.constants).not.toHaveProperty(STANDARD_SURFACE_DISCARDS_OVERRIDE);
      const repeated = prepare(camera);
      expect(repeated?.topologySignature()).toBe(plain?.topologySignature());
      repeated?._commitResourceReplacement();

      pipelines.mockClear();
      const clip = prepare(clipped);
      expect(clip?.topologySignature()).not.toBe(plain?.topologySignature());
      expect(clip?._recordingTopologySignature?.()).not.toBe(
        plain?._recordingTopologySignature?.(),
      );
      clip?.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
      clip?._commitResourceReplacement();
      expect(discards()).toEqual(new Set([2, 3]));

      pipelines.mockClear();
      const restored = prepare(camera);
      expect(restored?.topologySignature()).toBe(plain?.topologySignature());
      restored?.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
      restored?._commitResourceReplacement();
      // Unclipped pipelines are cached by their discard bits and reused.
      expect(pipelines).not.toHaveBeenCalled();
    } finally {
      production.dispose();
      availability.scene.dispose();
    }
  });
});
