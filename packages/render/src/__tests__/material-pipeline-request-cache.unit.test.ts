import { describe, expect, it } from 'vitest';
import { createMaterialLayoutCache } from '../assembly/material/layout-cache';
import {
  MaterialPipelineRequestCache,
  materialPipelineRequestFacts,
} from '../assembly/material/pipeline-request-cache';
import type { RendererPipelineCacheState } from '../assembly/recovery/renderer-recover';

describe('material pipeline requests', () => {
  it('compares complete facts after numeric hash collisions', () => {
    const cache = new MaterialPipelineRequestCache<object>();
    const a = {},
      b = {};
    // Null and one deliberately share a hash; equality must retain value types.
    cache.set(['shader', 1, undefined], a);
    cache.set(['shader', null, undefined], b);
    expect(cache.get(['shader', 1, undefined])).toBe(a);
    expect(cache.get(['shader', null, undefined])).toBe(b);
    expect(cache.get(['shader', 1.5, undefined])).toBeUndefined();
    expect(cache.get(['shader', true, undefined])).toBeUndefined();
    expect(cache.get(['shader', 1, null])).toBeUndefined();
    expect(cache.get(['shader', 1, undefined, 'extra'])).toBeUndefined();
  });
  it('retains high-variant rotation and bounds one-off requests', () => {
    const cache = new MaterialPipelineRequestCache<number>(64);
    const owner = {};
    for (let index = 0; index < 32; index++) cache.set([owner, index, 'forward'], index);
    for (let round = 0; round < 4; round++)
      for (let index = 0; index < 32; index++)
        expect(cache.get([owner, index, 'forward'])).toBe(index);
    expect(cache.hits).toBe(128);
    expect(cache.get([{}, 0, 'forward'])).toBeUndefined();
    for (let index = 32; index <= 64; index++) cache.set([owner, index, 'forward'], index);
    expect(cache.get([owner, 0, 'forward'])).toBeUndefined();
    expect(cache.get([owner, 64, 'forward'])).toBe(64);
  });
  it('retains prepared layouts by artifact and generation before parsing their source', () => {
    let sourceReads = 0;
    const artifact = {
      get source() {
        sourceReads++;
        return '';
      },
    };
    let state = {
      preparedMaterialPipelineLayoutCache: new Map(),
      perShaderMaterialLayoutCache: new Map(),
    } as unknown as RendererPipelineCacheState;
    let builds = 0;
    const pipelineState = { viewBindGroupLayout: {}, materialBindGroupLayout: {} };
    const device = {
      createPipelineLayout: () => {
        builds++;
        return { ok: true, value: {} };
      },
    };
    const cache = createMaterialLayoutCache({
      currentPipelineCacheState: () => state,
      currentPipelineState: () => pipelineState,
      currentBuildDevice: () => device,
      getShader: () => ({ findMaterialArtifact: () => ({ ok: true, value: artifact }) }),
      viewAndSceneDepthLayoutEntries: () => [],
      reportError: () => {},
    } as unknown as Parameters<typeof createMaterialLayoutCache>[0]);
    const first = cache.getOrBuildPreparedMaterialPipelineLayout('forgeax::default-unlit');
    expect(cache.getOrBuildPreparedMaterialPipelineLayout('forgeax::default-unlit')).toBe(first);
    expect(builds).toBe(1);
    expect(sourceReads).toBe(2); // Cold prepared and material layout reads only.
    state = {
      preparedMaterialPipelineLayoutCache: new Map(),
      perShaderMaterialLayoutCache: new Map(),
    } as unknown as RendererPipelineCacheState;
    expect(cache.getOrBuildPreparedMaterialPipelineLayout('forgeax::default-unlit')).not.toBe(
      first,
    );
    expect(builds).toBe(2);
  });
  it('normalizes freshly allocated constants and attachment arrays without hiding value edits', () => {
    const cache = new MaterialPipelineRequestCache<object>();
    const args = ['shader', true] as Parameters<typeof materialPipelineRequestFacts>[0];
    args[17] = ['rgba16float', 'rgba8unorm'];
    args[21] = { '64000': 7, '64001': 3 };
    const pipeline = {};
    cache.set(materialPipelineRequestFacts(args), pipeline);
    args[17] = ['rgba16float', 'rgba8unorm'];
    const constants = { '64001': 3, '64000': 7 };
    args[21] = constants;
    expect(cache.get(materialPipelineRequestFacts(args))).toBe(pipeline);
    constants['64000'] = 0;
    expect(cache.get(materialPipelineRequestFacts(args))).toBeUndefined();
    constants['64000'] = 7;
    args[17] = ['rgba16float', 'r32float'];
    expect(cache.get(materialPipelineRequestFacts(args))).toBeUndefined();
    args[17] = ['rgba16float', 'rgba8unorm'];
    args[8] = 4;
    expect(cache.get(materialPipelineRequestFacts(args))).toBeUndefined();
    args[8] = undefined;
    args[11] = null;
    expect(cache.get(materialPipelineRequestFacts(args))).toBeUndefined();
  });
  it('compares generation and artifact owners even when they are omitted from bucket hashing', () => {
    const cache = new MaterialPipelineRequestCache<object>(512, 2);
    const shader = {},
      device = {},
      pipeline = {};
    cache.set(['shader', 0.25, shader, device], pipeline);
    expect(cache.get(['shader', 0.25, shader, device])).toBe(pipeline);
    expect(cache.get(['shader', 0.25, {}, device])).toBeUndefined();
    expect(cache.get(['shader', 0.25, shader, {}])).toBeUndefined();
    expect(cache.get(['shader', 0.75, shader, device])).toBeUndefined();
  });
});
