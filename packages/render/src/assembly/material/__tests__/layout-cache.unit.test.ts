import { ok } from '@forgeax/engine-rhi';
import type { MaterialProgramBindingContract, ParamSchemaEntry } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { RendererPipelineCacheState } from '../../recovery/renderer-recover';
import { createMaterialLayoutCache } from '../layout-cache';

function setup() {
  let source = '';
  let bindings: MaterialProgramBindingContract = 'render-material';
  let schema: readonly ParamSchemaEntry[] | undefined;
  const state = {
    preparedMaterialPipelineLayoutCache: new Map(),
    perShaderMaterialLayoutCache: new Map(),
  } as RendererPipelineCacheState;
  const view = { kind: 'view' },
    material = { kind: 'material' },
    mesh = { kind: 'mesh' },
    instances = { kind: 'instances' };
  const createBindGroupLayout = vi.fn((descriptor) => ok({ descriptor }));
  const createPipelineLayout = vi.fn((descriptor) => ok({ descriptor }));
  const lookup = vi.fn(() =>
    ok({
      source,
      receipt: { bindings },
      paramSchema: schema,
      program: { materialBindings: undefined },
    }),
  );
  const cache = createMaterialLayoutCache({
    currentPipelineCacheState: () => state,
    currentPipelineState: () =>
      ({
        viewBindGroupLayout: view,
        materialBindGroupLayout: material,
        meshBindGroupLayout: mesh,
        instancesBindGroupLayout: instances,
      }) as never,
    currentBuildDevice: () =>
      ({
        createBindGroupLayout,
        createPipelineLayout,
        caps: { storageBuffer: true },
        limits: {},
      }) as never,
    getShader: () =>
      ({
        findMaterialArtifact: lookup,
        materialShaderManifestEntry: () => undefined,
        materialProgram: () => ({ probeBlendRecordRequired: false }),
      }) as never,
    viewAndSceneDepthLayoutEntries: () => [],
    reportError: (error) => {
      throw error;
    },
  });
  return {
    cache,
    state,
    lookup,
    createBindGroupLayout,
    createPipelineLayout,
    view,
    setSource(value: string) {
      source = value;
    },
    setBindings(value: MaterialProgramBindingContract) {
      bindings = value;
    },
    setSchema(value: readonly ParamSchemaEntry[]) {
      schema = value;
    },
  };
}

it('reuses prepared layouts while still observing lookup and invalidates source and generation changes', () => {
  const owner = setup();
  owner.setSource('@group(0) @binding(0) var<uniform> view: View;');
  const first = owner.cache.getOrBuildPreparedMaterialPipelineLayout('game::effect');
  const lookups = owner.lookup.mock.calls.length;
  expect(owner.cache.getOrBuildPreparedMaterialPipelineLayout('game::effect')).toBe(first);
  expect(owner.lookup).toHaveBeenCalledTimes(lookups + 1);
  expect(owner.createPipelineLayout).toHaveBeenCalledTimes(1);
  owner.setSource('@group(0) @binding(0) var depth: texture_depth_2d;');
  owner.setBindings('render-material-with-scene-depth');
  const replacement = owner.cache.getOrBuildPreparedMaterialPipelineLayout('game::effect');
  expect(replacement).not.toBe(first);
  expect(owner.createBindGroupLayout).toHaveBeenCalledTimes(1);
  expect(owner.createPipelineLayout.mock.calls[1]?.[0].bindGroupLayouts[0]).not.toBe(owner.view);
  owner.state.preparedMaterialPipelineLayoutCache.clear();
  expect(owner.cache.getOrBuildPreparedMaterialPipelineLayout('game::effect')).not.toBe(
    replacement,
  );
});

it('selects resource meaning from the receipt even when source names suggest another layout', () => {
  const owner = setup();
  owner.setSource('@group(0) @binding(0) var misleading_depth: texture_depth_2d;');
  owner.cache.getOrBuildPreparedMaterialPipelineLayout('game::effect');
  expect(owner.createPipelineLayout.mock.calls[0]?.[0].bindGroupLayouts[0]).toBe(owner.view);
  owner.setBindings('render-material-and-scene-depth');
  owner.cache.getOrBuildPreparedMaterialPipelineLayout('game::effect');
  expect(owner.createBindGroupLayout.mock.calls[0]?.[0].label).toContain('view-depth');
  expect(owner.createPipelineLayout).toHaveBeenCalledTimes(2);
});

it('separates lighting, geometry and shader axes and reobserves changed parameter schemas', () => {
  const owner = setup();
  owner.setSchema([{ name: 'baseColorTexture', type: 'texture2d' }]);
  const first = owner.cache.getOrBuildPerShaderMaterialLayout(
    'game::effect',
    undefined,
    'pbr',
    false,
  );
  expect(first).not.toBeNull();
  expect(
    owner.cache.getOrBuildPerShaderMaterialLayout('game::effect', undefined, 'pbr', false),
  ).toBe(first);
  expect(
    owner.cache.getOrBuildPerShaderMaterialLayout('game::effect', undefined, 'pbr', true),
  ).not.toBe(first);
  expect(
    owner.cache.getOrBuildPerShaderMaterialLayout('game::effect', undefined, 'unlit-urp', false),
  ).not.toBe(first);
  expect(
    owner.cache.getOrBuildPerShaderMaterialLayout('game::second', undefined, 'pbr', false),
  ).not.toBe(first);
  owner.setSchema([
    { name: 'baseColorTexture', type: 'texture2d' },
    { name: 'gain', type: 'f32' },
  ]);
  expect(
    owner.cache.getOrBuildPerShaderMaterialLayout('game::effect', undefined, 'pbr', false),
  ).not.toBe(first);
});
