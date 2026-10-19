import { mat4 } from '@forgeax/engine-math';
import { RhiError, type RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import {
  buildMatchedMaterialHandlesByRenderable,
  buildMatchedRenderableIndices,
  createShadowDispatchProjectionOwner,
  encodeDirectionalShadowPass,
  encodePointShadowPass,
  encodeSpotShadowPass,
  resolveShadowDispatchProjection,
  shadowShaderMap,
} from '../record/shadow-pass';

function fixture(count = 8) {
  let tagReads = 0;
  const c = {
    dispatch: Array.from({ length: count }, (_, i) => ({
      renderableIndex: 4,
      materialHandle: i,
      passIndex: i,
      materialShaderId: 'forgeax::default-standard-pbr',
      tags: {
        get LightMode() {
          tagReads++;
          return 'ShadowCaster';
        },
      },
    })),
    validatedOrdered: [{ renderableIndex: 4 }],
    materialSlotIndices: [Array.from({ length: count }, (_, i) => i)],
    materialSlots: Array.from({ length: count }, (_, materialHandle) => ({ materialHandle })),
  } as unknown as _InternalRenderPipelineContext;
  return { c, reads: () => tagReads };
}
function legacy(c: _InternalRenderPipelineContext) {
  const dispatch = c.shadowDispatch ?? c.dispatch;
  return {
    matchedIndices: buildMatchedRenderableIndices(dispatch, { LightMode: ['ShadowCaster'] }),
    matchedMaterialHandles: buildMatchedMaterialHandlesByRenderable(dispatch, {
      LightMode: ['ShadowCaster'],
    }),
    shaders: shadowShaderMap(c),
  };
}

describe('production frame ShadowCaster dispatch projection', () => {
  it('is lazy and reduces roster walks from views*D to D without changing results', () => {
    const a = fixture(64),
      b = fixture(64);
    const owner = createShadowDispatchProjectionOwner(b.c);
    expect(b.reads()).toBe(0);
    const first = owner.resolve(b.c);
    for (let view = 0; view < 10; view++) {
      expect(owner.resolve({ ...b.c })).toBe(first);
      expect(first).toEqual(legacy(a.c));
    }
    expect(a.reads()).toBe(64 * 3 * 10);
    // Material membership also supplies the renderable set; only shader lookup
    // needs a second roster walk.
    expect(b.reads()).toBe(64 * 2);
  });

  it('keeps empty-dispatch null, nonmatching empty and shaderless caster admission distinct', () => {
    const f = fixture(1),
      c = f.c;
    for (const dispatch of [
      [],
      [{ ...c.dispatch[0], tags: { LightMode: 'Forward' } }],
      [{ ...c.dispatch[0], materialShaderId: undefined }],
    ]) {
      const input = { ...c, dispatch } as _InternalRenderPipelineContext;
      const result = createShadowDispatchProjectionOwner(input).resolve(input);
      expect(result).toEqual(legacy(input));
      if (dispatch.length === 0) expect(result.matchedIndices).toBeNull();
      else if (dispatch[0]?.materialShaderId === undefined) {
        expect(result.matchedIndices?.has(4)).toBe(true);
        expect(result.shaders.size).toBe(0);
      }
    }
  });

  it('rebuilds after between-frame in-place material, roster, and slot mutations', () => {
    const { c } = fixture(2);
    const before = createShadowDispatchProjectionOwner(c).resolve(c);
    const material = c.materialSlots[0];
    if (material === undefined) throw Error('Missing fixture material');
    Object.assign(material, { materialHandle: 90 });
    const dispatch = c.dispatch[0];
    if (dispatch === undefined) throw Error('Missing fixture dispatch');
    Object.assign(dispatch, { materialHandle: 90 });
    const after = createShadowDispatchProjectionOwner(c).resolve(c);
    expect(after).not.toBe(before);
    expect(after.shaders.get(4)?.get(90)?.[0]?.materialSlot).toBe(0);
    expect(after.shaders.get(4)?.has(0)).toBe(false);
    expect(before.shaders.get(4)?.has(0)).toBe(true);
  });

  it('rejects sharing when any view-independent input roster or slot layout differs', () => {
    const { c } = fixture(2),
      owner = createShadowDispatchProjectionOwner(c);
    const before = owner.resolve(c);
    const views = [
      { ...c, dispatch: [...c.dispatch].reverse() },
      { ...c, shadowDispatch: [...c.dispatch], shadowValidatedOrdered: [...c.validatedOrdered] },
      { ...c, validatedOrdered: [...c.validatedOrdered] },
      { ...c, materialSlotIndices: [[1, 0]] },
      { ...c, materialSlots: c.materialSlots.map((m) => ({ ...m, materialHandle: 90 })) },
    ];
    for (const view of views) {
      expect(owner.resolve(view)).not.toBe(before);
      expect(owner.resolve(view)).toEqual(legacy(view));
    }
    expect(owner.resolve(c)).toBe(before);
  });

  it('does not include camera planes, skin/layout, reflected state or GPU claims in the roster projection', () => {
    const { c } = fixture(),
      owner = createShadowDispatchProjectionOwner(c);
    const before = owner.resolve(c);
    const views = [
      { ...c, shadowViewPlanesByView: new Map([['point:0:0', new Float32Array(24)]]) },
      { ...c, shadowMeshSsboBase: 32, capsuleShadowDirectional: true },
      { ...c, gpuDrivenShadowDrawKeys: new Set(['different-current-claim']) },
      { ...c, pipelineState: {} as never, meshBindGroup: {} as never },
    ];
    for (const view of views) expect(owner.resolve(view)).toBe(before);
    expect(resolveShadowDispatchProjection(c)).toEqual(legacy(c));
  });
});

function frontDoors(prepared: boolean, nonempty = false, paged = false) {
  const f = fixture(8),
    resource = {};
  const c = {
    ...f.c,
    dispatch: nonempty
      ? f.c.dispatch.map((entry) => ({ ...entry, materialShaderId: undefined }))
      : f.c.dispatch,
    validatedOrdered: nonempty
      ? [
          {
            renderableIndex: 4,
            source: {
              worldId: 0,
              entityKey: 1,
              transform: { world: mat4.identity(mat4.create()) },
              material: { materialHandle: 0 },
              materials: [{ materialHandle: 0 }],
            },
            mesh: {
              vertexBuffer: { handle: resource },
              indexed: false,
              indexBuffer: null,
              submeshes: [
                {
                  topology: 'triangle-list',
                  materialSlot: 0,
                  vertexCount: 3,
                  indexCount: 0,
                  indexOffset: 0,
                },
              ],
            },
          },
        ]
      : [],
    runtime: {
      device: {
        caps: { storageBuffer: false },
        limits: { maxSampledTexturesPerShaderStage: 16 },
        createBindGroup: (descriptor: unknown) => ({ ok: true, value: descriptor }),
      },
      getMaterialShaderPipeline: () => ({}),
      errorRegistry: {
        fire: () => {
          throw Error('Unexpected RHI error');
        },
      },
    },
    pipelineState: {
      perPassResources: { shadowSampler: resource },
      identityInstanceBuffer: resource,
      instancesBindGroupLayout: resource,
      viewUniformBuffer: resource,
      shadowArrayFallbackTextureView: resource,
      shadowAtlasFallbackTextureView: resource,
      shadowParamsBuffer: resource,
      shadowCasterCascadeBuffer: resource,
      defaultWhiteTextureView: resource,
      defaultSampler: resource,
      viewBindGroupLayout: resource,
      materialBindGroupLayout: resource,
      materialUniformBuffer: { buffer: resource },
      meshStorageBuffer: { buffer: resource },
      meshBindGroupLayout: resource,
      defaultNormalTextureView: resource,
      fallbackTextureView: resource,
      skylightFallback: null,
    },
    frameState: {
      meshBindGroupCache: new WeakMap(),
      viewBindGroupCache: new WeakMap(),
      shadowMaterialBindGroups: new WeakMap(),
      pointShadowSnapshots: [{ shadowAtlasLayer: 0 }],
      spotShadowSnapshots: [{ shadowAtlasTile: 0, lightViewProj: new Float32Array(16) }],
    },
    meshBindGroup: resource,
    bindGroupCounts: { createBindGroup: 0, keys: [] },
  } as unknown as _InternalRenderPipelineContext;
  const secondPage = {};
  if (paged) {
    Object.assign(c, { shadowMeshSsboBase: 25 });
    Object.assign(c.pipelineState.meshStorageBuffer, {
      buffer: null,
      pages: { byteStride: 6400, byteSize: 16384, buffers: [resource, secondPage] },
    });
  }
  if (prepared)
    Object.assign(c, { shadowDispatchProjection: createShadowDispatchProjectionOwner(c) });
  const trace: unknown[] = [];
  const meshGroups: unknown[] = [];
  const pass = {
    setBindGroup: (...args: unknown[]) => {
      trace.push(['bg', args[0], args[2]]);
      if (args[0] === 2) meshGroups.push(args[1]);
    },
    setPipeline: () => trace.push(['pipeline']),
    setVertexBuffer: (...args: unknown[]) => trace.push(['vertex', args[0]]),
    draw: (...args: unknown[]) => trace.push(['draw', ...args]),
  } as unknown as RhiRenderPassEncoder;
  for (let cascade = 0; cascade < 3; cascade++) encodeDirectionalShadowPass(c, pass, cascade);
  for (let face = 0; face < 6; face++) encodePointShadowPass(c, pass, 0, face);
  encodeSpotShadowPass(c, pass, 0);
  return { trace, tagReads: f.reads(), meshGroups, secondPage };
}
it('uses the same lazy owner across three cascades, six point faces and a spot front door', () => {
  const fallback = frontDoors(false),
    prepared = frontDoors(true);
  expect(prepared.trace).toEqual(fallback.trace);
  expect(fallback.tagReads - prepared.tagReads).toBe(8 * 2 * 9);
});

it('records a nonempty default-caster residual for every cascade, point face and spot', () => {
  const fallback = frontDoors(false, true),
    prepared = frontDoors(true, true);
  expect(prepared.trace).toEqual(fallback.trace);
  expect(prepared.trace.filter((entry) => (entry as unknown[])[0] === 'draw')).toEqual(
    Array.from({ length: 10 }, () => ['draw', 3, 1, 0, 0]),
  );
  expect(prepared.trace.filter((entry) => (entry as unknown[])[0] === 'vertex')).toHaveLength(10);
  expect(fallback.tagReads - prepared.tagReads).toBe(8 * 2 * 9);
});

it('does not resolve prepared dispatch before directional, point or spot bind-group admission', () => {
  const { c: base } = fixture(1);
  let resolves = 0;
  const c = {
    ...base,
    runtime: { device: { caps: { storageBuffer: false } }, getMaterialShaderPipeline: () => ({}) },
    pipelineState: { perPassResources: { shadowSampler: null } },
    frameState: {
      pointShadowSnapshots: [{ shadowAtlasLayer: 0 }],
      spotShadowSnapshots: [{ shadowAtlasTile: 0, lightViewProj: new Float32Array(16) }],
    },
    shadowDispatchProjection: {
      casters() {
        throw Error('Premature caster preparation');
      },
      resolve() {
        resolves++;
        throw Error('Premature dispatch preparation');
      },
    },
  } as unknown as _InternalRenderPipelineContext;
  const pass = {} as RhiRenderPassEncoder;
  for (const encode of [
    () => encodeDirectionalShadowPass(c, pass, 0),
    () => encodePointShadowPass(c, pass, 0, 0),
    () => encodeSpotShadowPass(c, pass, 0),
  ])
    expect(encode).toThrowError(RhiError);
  expect(resolves).toBe(0);
});

it('keeps directional, point and spot residuals on the same physical mesh page', () => {
  const f = frontDoors(true, true, true);
  expect(f.meshGroups).toHaveLength(10);
  for (const group of f.meshGroups) {
    expect(group).toMatchObject({
      label: 'pbr-mesh-bg',
      entries: [
        {
          binding: 0,
          resource: { kind: 'buffer', value: { buffer: f.secondPage, offset: 0, size: 10240 } },
        },
      ],
    });
  }
  expect(
    f.trace.filter((row) => (row as unknown[])[0] === 'bg' && (row as unknown[])[1] === 2),
  ).toEqual(Array.from({ length: 10 }, () => ['bg', 2, [0]]));
});
