import { createProfiler, type RecorderSession } from '@forgeax/engine-profiler';
import { describe, expect, it } from 'vitest';

import { activeRenderProfileSession } from '../../record/profile-session';
import { createRenderWorld, pinRenderProfileSession } from '../../world/render-world';

function start(profiler: ReturnType<typeof createProfiler>) {
  const result = profiler.startCapture({ frameLimit: 2, eventLimit: 16 });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function withPinnedSession<T>(
  world: ReturnType<typeof createRenderWorld>,
  session: RecorderSession | undefined,
  action: () => T,
): T {
  const restore = pinRenderProfileSession(world, session);
  try {
    return action();
  } finally {
    restore();
  }
}

describe('Render profile session pin', () => {
  it('keeps capture A across a checkpoint after A stops and B starts', () => {
    const profiler = createProfiler({ phaseCatalog: { app: [], render: ['record'] } });
    const world = createRenderWorld();
    const owner = { profiler, renderWorld: world };
    const sessionA = start(profiler);
    function* preparation() {
      yield activeRenderProfileSession(owner);
      return activeRenderProfileSession(owner);
    }
    const operation = preparation();

    const admitted = withPinnedSession(world, sessionA, () => operation.next());
    expect(admitted.value).toBe(sessionA);
    expect(sessionA.finish().ok).toBe(true);
    const sessionB = start(profiler);

    const resumed = withPinnedSession(world, sessionA, () => operation.next());
    expect(resumed.done).toBe(true);
    expect(resumed.value).toBe(sessionA);
    expect(profiler.activeSession()).toBe(sessionB);
    expect(activeRenderProfileSession(owner)).toBe(sessionB);
  });

  it('keeps capture A on both sides of a checkpoint when it remains active', () => {
    const profiler = createProfiler({ phaseCatalog: { app: [], render: ['record'] } });
    const world = createRenderWorld();
    const owner = { profiler, renderWorld: world };
    const sessionA = start(profiler);
    function* preparation() {
      yield activeRenderProfileSession(owner);
      return activeRenderProfileSession(owner);
    }
    const operation = preparation();

    const admitted = withPinnedSession(world, sessionA, () => operation.next());
    const resumed = withPinnedSession(world, sessionA, () => operation.next());
    expect(admitted.value).toBe(sessionA);
    expect(resumed.value).toBe(sessionA);
    expect(profiler.activeSession()).toBe(sessionA);
  });

  it('keeps capture A across an injected scheduled throw after capture B starts', () => {
    const profiler = createProfiler({ phaseCatalog: { app: [], render: ['record'] } });
    const world = createRenderWorld();
    const owner = { profiler, renderWorld: world };
    const sessionA = start(profiler);
    function* preparation() {
      try {
        yield activeRenderProfileSession(owner);
        yield activeRenderProfileSession(owner);
      } catch {
        return activeRenderProfileSession(owner);
      }
      return undefined;
    }
    const operation = preparation();

    expect(withPinnedSession(world, sessionA, () => operation.next()).value).toBe(sessionA);
    expect(sessionA.finish().ok).toBe(true);
    const sessionB = start(profiler);
    expect(
      withPinnedSession(world, sessionA, () => operation.throw(new Error('checkpoint failed')))
        .value,
    ).toBe(sessionA);
    expect(profiler.activeSession()).toBe(sessionB);
    expect(activeRenderProfileSession(owner)).toBe(sessionB);
  });

  it('keeps an absent admission unprofiled when a capture starts before resume', () => {
    const profiler = createProfiler({ phaseCatalog: { app: [], render: ['record'] } });
    const world = createRenderWorld();
    const owner = { profiler, renderWorld: world };
    function* preparation() {
      yield activeRenderProfileSession(owner);
      return activeRenderProfileSession(owner);
    }
    const operation = preparation();

    const admitted = withPinnedSession(world, undefined, () => operation.next());
    const sessionB = start(profiler);
    const resumed = withPinnedSession(world, undefined, () => operation.next());
    expect(admitted.value).toBeUndefined();
    expect(resumed.value).toBeUndefined();
    expect(profiler.activeSession()).toBe(sessionB);
    expect(activeRenderProfileSession(owner)).toBe(sessionB);
  });
});
