import {
  deriveVertexBufferLayoutFromProjection,
  deriveVertexLayoutProjection,
} from '@forgeax/engine-geometry';
import type { BindGroup, RenderPipeline, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { GpuDrivenShadowBatchProjection } from '../gpu-driven/production-raster';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type { RenderSystemInternals } from '../record/render-context';
import { encodeStaticShadowPass } from '../record/shadow-pass';
import { replayShadowBundles } from './shadow-bundle.fixture';
import { preparedShadowFixture } from './shadow-indirect.fixture';

type PipelineLookup = NonNullable<RenderSystemInternals['getMaterialShaderPipeline']>;

async function fixture(reuseAdjacentShadow = true) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const buffer = device.createBuffer({ size: 4096, usage: 0xa8 }).unwrap();
  const replacement = device.createBuffer({ size: 4096, usage: 0xa8 }).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const group = device.createBindGroup({ layout, entries: [] }).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const create = vi.spyOn(device, 'createRenderPipeline');
  const pipelines = new Map<string, RenderPipeline>();
  const lookup = vi.fn<PipelineLookup>((...args) => {
    const key = JSON.stringify(args);
    const cached = pipelines.get(key);
    if (cached !== undefined) return cached;
    const projection = args[13];
    if (projection === undefined) throw new Error('missing shadow vertex projection');
    const pipeline = device
      .createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: shader,
          entryPoint: args[18] ?? args[16] ?? 'vs_main',
          buffers: deriveVertexBufferLayoutFromProjection(projection).map((layout) => ({
            arrayStride: layout.arrayStride,
            attributes: layout.attributes.map((attribute) => ({
              ...attribute,
              format: attribute.format as GPUVertexFormat,
            })),
          })),
          ...(args[21] === undefined ? {} : { constants: args[21] }),
        },
        primitive: {
          topology: args[3] ?? 'triangle-list',
          cullMode: args[2]?.cullMode ?? 'back',
          frontFace: args[2]?.frontFace ?? 'ccw',
        },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      })
      .unwrap();
    pipelines.set(key, pipeline);
    return pipeline;
  });
  const shared = {
    indirectOffset: 0,
    pipeline: {} as RenderPipeline,
    vertexBuffer: buffer,
    materialGroup: group,
    meshBindGroup: group,
    visibleBindGroups: [group],
    deformation: 'rigid' as const,
  };
  const f = preparedShadowFixture({
    device,
    buffer,
    layout,
    shared,
    view: group,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  });
  Object.assign(f.context.runtime, { getMaterialShaderPipeline: lookup });
  const projections = f.projections as unknown as Map<number, GpuDrivenShadowBatchProjection>;
  const state = { cullMode: 'back' as const };
  for (const [id, projection] of projections)
    projections.set(id, { ...projection, shadowRenderState: state });
  let pipeline: RenderPipeline | undefined;
  let material: BindGroup | undefined;
  let mesh: BindGroup | undefined;
  const draws: {
    offset: number;
    pipeline: RenderPipeline | undefined;
    material: BindGroup | undefined;
    mesh: BindGroup | undefined;
  }[] = [];
  const pass = {
    executeBundles(bundles: Iterable<import('@forgeax/engine-rhi').RenderBundle>) {
      return replayShadowBundles(pass, bundles);
    },
    setPipeline(value: RenderPipeline) {
      pipeline = value;
    },
    setBindGroup(index: number, value: BindGroup) {
      if (index === 1) material = value;
      if (index === 2) mesh = value;
    },
    setVertexBuffer() {},
    setIndexBuffer() {},
    drawIndirect(_buffer: unknown, offset: number) {
      draws.push({ offset, pipeline, material, mesh });
    },
    drawIndexedIndirect(_buffer: unknown, offset: number) {
      draws.push({ offset, pipeline, material, mesh });
    },
  } as unknown as RhiRenderPassEncoder;
  return {
    ...f,
    projections,
    device,
    buffer,
    replacement,
    group,
    pass,
    draws,
    lookup,
    create,
    run: () =>
      encodeStaticShadowPass(
        f.context,
        pass,
        { kind: 'directional', index: 0 },
        undefined,
        reuseAdjacentShadow,
      ),
    dispose() {
      device.destroyBuffer(replacement).unwrap();
      device.destroyBuffer(buffer).unwrap();
    },
  };
}

it('resolves one actual PSO request per invocation for 64 adjacent batches over 60 frames', async () => {
  const f = await fixture();
  try {
    for (let frame = 0; frame < 60; frame++) f.run();
    expect(f.draws).toHaveLength(3840);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.draws.every((draw) => draw.pipeline === f.lookup.mock.results[0]?.value)).toBe(true);
    expect(f.lookup).toHaveBeenCalledTimes(60);
  } finally {
    f.dispose();
  }
});

it.each([
  'shader',
  'artifact',
  'receipt',
  'variant',
  'layout',
  'uv',
  'render-state',
  'vertex-entry',
  'fragment-entry',
  'skin',
  'color',
  'mask',
  'topology',
  'indexed',
  'index-format',
])('preserves adjacent A/B/A pipeline requests when %s differs', async (change) => {
  const f = await fixture();
  try {
    f.batches.length = 3;
    const middle = defined(f.batches[1]);
    const original = defined(f.projections.get(middle.batchId));
    let changed = original;
    switch (change) {
      case 'shader':
        changed = {
          ...original,
          shadowArtifact: { ...original.shadowArtifact, specializationKey: 'game::shadow' },
        };
        break;
      case 'artifact':
        changed = { ...original, shadowArtifact: { ...original.shadowArtifact } };
        break;
      case 'receipt':
        changed = {
          ...original,
          shadowArtifact: {
            ...original.shadowArtifact,
            receipt: {
              ...defined(original.shadowArtifact.receipt),
              sceneIndexEntry: 'vs_replacement',
            },
          },
        };
        break;
      case 'variant':
        changed = {
          ...original,
          shadowArtifact: { ...original.shadowArtifact, variantSet: 'GPU_SCENE_AVAILABLE=false' },
        };
        break;
      case 'layout':
        changed = {
          ...original,
          mesh: {
            ...original.mesh,
            layoutProjection: deriveVertexLayoutProjection({
              position: new Float32Array(0),
              normal: new Float32Array(0),
            }),
          },
        };
        break;
      case 'uv':
        changed = {
          ...original,
          mesh: {
            ...original.mesh,
            layoutProjection: deriveVertexLayoutProjection({
              position: new Float32Array(0),
              uv: new Float32Array(0),
              uv1: new Float32Array(0),
            }),
          },
        };
        break;
      case 'render-state':
        changed = { ...original, shadowRenderState: { cullMode: 'none' } };
        break;
      case 'vertex-entry':
        changed = { ...original, shadowVertexEntry: 'vs_authored' };
        break;
      case 'fragment-entry':
        changed = { ...original, shadowFragmentEntry: 'fs_authored' };
        break;
      case 'skin':
        changed = { ...original, deformation: 'skin' };
        break;
      case 'color':
        changed = { ...original, vertexColorAvailable: true };
        break;
      case 'mask':
        changed = { ...original, material: { ...original.material, standardTextureMask: 7 } };
        break;
      case 'topology':
        middle.key.topology = 'line-list';
        break;
      case 'indexed':
        middle.key.drawKind = 'indexed';
        changed = {
          ...original,
          mesh: {
            ...original.mesh,
            indexBuffer: original.mesh.vertexBuffer,
            indexFormat: 'uint16',
          },
        };
        break;
      case 'index-format':
        for (const batch of f.batches) {
          batch.key.drawKind = 'indexed';
          const projection = defined(f.projections.get(batch.batchId));
          f.projections.set(batch.batchId, {
            ...projection,
            mesh: {
              ...projection.mesh,
              indexBuffer: projection.mesh.vertexBuffer,
              indexFormat: 'uint16',
            },
          });
        }
        changed = {
          ...defined(f.projections.get(middle.batchId)),
          mesh: { ...defined(f.projections.get(middle.batchId)).mesh, indexFormat: 'uint32' },
        };
        break;
    }
    f.projections.set(middle.batchId, changed);
    f.run();
    expect(f.lookup).toHaveBeenCalledTimes(3);
    expect(f.draws.map((draw) => draw.offset)).toEqual(
      f.batches.map((batch) => batch.indirectOffset),
    );
    for (let index = 0; index < 3; index++)
      expect(f.draws[index]?.pipeline).toBe(f.lookup.mock.results[index]?.value);
  } finally {
    f.dispose();
  }
});

it('keeps point winding and the next invocation separate', async () => {
  const f = await fixture();
  try {
    f.run();
    const p = f.context.pipelineState;
    getOrCreateFromChain(
      f.context.frameState.viewBindGroupCache,
      [
        f.buffer,
        defined(p.shadowArrayFallbackTextureView),
        defined(p.perPassResources.shadowSampler),
        defined(p.shadowAtlasFallbackTextureView),
        f.buffer,
        f.buffer,
        defined(p.shadowArrayFallbackTextureView),
        f.buffer,
      ],
      'view-shadow-point-0-0',
      () => f.group,
      f.context.bindGroupCounts,
    );
    Object.assign(f.context.frameState, { pointShadowSnapshots: [{ shadowAtlasLayer: 0 }] });
    (f.context.gpuDrivenShadowBatchProjections as Map<string, unknown>).set(
      'point:0:0:static',
      f.projections,
    );
    encodeStaticShadowPass(
      f.context,
      f.pass,
      { kind: 'point', index: 0, face: 0 },
      undefined,
      true,
    );
    expect(f.lookup).toHaveBeenCalledTimes(2);
    expect(f.lookup.mock.calls[0]?.[2]?.frontFace).toBeUndefined();
    expect(f.lookup.mock.calls[1]?.[2]?.frontFace).toBe('cw');
    const state = { cullMode: 'back' as const, frontFace: 'cw' as const };
    for (const [id, projection] of f.projections)
      f.projections.set(id, { ...projection, shadowRenderState: state });
    encodeStaticShadowPass(
      f.context,
      f.pass,
      { kind: 'point', index: 0, face: 0 },
      undefined,
      true,
    );
    expect(f.lookup).toHaveBeenCalledTimes(3);
    expect(f.lookup.mock.calls[2]?.[2]?.frontFace).toBe('ccw');
  } finally {
    f.dispose();
  }
});

it('observes alpha-mask coverage and still rejects its missing material resources', async () => {
  const f = await fixture();
  try {
    const artifact = { ...defined(f.projections.values().next().value).shadowArtifact };
    delete artifact.variantSet;
    for (const [id, projection] of f.projections)
      f.projections.set(id, { ...projection, shadowArtifact: artifact });
    defined(f.batches[1]).key.admission = 'alpha-mask';
    expect(f.run).toThrow('GPU Scene material buffer');
    expect(f.lookup).toHaveBeenCalledTimes(2);
    expect(f.lookup.mock.calls[0]?.[5]).toContain('ALPHA_MASK=false');
    expect(f.lookup.mock.calls[1]?.[5]).not.toBe(f.lookup.mock.calls[0]?.[5]);
    expect(f.draws).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

it('rejects a missing indexed buffer even after a matching pipeline was prepared', async () => {
  const f = await fixture();
  try {
    for (const batch of f.batches) {
      batch.key.drawKind = 'indexed';
      const projection = defined(f.projections.get(batch.batchId));
      f.projections.set(batch.batchId, {
        ...projection,
        mesh: {
          ...projection.mesh,
          indexBuffer: batch === f.batches[1] ? null : projection.mesh.vertexBuffer,
          indexFormat: 'uint16',
        },
      });
    }
    expect(f.run).toThrow('indexed mesh buffer');
    expect(f.lookup).toHaveBeenCalledTimes(1);
    expect(f.draws).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

it('does not retain a missing pipeline between invocations', async () => {
  const f = await fixture();
  try {
    f.lookup.mockReturnValueOnce(null);
    expect(f.run).toThrow('GPU-driven shadow pipeline');
    expect(f.draws).toHaveLength(0);
    f.run();
    expect(f.lookup).toHaveBeenCalledTimes(2);
    expect(f.draws).toHaveLength(64);
  } finally {
    f.dispose();
  }
});

it('rejects a missing receipt before reusing any pipeline', async () => {
  const f = await fixture();
  try {
    const middle = defined(f.batches[1]);
    const projection = defined(f.projections.get(middle.batchId));
    const artifact = { ...projection.shadowArtifact };
    delete artifact.receipt;
    f.projections.set(middle.batchId, { ...projection, shadowArtifact: artifact });
    expect(f.run).toThrow('published shadow MaterialProgramAbi');
    expect(f.lookup).toHaveBeenCalledTimes(1);
    expect(f.draws).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

function defined<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Missing shadow test fixture value');
  return value;
}

it('preserves raw adjacent artifact getter failures by identity', async () => {
  const f = await fixture(false);
  const failure = new Error('second artifact observation');
  try {
    const artifact = defined(f.projections.values().next().value).shadowArtifact;
    let reads = 0;
    Object.defineProperty(artifact, 'variantSet', {
      get() {
        if (++reads === 2) throw failure;
        return 'GPU_SCENE_AVAILABLE=true';
      },
    });
    let thrown: unknown;
    try {
      f.run();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(reads).toBe(2);
    expect(f.lookup).toHaveBeenCalledTimes(1);
    expect(f.draws).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

it('preserves raw pipeline callback failures even for a frozen artifact', async () => {
  const f = await fixture(false);
  const failure = new Error('second pipeline callback');
  try {
    Object.freeze(defined(f.projections.values().next().value).shadowArtifact);
    const original = f.lookup.getMockImplementation();
    let calls = 0;
    f.lookup.mockImplementation((...args) => {
      if (++calls === 2) throw failure;
      return defined(original)(...args);
    });
    let thrown: unknown;
    try {
      f.run();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(calls).toBe(2);
    expect(f.draws).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

it('observes raw in-place entry changes from the preceding callback', async () => {
  const f = await fixture(false);
  try {
    f.batches.length = 2;
    const receipt = defined(defined(f.projections.values().next().value).shadowArtifact.receipt);
    const original = defined(f.lookup.getMockImplementation());
    f.lookup.mockImplementation((...args) => {
      const pipeline = original(...args);
      Object.assign(receipt, { sceneIndexEntry: 'vs_changed' });
      return pipeline;
    });
    f.run();
    expect(f.lookup.mock.calls.map((args) => args[16])).toEqual(['vs_main', 'vs_changed']);
    expect(f.draws).toHaveLength(2);
    expect(f.draws[0]?.pipeline).not.toBe(f.draws[1]?.pipeline);
  } finally {
    f.dispose();
  }
});
