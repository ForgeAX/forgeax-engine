import { describe, expect, it } from 'vitest';
import { createMaterialLayoutCache } from '../assembly/material/layout-cache';
import {
  MaterialPipelineRequestCache,
  materialPipelineRequestFacts,
} from '../assembly/material/pipeline-request-cache';
import { materialPipelineAttachments } from '../assembly/material-shader-policy';
import type { RendererPipelineCacheState } from '../assembly/recovery/renderer-recover';

describe('material pipeline requests', () => {
  it('compares complete facts when request types and lengths differ', () => {
    const cache = new MaterialPipelineRequestCache<object>();
    const a = {},
      b = {};
    cache.set(['shader', 1, undefined], a);
    cache.set(['shader', null, undefined], b);
    expect(cache.get(['shader', 1, undefined])).toBe(a);
    expect(cache.get(['shader', null, undefined])).toBe(b);
    expect(cache.get(['shader', 1.5, undefined])).toBeUndefined();
    expect(cache.get(['shader', true, undefined])).toBeUndefined();
    expect(cache.get(['shader', 1, null])).toBeUndefined();
    expect(cache.get(['shader', 1, undefined, 'extra'])).toBeUndefined();
  });
  it('updates exact leaves at capacity and preserves signed zero, NaN and trailing fields', () => {
    const requests = new MaterialPipelineRequestCache<number>(5);
    const rows = [[0], [-0], [NaN], [undefined], []];
    for (const [index, row] of rows.entries()) requests.set(row, index);
    requests.set([-0], 17);
    expect(rows.map((row) => requests.get(row))).toEqual([0, 17, 2, 3, 4]);
    requests.set([undefined, undefined], 5);
    expect(rows.map((row) => requests.get(row))).toEqual(Array(5).fill(undefined));
    expect(requests.get([undefined, undefined])).toBe(5);
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
      program: { identity: 'admitted-source-identity' },
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
    expect(sourceReads).toBe(0); // Layouts keep admitted identity, including the first cold selection.
    state = {
      preparedMaterialPipelineLayoutCache: new Map(),
      perShaderMaterialLayoutCache: new Map(),
    } as unknown as RendererPipelineCacheState;
    expect(cache.getOrBuildPreparedMaterialPipelineLayout('forgeax::default-unlit')).not.toBe(
      first,
    );
    expect(builds).toBe(2);
    expect(sourceReads).toBe(0);
  });
  it('shares list pipeline requests across index widths and distinguishes strip restart widths', () => {
    const args = ['shader', true] as Parameters<typeof materialPipelineRequestFacts>[0];
    for (const topology of [
      'triangle-list',
      'line-list',
      'point-list',
      'triangle-strip',
      'line-strip',
    ] as const) {
      args[3] = topology;
      args[4] = 'uint16';
      const first = materialPipelineRequestFacts(args);
      args[4] = 'uint32';
      const second = materialPipelineRequestFacts(args);
      if (topology.endsWith('strip')) expect(second).not.toEqual(first);
      else expect(second).toEqual(first);
    }
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
  it('distinguishes default color, explicit no color and explicit no depth requests', () => {
    const cache = new MaterialPipelineRequestCache<object>();
    const args = ['shader', false] as Parameters<typeof materialPipelineRequestFacts>[0];
    const ordinary = {},
      colorless = {},
      depthless = {};
    cache.set(materialPipelineRequestFacts(args), ordinary);
    args[9] = null;
    expect(cache.get(materialPipelineRequestFacts(args))).toBeUndefined();
    cache.set(materialPipelineRequestFacts(args), colorless);
    args[9] = undefined;
    args[11] = null;
    expect(cache.get(materialPipelineRequestFacts(args))).toBeUndefined();
    cache.set(materialPipelineRequestFacts(args), depthless);
    args[11] = undefined;
    expect(cache.get(materialPipelineRequestFacts(args))).toBe(ordinary);
    args[9] = null;
    expect(cache.get(materialPipelineRequestFacts(args))).toBe(colorless);
    args[9] = undefined;
    args[11] = null;
    expect(cache.get(materialPipelineRequestFacts(args))).toBe(depthless);
    expect(
      materialPipelineAttachments('forward', 'bgra8unorm-srgb', undefined, undefined, 1),
    ).toMatchObject({ colorFormats: ['bgra8unorm-srgb'], depthFormat: 'depth32float-stencil8' });
    expect(
      materialPipelineAttachments('shadow-caster', null, [], 'depth32float-stencil8', 1),
    ).toMatchObject({ colorFormats: [], depthFormat: 'depth32float-stencil8' });
    expect(materialPipelineAttachments('forward', 'rgba16float', [], null, 1)).toMatchObject({
      colorFormats: ['rgba16float'],
      depthFormat: undefined,
    });
    expect(materialPipelineAttachments('shadow-caster', null, [], null, 1)).toMatchObject({
      colorFormats: [],
      depthFormat: undefined,
    });
  });
  it('compares generation and artifact owners at the tail of a request', () => {
    const cache = new MaterialPipelineRequestCache<object>();
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
