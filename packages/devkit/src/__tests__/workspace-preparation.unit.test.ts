import { afterEach, expect, it, vi } from 'vitest';
import { createWorkspacePreparation } from '../workspace-preparation.js';

afterEach(() => vi.useRealTimers());

it('ends the asset clock before scene connection and starts the next task from zero', () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const preparation = createWorkspacePreparation(vi.fn());
  preparation.host('vite-server');
  preparation.observe({ generation: 1, kind: 'stage', stage: 'inventory' });
  vi.advanceTimersByTime(300_000);
  preparation.observe({ generation: 1, kind: 'stage', stage: 'ready' });
  preparation.host('scene-connection');
  expect(preparation.read()).toMatchObject({ stage: 'ready', activeCount: 0 });
  const completed = preparation.read();
  preparation.observe({
    generation: 1,
    kind: 'source',
    source: { phase: 'ready', sourcePath: 'assets/late.pack.ts', completed: 1, total: 1 },
  });
  preparation.shader({ phase: 'ready', sourcePath: '/engine/late.wgsl', completed: 2, total: 2 });
  expect(preparation.read()).toBe(completed);
  const completedAt = preparation.read()?.updatedAt;
  vi.advanceTimersByTime(60_000);
  expect(preparation.read()?.updatedAt).toBe(completedAt);

  preparation.observe({
    generation: 1,
    kind: 'source',
    source: { phase: 'cook', sourcePath: 'assets/changed.pack.ts', completed: 0, total: 1 },
  });
  expect(preparation.read()).toMatchObject({
    stage: 'produce',
    startedAt: Date.now(),
    recent: [],
    activeCount: 1,
  });
  preparation.observe({ generation: 1, kind: 'stage', stage: 'ready' });
  vi.advanceTimersByTime(60_000);
  preparation.shader({
    phase: 'compile',
    sourcePath: '/engine/changed.wgsl',
    completed: 0,
    total: 2,
  });
  expect(preparation.read()).toMatchObject({
    stage: 'shader',
    startedAt: Date.now(),
    recent: [],
    activeCount: 1,
  });
  preparation.close();
});

it('reports Vite and Shader preparation before the first Pack generation', () => {
  vi.useFakeTimers();
  const preparation = createWorkspacePreparation(vi.fn());
  preparation.host('vite-server');
  expect(preparation.read()).toMatchObject({
    generation: 0,
    stage: 'vite',
    operation: 'vite-server',
  });
  const startedAt = preparation.read()?.startedAt;
  vi.advanceTimersByTime(1000);
  preparation.shader({
    phase: 'compile',
    sourcePath: '/engine/default-standard-pbr.wgsl',
    completed: 12,
    total: 128,
  });
  expect(preparation.read()).toMatchObject({
    stage: 'shader',
    active: [
      {
        phase: 'shader',
        source: '/engine/default-standard-pbr.wgsl',
        progress: { completed: 12, total: 128 },
      },
    ],
  });
  preparation.shader({
    phase: 'ready',
    sourcePath: '/engine/default-standard-pbr.wgsl',
    completed: 128,
    total: 128,
  });
  preparation.observe({ generation: 1, kind: 'stage', stage: 'inventory' });
  expect(preparation.read()).toMatchObject({ stage: 'inventory', startedAt, activeCount: 0 });
  preparation.close();
});

it('isolates delayed notification failures', () => {
  vi.useFakeTimers();
  const preparation = createWorkspacePreparation(() => {
    throw new Error('observer failed');
  });
  preparation.observe({
    generation: 1,
    kind: 'source',
    source: {
      phase: 'cook',
      sourcePath: 'assets/a.pack.ts',
      completed: 0,
      total: 1,
    },
  });
  expect(() => vi.runAllTimers()).not.toThrow();
  expect(preparation.read()?.activeCount).toBe(1);
  preparation.close();
});

it('retains concurrent work, bounds snapshots and coalesces source notifications', () => {
  vi.useFakeTimers();
  const changed = vi.fn();
  const preparation = createWorkspacePreparation(changed);
  preparation.observe({ generation: 1, kind: 'stage', stage: 'inventory' });
  for (let index = 0; index < 12; index++)
    preparation.observe({
      generation: 1,
      kind: 'source',
      source: {
        phase: 'cook',
        sourcePath: `assets/${index}.pack.ts`,
        completed: 0,
        total: 12,
      },
    });
  expect(changed).toHaveBeenCalledTimes(1);
  expect(preparation.read()).toMatchObject({ activeCount: 12, active: expect.any(Array) });
  expect(preparation.read()?.active).toHaveLength(8);
  vi.advanceTimersByTime(200);
  expect(changed).toHaveBeenCalledTimes(2);
  preparation.observe({
    generation: 1,
    kind: 'source',
    source: {
      phase: 'ready',
      sourcePath: 'assets/0.pack.ts',
      completed: 1,
      total: 12,
      cache: 'hit',
    },
  });
  preparation.observe({ generation: 1, kind: 'stage', stage: 'ready' });
  expect(changed).toHaveBeenCalledTimes(3);
  expect(preparation.read()).toMatchObject({
    stage: 'ready',
    activeCount: 0,
    recent: [{ source: 'assets/0.pack.ts', cacheHit: true }],
  });
  vi.runAllTimers();
  expect(changed).toHaveBeenCalledTimes(3);
  preparation.close();
});

it('fences older generations and disposed sessions and retains failed work', () => {
  vi.useFakeTimers();
  const changed = vi.fn();
  const preparation = createWorkspacePreparation(changed);
  preparation.observe({ generation: 2, kind: 'stage', stage: 'inventory' });
  preparation.observe({ generation: 1, kind: 'stage', stage: 'ready' });
  expect(preparation.read()?.stage).toBe('inventory');
  preparation.observe({
    generation: 2,
    kind: 'source',
    source: {
      phase: 'cook',
      sourcePath: 'assets/broken.pack.ts',
      completed: 0,
      total: 1,
    },
  });
  preparation.observe({ generation: 2, kind: 'stage', stage: 'failed' });
  expect(preparation.read()).toMatchObject({ stage: 'failed', activeCount: 1 });
  const snapshot = preparation.read();
  preparation.close();
  preparation.observe({ generation: 3, kind: 'stage', stage: 'inventory' });
  vi.runAllTimers();
  expect(preparation.read()).toBe(snapshot);
  expect(changed).toHaveBeenCalledTimes(2);
});
