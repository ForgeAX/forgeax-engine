import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import { type RhiNullDevice, RhiNullRenderPassEncoder, rhi } from '@forgeax/engine-rhi-null';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrivenProduction, type PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import { MaterialAbiRasterAdapter } from '../gpu-driven/production-raster-material';
import { GpuBuffer } from '../gpu-resource';
import { GpuScene } from '../gpu-scene';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_INDEX } from '../gpu-usage';
import { MaterialResource } from '../material-resource';
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

async function fixture(
  count: number,
  topology: 'triangle-list' | 'triangle-strip',
  mixedMedium = false,
) {
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
  const artifact = Object.freeze({
    ...sourceArtifact,
    get deps() {
      artifactCopies += 1;
      return sourceArtifact.deps;
    },
  });
  const receipt = sourceArtifact.receipt;
  if (receipt === undefined) throw Error('missing receipt');
  const mediumArtifact: MaterialShaderArtifact = {
    ...artifact,
    receipt: {
      ...receipt,
      surface: {
        model: 'single-layer-medium',
        module: 'forgeax::single-layer-medium',
        inputAbi: 'SingleLayerMediumSurfaceInput',
        outputAbi: 'SingleLayerMediumSurfaceData',
        passes: ['nearest-layer', 'color'],
      },
    },
  };
  const mediumId = 'fixture::medium';
  const materialArtifacts = new Map([
    [artifact.material, artifact],
    [mediumId, { ...mediumArtifact, material: mediumId }],
  ]);
  const scene = new RenderScene();
  const delta = scene.apply(
    Array.from({ length: count }, (_, index) => {
      const source = preparedSnapshot(index + 1, index + 1);
      const material =
        mixedMedium && index === 1
          ? new MaterialResource({
              ...source.material.snapshot,
              materialShaderId: mediumId,
              passes: [
                {
                  name: 'forward',
                  program: { module: mediumId },
                  renderState: { tags: { LightMode: 'Forward' } },
                },
              ],
              materialProgramKeys: { forward: mediumId },
            })
          : source.material;
      const draws = source.gpuDrivenDraws;
      if (draws === undefined) throw Error('missing prepared draws');
      return updateSnapshot({
        ...source,
        material,
        materials: [material],
        worldId: index % 2,
        gpuDrivenDraws: draws.map((draw) => {
          if (draw.prepared === undefined) throw Error('missing prepared draw');
          return {
            ...draw,
            topology,
            prepared: {
              ...draw.prepared,
              topology,
              // Different asset GUID identities must not split the pipeline ABI.
              identity: { ...draw.prepared.identity, geometry: `guid-${index}` },
            },
          };
        }),
      });
    }),
  );
  const availability = GpuScene.create(device, count).unwrap();
  if (availability.status !== 'available') throw Error('GPU scene unavailable');
  availability.scene.sync(delta).unwrap();
  const batches = new BatchTopology();
  batches.rebuild(scene.slotsSnapshot());
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const createMesh = (index: number): MeshGpuHandles => {
    const value = mesh(device);
    // Distinct physical buffers and both index formats; triangle lists share a PSO.
    const indexFormat = index % 2 === 0 ? 'uint16' : 'uint32';
    const iboBytes = indexFormat === 'uint16' ? 8 : 12;
    return {
      ...value,
      topology,
      indexFormat,
      iboBytes,
      indexBuffer: new GpuBuffer(
        device,
        device
          .createBuffer({
            size: iboBytes,
            usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
          })
          .unwrap(),
      ),
      submeshes: value.submeshes.map((submesh) => ({ ...submesh, topology })),
    };
  };
  const meshes = new Map(
    scene.slotsSnapshot().map((slot, index) => [slot.slot, createMesh(index)]),
  );
  const materialPipelineFactory: NonNullable<
    Parameters<GpuDrivenProduction['prepare']>[0]['materialPipelineFactory']
  > = (...args) => ({
    group2Contract: 'mesh',
    pipeline: device
      .createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap(),
        vertex: { module: shader, entryPoint: args[18] ?? 'vs_scene_index', buffers: [] },
        fragment: {
          module: shader,
          entryPoint: args[19] ?? 'fs_opaque',
          targets: [{ format: 'rgba8unorm' }],
        },
      })
      .unwrap(),
  });
  let pending: PreparedGpuDrivenFrame | undefined;
  const prepare = () => {
    pending?._abortResourceReplacement?.();
    const prepared = production
      .prepare(
        admitGpuFixture({
          ...inputs,
          materialArtifact: artifact,
          ...(mixedMedium ? { materialArtifacts, materialPipelineFactory } : {}),
          scene: {
            scene: availability.scene,
            plan: batches.query(batches.sourcePlan(), undefined),
            slots: scene.slotsSnapshot(),
            slotAt: scene.slotAt,
            worldIdentities: ['shape-world-a', 'shape-world-b'],
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: meshes,
          viewBindGroupLayout: viewLayout,
        }),
      )
      .unwrap();
    if (prepared === undefined) throw Error('missing GPU projection');
    pending = prepared;
    return prepared;
  };
  return {
    device,
    viewBindGroup,
    production,
    meshes,
    prepare,
    copies: () => artifactCopies,
    replaceFour: () => {
      for (let index = 0; index < 4; index += 1) meshes.set(index, createMesh(index));
    },
    close: () => {
      production.dispose();
      availability.scene.dispose();
    },
  };
}

it('shares one pipeline preparation for 1025 distinct meshes across stable frames and mesh churn', async () => {
  const f = await fixture(1025, 'triangle-list');
  const queries = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'pipeline');
  const vertex = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setVertexBuffer');
  const index = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setIndexBuffer');
  let initialSignature: string | undefined;
  try {
    for (let generation = 0; generation < 2; generation += 1) {
      if (generation > 0) f.replaceFour();
      const prepared = f.prepare();
      if (generation === 0) initialSignature = prepared.topologySignature();
      else expect(prepared.topologySignature()).not.toBe(initialSignature);
      const graph = new RenderGraphBuilder<RenderPipelineFrame>();
      const copiesBefore = f.copies();
      const gpu = prepared
        .project(graph, 'rgba8unorm', 1, undefined, undefined, false, true)
        .unwrap();
      // Count actual adapter entry and lazy artifact preparation, not native PSO cache hits.
      expect(queries).toHaveBeenCalledTimes(generation + 1);
      expect(f.copies() - copiesBefore).toBe(0);
      expect(gpu.accesses.filter((access) => access.usage === 'vertex-read')).toHaveLength(0);
      expect(gpu.accesses.filter((access) => access.usage === 'index-read')).toHaveLength(0);
      const color = graph
        .createTexture('color', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
        .unwrap();
      const view = graph.view(color).unwrap();
      const frameResources = {
        ...prepared.standardPbrFrameResources,
        materialSlotIndicesByBinding: new Map(),
        prepareMaterialBinding: (
          (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
          (slot: number) => {
            const group = groups[slot];
            return group === undefined ? undefined : { group, byteOffset: slot * 1280 };
          }
        )([f.viewBindGroup]),
      };
      graph
        .addRasterPass('raster', {
          accesses: [...gpu.accesses, { resource: view, usage: 'color-attachment' }],
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
          encode: ({ pass, resources }) =>
            gpu.encode(
              f.viewBindGroup,
              pass,
              resources,
              frameResources,
              undefined,
              STANDARD_OPAQUE_FRAGMENT_ENTRY,
            ),
        })
        .unwrap();
      const compiled = graph
        .compile({ device: f.device, surfaceSize: { width: 1, height: 1 } })
        .unwrap();
      try {
        if (generation === 0) {
          // Current mesh imports still resolve before any graph pass executes.
          const wrapper = f.meshes.get(1)?.vertexBuffer;
          if (wrapper === undefined) throw Error('missing second physical mesh');
          const descriptor = Object.getOwnPropertyDescriptor(wrapper, 'handle');
          if (descriptor === undefined) throw Error('missing buffer handle descriptor');
          const cause = new Error('second physical mesh is temporarily unavailable');
          Object.defineProperty(wrapper, 'handle', {
            configurable: true,
            get: () => {
              throw cause;
            },
          });
          try {
            const encoder = f.device.createCommandEncoder().unwrap();
            const failed = compiled.execute({ encoder } as RenderPipelineFrame);
            encoder.finish().unwrap();
            expect(failed.ok).toBe(false);
            if (!failed.ok) {
              expect(failed.error.code).toBe('resource-resolution-failed');
              expect(failed.error.detail).toMatchObject({ accesses: [String(cause)] });
            }
            expect(f.device.totalDrawCount).toBe(0);
          } finally {
            Object.defineProperty(wrapper, 'handle', descriptor);
          }
        }
        for (let frame = 0; frame < 60; frame += 1) {
          vertex.mockClear();
          index.mockClear();
          const encoder = f.device.createCommandEncoder().unwrap();
          compiled.execute({ encoder } as RenderPipelineFrame).unwrap();
          encoder.finish().unwrap();
          expect(vertex.mock.calls.map((call) => call[1])).toEqual(
            [...f.meshes.values()].map((mesh) => mesh.vertexBuffer.handle),
          );
          expect(index.mock.calls.map((call) => [call[0], call[1]])).toEqual(
            [...f.meshes.values()].map((mesh) => [mesh.indexBuffer?.handle, mesh.indexFormat]),
          );
        }
        expect(queries).toHaveBeenCalledTimes(generation + 1);
        expect(f.copies() - copiesBefore).toBe(0);
      } finally {
        await compiled.retire();
      }
    }
    expect(f.device.totalDrawCount).toBe(120 * 1025);
  } finally {
    queries.mockRestore();
    vertex.mockRestore();
    index.mockRestore();
    f.close();
  }
});

it.each([
  'strip-index-format',
  'vertex-layout',
] as const)('keeps different %s pipeline inputs separate', async (difference) => {
  const f = await fixture(
    2,
    difference === 'strip-index-format' ? 'triangle-strip' : 'triangle-list',
  );
  if (difference === 'vertex-layout') {
    const original = f.meshes.get(1);
    if (original === undefined) throw Error('missing second mesh');
    f.meshes.set(1, {
      ...original,
      layoutProjection: deriveVertexLayoutProjection({
        position: new Float32Array(9),
        normal: new Float32Array(9),
      }),
    });
  }
  const queries = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'pipeline');
  try {
    const prepared = f.prepare();
    const copiesBefore = f.copies();
    prepared
      .project(
        new RenderGraphBuilder<RenderPipelineFrame>(),
        'rgba8unorm',
        1,
        undefined,
        undefined,
        false,
        true,
      )
      .unwrap();
    expect(queries).toHaveBeenCalledTimes(2);
    expect(f.copies() - copiesBefore).toBe(0);
    const first = queries.mock.calls[0];
    const second = queries.mock.calls[1];
    if (difference === 'strip-index-format') {
      expect(first?.[5]).toBe('uint16');
      expect(second?.[5]).toBe('uint32');
    } else expect(first?.[2]).not.toEqual(second?.[2]);
  } finally {
    queries.mockRestore();
    f.close();
  }
});

it('keeps medium entry routing distinct for the selected material program', async () => {
  const f = await fixture(2, 'triangle-list', true);
  const prepared = f.prepare();
  const queries = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'pipeline');
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const gpu = prepared.project(graph, 'rgba8unorm', 1, undefined, undefined, false, true).unwrap();
  const color = graph
    .createTexture('medium-color', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
    .unwrap();
  const view = graph.view(color).unwrap();
  const frameResources = {
    ...prepared.standardPbrFrameResources,
    materialSlotIndicesByBinding: new Map(),
    prepareMaterialBinding: (
      (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
      (slot: number) => {
        const group = groups[slot];
        return group === undefined ? undefined : { group, byteOffset: slot * 1280 };
      }
    )([f.viewBindGroup]),
  };
  for (const fragment of ['fs_nearest_layer', 'fs_color']) {
    graph
      .addRasterPass(fragment, {
        accesses: [...gpu.accesses, { resource: view, usage: 'color-attachment' }],
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
        encode: ({ pass, resources }) =>
          gpu.encode(
            f.viewBindGroup,
            pass,
            resources,
            frameResources,
            'single-layer-medium',
            fragment,
          ),
      })
      .unwrap();
  }
  const compiled = graph
    .compile({ device: f.device, surfaceSize: { width: 1, height: 1 } })
    .unwrap();
  try {
    const encoder = f.device.createCommandEncoder().unwrap();
    compiled.execute({ encoder } as RenderPipelineFrame).unwrap();
    encoder.finish().unwrap();
    const fragments = queries.mock.calls.map((call) => call[7]?.fragmentEntry);
    expect(fragments).toContain('fs_nearest_layer');
    expect(fragments).toContain('fs_color');
    expect(f.device.totalDrawCount).toBe(2);
  } finally {
    queries.mockRestore();
    await compiled.retire();
    f.close();
  }
});

it('preserves a native pipeline failure and retries the same shared preparation', async () => {
  const f = await fixture(2, 'triangle-strip');
  const prepared = f.prepare();
  const cause = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'injected pipeline failure',
    hint: 'retry the same prepared frame',
  });
  const create = vi.spyOn(f.device, 'createRenderPipeline').mockReturnValueOnce(err(cause));
  try {
    expect(() =>
      prepared.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap(),
    ).toThrow(cause);
    prepared.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
    expect(create).toHaveBeenCalledTimes(3);
  } finally {
    create.mockRestore();
    f.close();
  }
});

it('does not reopen admitted material artifacts when a lazy mesh layout fails', async () => {
  const f = await fixture(2, 'triangle-list');
  const layoutError = new Error('mesh layout rejected');
  try {
    const prepared = f.prepare();
    const mesh = f.meshes.get(0);
    if (mesh === undefined) throw Error('missing first mesh');
    const descriptor = Object.getOwnPropertyDescriptor(mesh, 'layoutProjection');
    if (descriptor === undefined) throw Error('missing layout descriptor');
    const before = f.copies();
    Object.defineProperty(mesh, 'layoutProjection', {
      configurable: true,
      get: () => {
        throw layoutError;
      },
    });
    try {
      expect(() =>
        prepared.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap(),
      ).toThrow(layoutError);
      expect(f.copies()).toBe(before);
    } finally {
      Object.defineProperty(mesh, 'layoutProjection', descriptor);
    }
    prepared.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
    expect(f.copies()).toBe(before);
  } finally {
    f.close();
  }
});
