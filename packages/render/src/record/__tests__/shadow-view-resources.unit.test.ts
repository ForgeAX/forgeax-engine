import type { BindGroup } from '@forgeax/engine-rhi';
import { expect, it } from 'vitest';
import { getOrCreateFromChain } from '../mesh-ssbo';
import type { PipelineState } from '../render-context';
import { ShadowViewResources, shadowViewBindingKeys } from '../shadow-view-resources';

function fixture() {
  const state = {
    viewBindGroupLayout: {},
    viewUniformBuffer: {},
    shadowArrayFallbackTextureView: {},
    shadowAtlasFallbackTextureView: {},
    shadowParamsBuffer: {},
    shadowCasterCascadeBuffer: {},
    defaultWhiteTextureView: {},
    defaultSampler: {},
    pointsLinesViewBuffer: {},
    projectorAvailable: false,
    perPassResources: { shadowSampler: {} },
  };
  return state as unknown as PipelineState & typeof state;
}
it('consumes producer-owned fixed dependencies without observing them on each pass', () => {
  const state = fixture();
  const resources = new ShadowViewResources(state);
  const root = new WeakMap<object, unknown>();
  const binding = shadowViewBindingKeys(state);
  if (binding === undefined) throw new Error('missing keys');
  const group = {} as BindGroup;
  getOrCreateFromChain(root, binding.keys, 'view-0', () => group, { createBindGroup: 0, keys: [] });
  const descriptor = Object.getOwnPropertyDescriptor(state, 'viewBindGroupLayout');
  Object.defineProperty(state, 'viewBindGroupLayout', {
    configurable: true,
    get: () => {
      throw new Error('fixed ABI must be retained by its producer');
    },
  });
  try {
    const leaf = resources.resolve(state, root);
    expect(leaf?.get('view-0')).toBe(group);
    expect(resources.resolve(state, root)).toBe(leaf);
    expect(resources.resolve(state, new WeakMap())).not.toBe(leaf);
  } finally {
    if (descriptor !== undefined) Object.defineProperty(state, 'viewBindGroupLayout', descriptor);
  }
  expect(resources.resolve({ ...state }, root)).toBeUndefined();
});
it('follows physical growth, sampler replacement and recovery without changing held groups', () => {
  const state = fixture();
  const resources = new ShadowViewResources(state);
  const root = new WeakMap<object, unknown>();
  const first = resources.resolve(state, root);
  const points = state.pointsLinesViewBuffer;
  Object.assign(state, { pointsLinesViewBuffer: {} });
  expect(resources.resolve(state, root)).not.toBe(first);
  Object.assign(state, { pointsLinesViewBuffer: points });
  expect(resources.resolve(state, root)).toBe(first);
  const sampler = state.perPassResources.shadowSampler;
  Object.assign(state.perPassResources, { shadowSampler: null });
  expect(resources.resolve(state, root)).toBeUndefined();
  Object.assign(state.perPassResources, { shadowSampler: {} });
  expect(resources.resolve(state, root)).not.toBe(first);
  Object.assign(state.perPassResources, { shadowSampler: sampler });
  expect(resources.resolve(state, root)).toBe(first);
  const recovered = fixture();
  expect(new ShadowViewResources(recovered).resolve(recovered, root)).not.toBe(first);
});
it('keeps raw states live and refuses incomplete extended-lighting admission', () => {
  const state = fixture();
  const first = shadowViewBindingKeys(state);
  Object.assign(state, { viewBindGroupLayout: {} });
  expect(shadowViewBindingKeys(state)?.keys[0]).not.toBe(first?.keys[0]);
  Object.assign(state, { extendedLightingAvailable: true });
  expect(shadowViewBindingKeys(state)).toBeUndefined();
  Object.assign(state, {
    iesProfileTextureView: {},
    cookieTextureView: {},
    cookieMatrixBuffer: {},
    ltcLambertTextureView: {},
    ltcGgxTextureView: {},
  });
  expect(shadowViewBindingKeys(state)).toBeDefined();
});
