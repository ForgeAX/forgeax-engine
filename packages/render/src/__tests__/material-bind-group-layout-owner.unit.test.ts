import { World } from '@forgeax/engine-ecs';
import type { BindGroup, BindGroupEntry, BindGroupLayout, Buffer } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import {
  buildPerSubmeshMaterialBg,
  type PerSubmeshMaterialBgDeps,
} from '../record/main-pass-material';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
import { MATERIAL_PER_ENTITY_STRIDE } from '../record/render-context';
import type { MaterialSnapshot } from '../render-system-extract';

function fixture() {
  const resource = () => ({});
  const layouts: object[] = [];
  let layout = resource();
  let failure: Error | undefined;
  const deps = {
    runtime: {
      device: {
        caps: { storageBuffer: false },
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
      irradianceView: resource(),
      irradianceSampler: resource(),
      prefilterView: resource(),
      skylightPrefilterView: resource(),
      prefilterSampler: resource(),
      brdfLutView: resource(),
      intensityBuffer: resource(),
    },
    materialBgShared: new Map(),
    materialBgAssemblyCache: new MaterialBgAssemblyCache(),
    bindGroupCounts: { createBindGroup: 0, keys: [] },
    frameState: {},
  } as unknown as PerSubmeshMaterialBgDeps;
  const material = { materialHandle: 1, materialShaderId: 'game::replaceable' } as MaterialSnapshot;
  const draw = (): BindGroup => buildPerSubmeshMaterialBg(deps, { ...material }, 1);
  return {
    deps,
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
  const material = { materialHandle: 1, materialShaderId: 'game::replaceable' } as MaterialSnapshot;
  const draw = (slot: number) =>
    buildPerSubmeshMaterialBg(f.deps, material, 1, f.deps.world, material.materialShaderId, slot);
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
