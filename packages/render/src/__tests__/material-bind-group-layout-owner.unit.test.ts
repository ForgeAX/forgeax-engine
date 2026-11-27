import { DynamicTextureStore } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type {
  BindGroup,
  BindGroupEntry,
  BindGroupLayout,
  Buffer,
  Sampler,
  TextureView,
} from '@forgeax/engine-rhi';
import { ok, ParamSchemaProjectionOwner } from '@forgeax/engine-types';
import { assert, describe, expect, it, vi } from 'vitest';
import { MaterialResource } from '../material-resource';
import type { IblBindingInspection } from '../mesh-material-bindings';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import { IblBindingObservation } from '../record/ibl-binding-observation';
import { recordIblPipelineBinding } from '../record/main-pass-geometry';
import {
  buildPerSubmeshMaterialBg,
  type PerSubmeshMaterialBgDeps,
} from '../record/main-pass-material';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
import { MATERIAL_PER_ENTITY_STRIDE } from '../record/render-context';
import { defaultMaterialSnapshot, type MaterialSnapshot } from '../render-system-extract';
import { MaterialFrame } from '../scene/material-dispatch';
import { CanvasTexture } from '../textures/canvas-texture';

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

  it('binds the layout of the selected raster PSO across live layout changes', () => {
    const f = fixture();
    const originalLayout = f.layout;
    const selected = {
      shader: f.material.materialShaderId,
      schema: [],
      layout: originalLayout,
      index: 0,
      perShaderLayout: originalLayout,
      lit: false,
    };
    f.replaceLayout();
    const query = vi.spyOn(f.deps.runtime, 'getMaterialBindGroupLayout');
    const draw = (layout: typeof selected) =>
      buildPerSubmeshMaterialBg(
        f.deps,
        f.material,
        1,
        f.deps.world,
        f.material.materialShaderId,
        0,
        undefined,
        0,
        undefined,
        undefined,
        layout,
      );
    const first = draw(selected);
    expect(draw(selected)).toBe(first);
    expect(query).not.toHaveBeenCalled();
    expect(f.layouts).toEqual([originalLayout]);
    expect(draw({ ...selected, shader: 'game::another' })).not.toBe(first);
    expect(query).toHaveBeenCalledOnce();
    expect(f.layouts).toEqual([originalLayout, f.layout]);
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

it('tracks only fields offered by the texture provider and rebinds a changed field domain', () => {
  const f = fixture();
  let current:
    | {
        textureView: TextureView;
        sampler: Sampler;
      }
    | undefined;
  const unrelated = Object.assign(
    vi.fn(() => undefined),
    { parameters: new Set(['other']) },
  );
  Object.assign(f.deps.runtime, {
    getParamSchema: () => [{ name: 'field', type: 'texture2d' }],
    preparedMaterialTexture: unrelated,
  });
  const neutral = f.draw();
  expect(f.draw()).toBe(neutral);
  expect(unrelated).not.toHaveBeenCalled();
  const offered = Object.assign(
    vi.fn(() => current),
    { parameters: new Set(['field']) },
  );
  Object.assign(f.deps.runtime, { preparedMaterialTexture: offered });
  f.draw();
  expect(offered).toHaveBeenCalled();
  current = {
    textureView: {} as TextureView,
    sampler: {} as Sampler,
  };
  const installed = f.draw();
  expect(installed).not.toBe(neutral);
  expect(
    (installed as unknown as { entries: BindGroupEntry[] }).entries.find((e) => e.binding === 2)
      ?.resource,
  ).toEqual({ kind: 'textureView', value: current.textureView });
  expect(f.draw()).toBe(installed);
  current = undefined;
  expect(f.draw()).not.toBe(installed);
});

it('binds prepared material views and observes appearance, replacement and removal in the same cache', () => {
  const f = fixture();
  let prepared:
    | {
        textureView: TextureView;
        sampler: Sampler;
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
    textureView: {} as TextureView,
    sampler: {} as Sampler,
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
  prepared = { ...prepared, textureView: {} as TextureView };
  const second = f.draw();
  expect(second).not.toBe(first);
  expect(f.draw()).toBe(second);
  prepared = undefined;
  expect(f.draw()).toBe(original);
});

it('visits live Canvas pixels across edits and retires the issued material at removal', () => {
  const f = fixture();
  const { schema } = new ParamSchemaProjectionOwner().admit({
    ownerId: 'canvas-material',
    revision: 1,
    schema: [{ name: 'field', type: 'texture2d' }],
  });
  const canvas = { width: 8, height: 8 } as OffscreenCanvas;
  const texture = new CanvasTexture(canvas);
  const store = new DynamicTextureStore();
  const copy = vi.fn(() => ok(undefined));
  const destroyed = vi.fn(() => ok(undefined));
  store.configureGpuDevice({
    createTexture: () => ok({} as import('@forgeax/engine-rhi').Texture),
    createTextureView: () => ok({} as TextureView),
    destroyTexture: destroyed,
    queue: { copyExternalImageToTexture: copy },
  });
  Object.assign(f.deps.runtime, { getParamSchema: () => schema, dynamicTextureStore: store });
  Object.assign(f.material, {
    textureSources: new Map([['field', structuredClone(texture.source)]]),
  });
  const owner = MaterialResource.from(f.material);
  const frame = new MaterialFrame(undefined).with(owner);
  const bindings = f.deps.materialBgAssemblyCache;
  bindings.adoptMaterials(frame);
  const assembled = vi.spyOn(bindings, 'issue');
  try {
    const capture: { current: (() => boolean) | undefined } = { current: () => true };
    const address = { byteOffset: 0, dynamicOffsetCount: 1 as const, capture };
    const first = buildPerSubmeshMaterialBg(
      f.deps,
      f.material,
      1,
      f.deps.world,
      f.material.materialShaderId,
      0,
      undefined,
      0,
      undefined,
      address,
    );
    expect(capture.current).toBeUndefined();
    for (let draw = 0; draw < 32; draw++) {
      texture.update();
      expect(f.draw()).toBe(first);
    }
    expect(copy).toHaveBeenCalledTimes(33);
    expect(assembled).toHaveBeenCalledTimes(1);
    canvas.width = 16;
    texture.update();
    const resized = f.draw();
    expect(resized).not.toBe(first);
    expect(assembled).toHaveBeenCalledTimes(2);
    expect(copy).toHaveBeenCalledTimes(34);
    expect(destroyed).toHaveBeenCalledTimes(1);
    expect(f.draw()).toBe(resized);
    expect(copy).toHaveBeenCalledTimes(34);
    expect([...bindings.values()]).toHaveLength(1);
    bindings.adoptMaterials(frame.without(owner));
    expect([...bindings.values()]).toHaveLength(0);
    bindings.adoptMaterials(frame);
    expect(f.draw()).toBe(resized);
    texture.dispose();
    expect(f.draw()).not.toBe(resized);
    expect([...bindings.values()]).toHaveLength(0);
    expect(destroyed).toHaveBeenCalledTimes(2);
  } finally {
    texture.dispose();
    store.destroyAll();
  }
});

it('matches binding number, kind, offset and size under the same physical layout', () => {
  const f = fixture();
  const resource = {} as Buffer;
  const bind = (entries: BindGroupEntry[]) =>
    f.deps.materialBgAssemblyCache.issue(
      f.deps.runtime,
      f.layout,
      entries,
      false,
      f.deps.bindGroupCounts,
    );
  const buffer = (binding: number, offset?: number, size?: number): BindGroupEntry => ({
    binding,
    resource: {
      kind: 'buffer',
      value: {
        buffer: resource,
        ...(offset === undefined ? {} : { offset }),
        ...(size === undefined ? {} : { size }),
      },
    },
  });
  const first = bind([buffer(0)]);
  expect(bind([buffer(0, 0)])).toBe(first);
  const zero = bind([buffer(0, 0, 0)]);
  expect(zero).not.toBe(first);
  const ranged = bind([buffer(0, 2 ** 32, 0)]);
  expect(ranged).not.toBe(zero);
  const renumbered = bind([buffer(1, 2 ** 32, 0)]);
  expect(renumbered).not.toBe(ranged);
  const sampler = {
    kind: 'sampler' as const,
    value: resource as unknown as Sampler,
  };
  const sampled = bind([{ binding: 1, resource: sampler }]);
  expect(sampled).not.toBe(renumbered);
  expect(bind([{ binding: 1, resource: sampler }])).toBe(sampled);
  expect(f.deps.bindGroupCounts.createBindGroup).toBe(5);
  const range = { buffer: resource, offset: 4, size: 32 };
  const mutable = [{ binding: 0, resource: { kind: 'buffer' as const, value: range } }];
  const previous = bind(mutable);
  range.offset = 36;
  expect(bind(mutable)).not.toBe(previous);
});

it('releases historical combinations while all input resources remain live', () => {
  const f = fixture();
  const bindings = f.deps.materialBgAssemblyCache;
  const groups = Array.from({ length: 64 }, () => ({}) as Buffer);
  const issue = (buffer: Buffer) =>
    bindings.issue(
      f.deps.runtime,
      f.layout,
      [{ binding: 0, resource: { kind: 'buffer', value: { buffer } } }],
      false,
      f.deps.bindGroupCounts,
    );
  const first = groups.map(issue);
  bindings.finishRecording();
  bindings.use(first[0] as BindGroup);
  bindings.finishRecording();
  expect(issue(groups[0] as Buffer)).toBe(first[0]);
  for (let index = 1; index < groups.length; index++)
    expect(issue(groups[index] as Buffer)).not.toBe(first[index]);
  expect(f.deps.bindGroupCounts.createBindGroup).toBe(127);
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
  f.deps.frameState.iblBindings = new IblBindingObservation(iblReceipt(f.deps, 1));
  const group = f.draw();
  const cold = f.deps.frameState.iblBindings.inspect(),
    entries = cold.material?.entries;
  expect(cold.material?.cache).toBe('miss');
  expect(entries).toHaveLength(6);
  expect(f.draw()).toBe(group);
  const first = f.deps.frameState.iblBindings.inspect();
  expect(first.material?.cache).toBe('hit');
  expect(first.material?.entries).toEqual(entries);
  expect(first.material?.entries).not.toBe(entries);
  const resource = first.material?.entries[0]?.resourceIdentity;
  Object.assign(entries?.[0] ?? {}, { resourceIdentity: -1 });
  expect(first.material?.entries[0]?.resourceIdentity).toBe(resource);
  f.deps.frameState.iblBindings = new IblBindingObservation(iblReceipt(f.deps, 2));
  expect(f.draw()).toBe(group);
  const second = f.deps.frameState.iblBindings.inspect();
  expect(second.material).toBe(first.material);
  expect(second.frameId).toBe(2);
  expect(cold.frameId).toBe(1);
  expect(cold.material?.cache).toBe('miss');
  expect(Object.isFrozen(second.material)).toBe(true);
  expect(Object.isFrozen(second.material?.entries)).toBe(true);
  expect(Object.isFrozen(second.material?.entries[0])).toBe(true);
  expect(f.draw()).toBe(group);
  expect(f.deps.frameState.iblBindings.inspect()).toBe(second);
});

it('captures each installed physical IBL layout once across alternating draws', () => {
  const f = fixture();
  f.draw();
  const [installed] = f.deps.materialBgAssemblyCache.values();
  assert(installed);
  const observation = new IblBindingObservation(iblReceipt(f.deps, 8));
  const reads = vi.fn(() => installed.descriptor.entries);
  const withProbe = {
    ...installed,
    descriptor: {
      ...installed.descriptor,
      get entries() {
        return reads();
      },
    },
  };
  const noProbeReads = vi.fn(() => []);
  const withoutProbe = {
    ...installed,
    descriptor: {
      ...installed.descriptor,
      get entries() {
        return noProbeReads();
      },
    },
  };
  for (let i = 0; i < 12; i++) {
    observation.bindRetained(withProbe);
    observation.bindRetained(withoutProbe);
  }
  expect(reads).toHaveBeenCalledOnce();
  expect(noProbeReads).toHaveBeenCalledOnce();
  expect(observation.inspect().material?.bindGroupIdentity).toBe(
    getOpaqueResourceIdentity(installed.bindGroup),
  );
});

it('records the physical draw without a legacy Standard material IBL receipt', () => {
  const f = fixture();
  Object.assign(f.deps.pipelineState, { defaultNormalTextureView: {}, fallbackTextureView: {} });
  f.material.materialShaderId = 'forgeax::default-standard-pbr';
  const frame = f.deps.frameState;
  frame.iblBindings = new IblBindingObservation(iblReceipt(f.deps, 7));
  const group = f.draw();
  const pipeline = {};
  const draw = () =>
    recordIblPipelineBinding(
      f.deps as unknown as Parameters<typeof recordIblPipelineBinding>[0],
      f.material,
      pipeline as Parameters<typeof recordIblPipelineBinding>[2],
      group,
    );
  expect(frame.iblBindings.inspect()?.material).toBeUndefined();
  draw();
  const valid = frame.iblBindings.inspect();
  expect(valid.errors).toEqual([]);
  expect(valid.pipeline).toMatchObject({
    pipelineIdentity: getOpaqueResourceIdentity(pipeline),
    materialBglIdentity: getOpaqueResourceIdentity(f.layout),
    bindGroupIdentity: getOpaqueResourceIdentity(group),
  });
  draw();
  expect(frame.iblBindings.inspect()).toBe(valid);
  const selected = {
    shader: 'forgeax::default-standard-pbr',
    schema: [],
    perShaderLayout: f.layout,
    layout: f.layout,
    index: 0,
    lit: true,
  };
  f.replaceLayout();
  const query = vi.spyOn(f.deps.runtime, 'getMaterialBindGroupLayout');
  recordIblPipelineBinding(
    f.deps as unknown as Parameters<typeof recordIblPipelineBinding>[0],
    f.material,
    pipeline as Parameters<typeof recordIblPipelineBinding>[2],
    group,
    selected.index,
    selected,
  );
  expect(query).not.toHaveBeenCalled();
  expect(frame.iblBindings.inspect()).toBe(valid);
});

it('keeps current IBL errors observable and replaces proofs with changed bindings', () => {
  const f = fixture();
  const oldGroup = f.draw(); // No inspection was requested at first assembly.
  f.deps.frameState.iblBindings = new IblBindingObservation(iblReceipt(f.deps, 3));
  expect(f.draw()).toBe(oldGroup);
  const original = f.deps.frameState.iblBindings.inspect();
  f.deps.frameState.iblBindings = new IblBindingObservation({
    ...original,
    status: 'binding-chain-mismatch',
    errors: ['material-bind-group-identity-mismatch'],
  });
  f.draw();
  expect(f.deps.frameState.iblBindings.inspect().errors).toEqual([]);
  expect(f.deps.frameState.iblBindings.inspect().status).toBe('binding-chain-mismatch');
  const next = {
    ...f.deps,
    skylightResources: {
      ...f.deps.skylightResources,
      prefilterView: {} as TextureView,
    },
  };
  next.frameState.iblBindings = new IblBindingObservation(iblReceipt(next, 4));
  const newGroup = buildPerSubmeshMaterialBg(next, f.material, 1);
  expect(newGroup).not.toBe(oldGroup);
  const changed = next.frameState.iblBindings.inspect();
  expect(changed.material?.entries).not.toEqual(original.material?.entries);
  expect(original.frameId).toBe(3);
  buildPerSubmeshMaterialBg(next, f.material, 1);
  const hit = next.frameState.iblBindings.inspect();
  expect(hit.material?.entries).toEqual(changed.material?.entries);
  expect(hit.material?.cache).toBe('hit');
});

it('keeps issued material and draw snapshots stable across changing groups in the same pass', () => {
  const f = fixture();
  const obs = new IblBindingObservation(iblReceipt(f.deps, 3));
  f.deps.frameState.iblBindings = obs;
  const draw = (pipeline: number) => {
    const group = f.draw();
    obs.draw(
      pipeline,
      getOpaqueResourceIdentity(f.layout),
      getOpaqueResourceIdentity(group),
      'forgeax::default-standard-pbr',
      undefined,
      3,
    );
    return group;
  };
  const firstGroup = draw(1);
  const first = obs.inspect();
  f.replaceLayout();
  draw(2);
  f.replaceLayout();
  const lastGroup = draw(3);
  const last = obs.inspect();
  expect(last.pipeline?.pipelineIdentity).toBe(3);
  expect(last.material?.bindGroupIdentity).toBe(getOpaqueResourceIdentity(lastGroup));
  expect(first.material?.bindGroupIdentity).toBe(getOpaqueResourceIdentity(firstGroup));
  expect(first.pipeline?.pipelineIdentity).toBe(1);
  expect(last.material?.entries).not.toBe(first.material?.entries);
  expect(last.errors).toEqual([]);
});
