import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { GpuDrivenShadowBatchProjection } from '../gpu-driven/production-raster';
import type { RenderSystemInternals } from '../record/render-context';
import { prepareShadowMaterialPipelines } from '../record/shadow-pass';
import { preparedShadowFixture } from './shadow-indirect.fixture';

type Factory = NonNullable<RenderSystemInternals['prepareMaterialShaderPipeline']>;

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const buffer = device.createBuffer({ size: 4096, usage: 0xa8 }).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const group = device.createBindGroup({ layout, entries: [] }).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs_main', buffers: [] },
    })
    .unwrap();
  const f = preparedShadowFixture({
    device,
    buffer,
    layout,
    view: group,
    shared: {
      indirectOffset: 0,
      pipeline,
      vertexBuffer: buffer,
      materialGroup: group,
      meshBindGroup: group,
      visibleBindGroups: [group],
      deformation: 'rigid',
    },
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  });
  const prepare = vi.fn<Factory>(() => pipeline);
  Object.assign(f.context.runtime, { prepareMaterialShaderPipeline: prepare });
  const views = [0, 1, 2].map((index) => ({ identity: { kind: 'directional' as const, index } }));
  if (f.context.gpuDrivenShadowViews === undefined) throw Error('missing view pool');
  Object.assign(f.context.gpuDrivenShadowViews, { inspect: () => views });
  const maps = views.map(
    () => new Map(f.projections) as unknown as Map<number, GpuDrivenShadowBatchProjection>,
  );
  Object.assign(f.context, {
    gpuDrivenShadowBatchProjections: new Map(maps.map((map, i) => [`directional:${i}:`, map])),
  });
  return { ...f, maps, prepare, pipeline, dispose: () => device.destroyBuffer(buffer).unwrap() };
}

it('prepares each exact batch once across three cascades, and starts fresh next frame', async () => {
  const f = await fixture();
  try {
    prepareShadowMaterialPipelines(f.context, true);
    expect(f.prepare).toHaveBeenCalledTimes(64);
    prepareShadowMaterialPipelines(f.context, true);
    expect(f.prepare).toHaveBeenCalledTimes(128);
    expect(f.context.frameState.pipelinePreparationPending).not.toBe(true);
  } finally {
    f.dispose();
  }
});

it('retains every raw factory call and retries all pending requests', async () => {
  const f = await fixture();
  try {
    prepareShadowMaterialPipelines(f.context);
    expect(f.prepare).toHaveBeenCalledTimes(192);
    f.prepare.mockClear().mockReturnValue(null);
    prepareShadowMaterialPipelines(f.context, true);
    expect(f.prepare).toHaveBeenCalledTimes(192);
    expect(f.context.frameState.pipelinePreparationPending).toBe(true);
    f.prepare.mockClear().mockReturnValue(f.pipeline);
    f.context.frameState.pipelinePreparationPending = false;
    prepareShadowMaterialPipelines(f.context, true);
    expect(f.prepare).toHaveBeenCalledTimes(64);
    expect(f.context.frameState.pipelinePreparationPending).toBe(false);
  } finally {
    f.dispose();
  }
});

it.each([
  'artifact',
  'state',
  'vertex',
  'fragment',
  'skin',
  'color',
  'mask',
  'layout',
  'index-format',
] as const)('keeps the actual %s variant when cascade batch addresses coincide', async (change) => {
  const f = await fixture();
  try {
    const map = f.maps[1];
    const first = f.batches[0];
    if (map === undefined || first === undefined) throw Error('missing fixture batch');
    const original = map.get(first.batchId);
    if (original === undefined) throw Error('missing fixture projection');
    let changed = original;
    switch (change) {
      case 'artifact':
        changed = {
          ...original,
          shadowArtifact: { ...original.shadowArtifact, specializationKey: 'other::shadow' },
        };
        break;
      case 'state':
        changed = { ...original, shadowRenderState: { cullMode: 'front' } };
        break;
      case 'vertex':
        changed = { ...original, shadowVertexEntry: 'vs_other' };
        break;
      case 'fragment':
        changed = { ...original, shadowFragmentEntry: 'fs_other' };
        break;
      case 'skin':
        changed = { ...original, deformation: 'skin' };
        break;
      case 'color':
        changed = { ...original, vertexColorAvailable: !original.vertexColorAvailable };
        break;
      case 'mask':
        changed = { ...original, material: { ...original.material, standardTextureMask: 7 } };
        break;
      case 'layout':
        changed = {
          ...original,
          mesh: {
            ...original.mesh,
            layoutProjection: deriveVertexLayoutProjection({
              position: new Float32Array(0),
              uv: new Float32Array(0),
            }),
          },
        };
        break;
      case 'index-format': {
        // Same batch address, a distinct indexed physical layout in this view.
        first.key.drawKind = 'indexed';
        for (const views of f.maps) {
          const row = views.get(first.batchId);
          if (row !== undefined)
            views.set(first.batchId, { ...row, mesh: { ...row.mesh, indexFormat: 'uint16' } });
        }
        changed = { ...original, mesh: { ...original.mesh, indexFormat: 'uint32' } };
        break;
      }
    }
    map.set(first.batchId, changed);
    prepareShadowMaterialPipelines(f.context, true);
    // A/B/A must revisit A after the second view changes the same address.
    expect(f.prepare).toHaveBeenCalledTimes(66);
  } finally {
    f.dispose();
  }
});

it('propagates native preparation failures and does not retain success into a later invocation', async () => {
  const f = await fixture();
  try {
    const failure = Error('native compile rejected');
    f.prepare.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => prepareShadowMaterialPipelines(f.context, true)).toThrow(failure);
    f.prepare.mockClear();
    prepareShadowMaterialPipelines(f.context, true);
    expect(f.prepare).toHaveBeenCalledTimes(64);
  } finally {
    f.dispose();
  }
});

it.each([
  'admission',
  'topology',
  'drawKind',
] as const)('keeps the %s batch-key variant', async (change) => {
  const f = await fixture();
  try {
    const plans = [0, 1, 2].map(() =>
      f.batches.map((batch) => ({ ...batch, key: { ...batch.key } })),
    );
    const first = plans[1]?.[0];
    if (first === undefined || f.context.gpuDrivenShadowViews === undefined)
      throw Error('missing fixture plan');
    first.key[change] =
      change === 'admission' ? 'alpha-mask' : change === 'topology' ? 'line-list' : 'indexed';
    Object.assign(f.context.gpuDrivenShadowViews, {
      submission: (identity: { index: number }) => ({
        view: f.shadowView,
        plan: { batches: plans[identity.index] },
      }),
    });
    prepareShadowMaterialPipelines(f.context, true);
    expect(f.prepare).toHaveBeenCalledTimes(66);
  } finally {
    f.dispose();
  }
});

it('keeps point reflection distinct from a coincident directional batch address', async () => {
  const f = await fixture();
  try {
    if (f.context.gpuDrivenShadowViews === undefined) throw Error('missing view pool');
    Object.assign(f.context.gpuDrivenShadowViews, {
      inspect: () => [
        { identity: { kind: 'directional', index: 0 } },
        { identity: { kind: 'point', index: 0 } },
      ],
    });
    const projections = f.maps[0];
    if (projections === undefined) throw Error('missing projections');
    Object.assign(f.context, {
      gpuDrivenShadowBatchProjections: new Map([
        ['directional:0:', projections],
        ['point:0:', projections],
      ]),
    });
    prepareShadowMaterialPipelines(f.context, true);
    expect(f.prepare).toHaveBeenCalledTimes(128);
    expect(f.prepare.mock.calls[0]?.[2]?.frontFace).not.toEqual(
      f.prepare.mock.calls[64]?.[2]?.frontFace,
    );
  } finally {
    f.dispose();
  }
});

it('prepares only graph-demanded views while raw callers keep every request', async () => {
  const f = await fixture();
  try {
    prepareShadowMaterialPipelines(f.context, true, () => false);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.context.frameState.pipelinePreparationPending).not.toBe(true);
    prepareShadowMaterialPipelines(f.context, true, (_frame, identity) => identity.index === 1);
    expect(f.prepare).toHaveBeenCalledTimes(64);
    f.prepare.mockClear();
    prepareShadowMaterialPipelines(f.context, false, () => false);
    expect(f.prepare).toHaveBeenCalledTimes(192);
  } finally {
    f.dispose();
  }
});
