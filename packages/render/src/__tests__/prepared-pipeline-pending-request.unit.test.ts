import type {
  RenderPipeline,
  RenderPipelineDescriptor,
  Result,
  RhiDevice,
  RhiError,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  MaterialPipelineRequestCache,
  PendingMaterialPipelineRequest,
  requestMaterialPipeline,
} from '../assembly/material/pipeline-request-cache';
import { PreparedRenderPipelineOwner } from '../assembly/material/prepared-pipeline-owner';

function asyncDevice() {
  const resolves: ((result: Result<RenderPipeline, RhiError>) => void)[] = [];
  const device = {
    createRenderPipeline: () => {
      throw new Error('prepared requests compile asynchronously');
    },
    createRenderPipelineAsync: () =>
      new Promise<Result<RenderPipeline, RhiError>>((resolve) => resolves.push(resolve)),
  } as unknown as RhiDevice;
  return { device, resolves };
}

const descriptor = { layout: {} } as unknown as RenderPipelineDescriptor;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('pending prepared material requests', () => {
  it('advances the owner only when a flight publishes its result', async () => {
    const { device, resolves } = asyncDevice();
    let alive = true;
    const owner = new PreparedRenderPipelineOwner(device, () => alive);
    const first = owner.request('a', 'source', descriptor);
    expect(owner.isPending(first)).toBe(true);
    expect(owner.settled).toBe(0);
    expect(owner.pendingAnswers).toBe(1);
    expect(owner.isPending(owner.request('a', 'source', descriptor))).toBe(true);
    expect(owner.pendingAnswers).toBe(2);
    expect(resolves).toHaveLength(1);
    const pipeline = {} as RenderPipeline;
    resolves[0]?.(ok(pipeline));
    await settle();
    expect(owner.settled).toBe(1);
    const done = owner.request('a', 'source', descriptor);
    expect(done.ok && done.value).toBe(pipeline);
    owner.request('b', 'source', descriptor);
    alive = false;
    expect(owner.isPending(owner.request('b', 'source', descriptor))).toBe(true);
    // Dropping every flight lets pending answers rebuild against the new owner state.
    expect(owner.settled).toBe(2);
    resolves[1]?.(ok({} as RenderPipeline));
    await settle();
    expect(owner.settled).toBe(2);
  });

  it('answers pending until any flight of its owner settles', () => {
    const owner = { settled: 3 };
    const pending = new PendingMaterialPipelineRequest(owner);
    expect(pending.current).toBe(true);
    owner.settled++;
    expect(pending.current).toBe(false);
  });

  it('replaces the value of identical request facts instead of shadowing it', () => {
    const cache = new MaterialPipelineRequestCache<object>(4);
    const facts = ['shader', 1, undefined];
    const pending = {};
    const pipeline = {};
    cache.set(facts, pending);
    cache.set(['shader', 1, undefined], pipeline);
    expect(cache.get(facts)).toBe(pipeline);
    // Replacements do not consume capacity.
    for (let index = 0; index < 3; index++) cache.set(facts, {});
    cache.set(['other', 1, undefined], pipeline);
    cache.set(['other', 2, undefined], pipeline);
    cache.set(['other', 3, undefined], pipeline);
    expect(cache.get(facts)).toBeDefined();
  });

  it('skips builds answered pending until the owner settles, and keeps plain misses retryable', () => {
    const owner = { settled: 0, pendingAnswers: 0 };
    const requests = new MaterialPipelineRequestCache<object | PendingMaterialPipelineRequest>(8);
    const pipeline = {};
    let builds = 0;
    let answer: 'pending' | 'missing' | 'ready' = 'pending';
    const build = () => {
      builds++;
      if (answer === 'pending') owner.pendingAnswers++;
      return answer === 'ready' ? pipeline : null;
    };
    const request = (facts: Parameters<typeof requestMaterialPipeline>[1], lookupOnly = false) =>
      requestMaterialPipeline(requests, facts, lookupOnly, build, () => owner);
    expect(request(['a'])).toBeNull();
    expect(request(['a'])).toBeNull();
    expect(builds).toBe(1);
    owner.settled++;
    expect(request(['a'], true)).toBeNull();
    expect(builds).toBe(1);
    answer = 'ready';
    expect(request(['a'])).toBe(pipeline);
    expect(request(['a'])).toBe(pipeline);
    expect(builds).toBe(2);
    // A null build without a pending answer (missing input) is retried every time.
    answer = 'missing';
    expect(request(['b'])).toBeNull();
    expect(request(['b'])).toBeNull();
    expect(builds).toBe(4);
  });
});
