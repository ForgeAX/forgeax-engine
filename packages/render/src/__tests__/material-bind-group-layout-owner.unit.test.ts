import { World } from '@forgeax/engine-ecs';
import type { BindGroup, BindGroupEntry, BindGroupLayout, Buffer } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { IblBindingInspection } from '../mesh-material-bindings';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import { recordIblPipelineBinding } from '../record/main-pass-geometry';
import {
  buildPerSubmeshMaterialBg,
  type PerSubmeshMaterialBgDeps,
} from '../record/main-pass-material';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
import { MATERIAL_PER_ENTITY_STRIDE } from '../record/render-context';
import { defaultMaterialSnapshot, type MaterialSnapshot } from '../render-system-extract';

function fixture() {
  const resource = () => ({});
  const layouts: object[] = [];
  let layout = resource();
  let failure: Error | undefined;
  const deps = {
    runtime: {
      device: {
        caps: { storageBuffer: false },
        queue: { writeBuffer: () => ok(undefined) },
        limits: { maxSampledTexturesPerShaderStage: 16 },
        createBindGroup: (descriptor: { layout: object; entries: BindGroupEntry[] }) => {
          layouts.push(descriptor.layout);
          if (failure !== undefined) return { ok: false, error: failure };
          return { ok: true, value: { layout: descriptor.layout, entries: descriptor.entries } };
        },
      },
      getParamSchema: () => [],
      getMaterialBindGroupLayout: () => layout,
    },
    pipelineState: {
      materialBindGroupLayout: resource(),
      materialUniformBuffer: { buffer: resource() },
      defaultSampler: resource(),
      defaultWhiteTextureView: resource(),
    },
    world: new World(),
    store: { materialResourceEpoch: 0 },
    materialSlice: 256,
    videoHighPerfAvailable: false,
    skylightResources: {
      skySh: resource(),
      irradianceSampler: resource(),
      prefilterView: resource(),
      prefilterSampler: resource(),
      brdfLutView: resource(),
      intensityBuffer: resource(),
    },
    materialBgShared: new Map(),
    materialBgAssemblyCache: new MaterialBgAssemblyCache(),
    bindGroupCounts: { createBindGroup: 0, keys: [] },
    frameState: {},
  } as unknown as PerSubmeshMaterialBgDeps;
  const material = {
    ...defaultMaterialSnapshot(),
    materialHandle: 1,
    materialShaderId: 'game::replaceable',
  };
  const draw = (): BindGroup => buildPerSubmeshMaterialBg(deps, material, 1);
  return {
    deps,
    material,
    draw,
    layouts,
    get layout() {
      return layout as BindGroupLayout;
    },
    replaceLayout() {
      layout = resource();
    },
    selectLayout(value: BindGroupLayout) {
      layout = value;
    },
    fail(error: Error | undefined) {
      failure = error;
    },
  };
}

describe('material shared bind-group layout ownership', () => {
  it('retains unchanged resource/layout reuse and observes a replacement layout', () => {
    const f = fixture();
    const firstLayout = f.layout;
    const first = f.draw();
    expect(f.draw()).toBe(first);
    f.replaceLayout();
    const second = f.draw();
    expect(second).not.toBe(first);
    expect(f.layouts).toEqual([firstLayout, f.layout]);
    expect(f.draw()).toBe(second);
    expect(f.deps.bindGroupCounts.createBindGroup).toBe(2);
  });

  it('keeps replacement creation errors observable and allows retry', () => {
    const f = fixture();
    const first = f.draw();
    f.replaceLayout();
    const error = new Error('new publication layout creation failed');
    f.fail(error);
    expect(() => f.draw()).toThrow(error);
    f.fail(undefined);
    const recovered = f.draw();
    expect(recovered).not.toBe(first);
    expect(f.layouts).toHaveLength(3);
    expect(f.deps.bindGroupCounts.createBindGroup).toBe(2);
  });

  it('can reuse the original layout if a later publication returns to it', () => {
    const f = fixture();
    const originalLayout = f.layout;
    const first = f.draw();
    f.replaceLayout();
    expect(f.draw()).not.toBe(first);
    f.selectLayout(originalLayout);
    expect(f.draw()).toBe(first);
    expect(f.layouts).toHaveLength(2);
  });
});

it('selects the physical material page while reusing groups within that page', () => {
  const f = fixture();
  const first = {} as Buffer;
  const second = {} as Buffer;
  Object.assign(f.deps.pipelineState.materialUniformBuffer, {
    buffer: null,
    pages: {
      byteStride: 12 * MATERIAL_PER_ENTITY_STRIDE,
      byteSize: 12 * MATERIAL_PER_ENTITY_STRIDE,
      buffers: [first, second],
    },
  });
  const materials = Array.from({ length: 14 }, (_, index) => ({
    ...defaultMaterialSnapshot(),
    materialHandle: index + 1,
    materialShaderId: 'game::replaceable',
  }));
  const draw = (slot: number) => {
    const material = materials[slot];
    if (material === undefined) throw new Error('missing material');
    return buildPerSubmeshMaterialBg(f.deps, material, 1, f.deps.world, material.materialShaderId);
  };
  for (let slot = 0; slot < 11; slot++) draw(slot);
  const a = draw(11);
  const b = draw(12);
  expect(b).not.toBe(a);
  const buffer = (group: BindGroup) =>
    (group as unknown as { entries: BindGroupEntry[] }).entries[0]?.resource;
  expect(buffer(a)).toMatchObject({ kind: 'buffer', value: { buffer: first, offset: 0 } });
  expect(buffer(b)).toMatchObject({ kind: 'buffer', value: { buffer: second, offset: 0 } });
  expect(draw(13)).toBe(b);
  expect(draw(0)).toBe(a);
});

it('binds prepared material views and observes appearance, replacement and removal in the same cache', () => {
  const f = fixture();
  let prepared:
    | {
        textureView: import('@forgeax/engine-rhi').TextureView;
        sampler: import('@forgeax/engine-rhi').Sampler;
      }
    | undefined;
  Object.assign(f.deps.runtime, {
    getParamSchema: () => [{ name: 'field', type: 'texture2d' }],
    preparedMaterialTexture: (_material: MaterialSnapshot, field: string) =>
      field === 'field' ? prepared : undefined,
  });
  const original = f.draw();
  const entries = (group: BindGroup) => (group as unknown as { entries: BindGroupEntry[] }).entries;
  prepared = {
    textureView: {} as import('@forgeax/engine-rhi').TextureView,
    sampler: {} as import('@forgeax/engine-rhi').Sampler,
  };
  const first = f.draw();
  expect(first).not.toBe(original);
  expect(entries(first).find((entry) => entry.binding === 2)?.resource).toEqual({
    kind: 'textureView',
    value: prepared.textureView,
  });
  expect(entries(first).find((entry) => entry.binding === 1)?.resource).toEqual({
    kind: 'sampler',
    value: prepared.sampler,
  });
  expect(f.draw()).toBe(first);
  prepared = { ...prepared, textureView: {} as import('@forgeax/engine-rhi').TextureView };
  const second = f.draw();
  expect(second).not.toBe(first);
  expect(f.draw()).toBe(second);
  prepared = undefined;
  expect(f.draw()).toBe(original);
});

function iblReceipt(deps: PerSubmeshMaterialBgDeps, frameId: number): IblBindingInspection {
  const r = deps.skylightResources,
    id = (value: object) => getOpaqueResourceIdentity(value);
  const resource = (view: object, sampler: object) => ({
    viewIdentity: id(view),
    samplerIdentity: id(sampler),
    deviceGeneration: 1,
  });
  return {
    status: 'binding-chain-consistent',
    frameId,
    deviceGeneration: 1,
    active: 'fallback',
    cache: { identity: 1, generation: 1, prefilterMipCount: 1, prefilterViewMipCount: 1 },
    sampler: {
      expected: {
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        addressModeW: 'clamp-to-edge',
      },
      identities: [id(r.irradianceSampler), id(r.prefilterSampler)],
    },
    resources: {
      irradiance: resource(r.skySh, r.irradianceSampler),
      prefilter: resource(r.prefilterView, r.prefilterSampler),
      brdfLut: resource(r.brdfLutView, r.irradianceSampler),
      intensityBufferIdentity: id(r.intensityBuffer),
    },
    errors: [],
  };
}

it('retains actual IBL binding facts across hits and detached frame receipts', () => {
  const f = fixture();
  f.deps.frameState.iblBindingInspection = iblReceipt(f.deps, 1);
  const group = f.draw();
  const cold = f.deps.frameState.iblBindingInspection,
    entries = cold.material?.entries;
  expect(cold.material?.cache).toBe('miss');
  expect(entries).toHaveLength(6);
  expect(f.draw()).toBe(group);
  const first = f.deps.frameState.iblBindingInspection;
  expect(first.material?.cache).toBe('hit');
  expect(first.material?.entries).toEqual(entries);
  expect(first.material?.entries).not.toBe(entries);
  const resource = first.material?.entries[0]?.resourceIdentity;
  Object.assign(entries?.[0] ?? {}, { resourceIdentity: -1 });
  expect(first.material?.entries[0]?.resourceIdentity).toBe(resource);
  f.deps.frameState.iblBindingInspection = iblReceipt(f.deps, 2);
  expect(f.draw()).toBe(group);
  const second = f.deps.frameState.iblBindingInspection;
  expect(second.material).toBe(first.material);
  expect(second.frameId).toBe(2);
  expect(cold.frameId).toBe(1);
  expect(cold.material?.cache).toBe('miss');
  expect(Object.isFrozen(second.material)).toBe(true);
  expect(Object.isFrozen(second.material?.entries)).toBe(true);
  expect(Object.isFrozen(second.material?.entries[0])).toBe(true);
  expect(f.draw()).toBe(group);
  expect(f.deps.frameState.iblBindingInspection).toBe(second);
});

it('records the physical draw without a legacy Standard material IBL receipt', () => {
  const f = fixture();
  Object.assign(f.deps.pipelineState, { defaultNormalTextureView: {}, fallbackTextureView: {} });
  f.material.materialShaderId = 'forgeax::default-standard-pbr';
  const frame = f.deps.frameState;
  frame.iblBindingInspection = iblReceipt(f.deps, 7);
  const group = f.draw();
  const pipeline = {};
  const draw = () =>
    recordIblPipelineBinding(
      f.deps as unknown as Parameters<typeof recordIblPipelineBinding>[0],
      f.material,
      pipeline as Parameters<typeof recordIblPipelineBinding>[2],
      group,
    );
  expect(frame.iblBindingInspection?.material).toBeUndefined();
  draw();
  const valid = frame.iblBindingInspection;
  expect(valid.errors).toEqual([]);
  expect(valid.pipeline).toMatchObject({
    pipelineIdentity: getOpaqueResourceIdentity(pipeline),
    materialBglIdentity: getOpaqueResourceIdentity(f.layout),
    bindGroupIdentity: getOpaqueResourceIdentity(group),
  });
  draw();
  expect(frame.iblBindingInspection).toBe(valid);
});

it('keeps current IBL errors observable and replaces proofs with changed bindings', () => {
  const f = fixture();
  const oldGroup = f.draw(); // No inspection was requested at first assembly.
  f.deps.frameState.iblBindingInspection = iblReceipt(f.deps, 3);
  expect(f.draw()).toBe(oldGroup);
  const original = f.deps.frameState.iblBindingInspection;
  f.deps.frameState.iblBindingInspection = {
    ...original,
    status: 'binding-chain-mismatch',
    errors: ['material-bind-group-identity-mismatch'],
  };
  f.draw();
  expect(f.deps.frameState.iblBindingInspection.errors).toEqual([]);
  expect(f.deps.frameState.iblBindingInspection.status).toBe('binding-chain-mismatch');
  const next = {
    ...f.deps,
    skylightResources: {
      ...f.deps.skylightResources,
      prefilterView: {} as import('@forgeax/engine-rhi').TextureView,
    },
  };
  next.frameState.iblBindingInspection = iblReceipt(next, 4);
  const newGroup = buildPerSubmeshMaterialBg(next, f.material, 1);
  expect(newGroup).not.toBe(oldGroup);
  const changed = next.frameState.iblBindingInspection;
  expect(changed.material?.entries).not.toEqual(original.material?.entries);
  expect(original.frameId).toBe(3);
  buildPerSubmeshMaterialBg(next, f.material, 1);
  const hit = next.frameState.iblBindingInspection;
  expect(hit.material?.entries).toEqual(changed.material?.entries);
  expect(hit.material?.cache).toBe('hit');
});
