import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import type { FrameReceipt, Renderer, RenderFrameInput } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';
import { createFrameLoop } from '../internal/frame-loop';
import { testPlatform } from './platform-fixture';

function makeReceipt(frameId: number): FrameReceipt {
  return {
    frameId,
    deviceGeneration: 0,
    backendId: 'test',
    completed: Promise.resolve({ ok: true, value: undefined }),
  } as unknown as FrameReceipt;
}

describe('frame loop submission pause scheduling', () => {
  it('does not leave a duplicate rAF when a submission callback pauses then resumes', async () => {
    const world = new World();
    const callbacks = new Map<number, (time: number) => void>();
    let nextId = 0;
    let clock = 0;
    const raf = (callback: (time: number) => void): number => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    };
    const caf = (id: number): void => {
      callbacks.delete(id);
    };
    const pumpOne = (): void => {
      const entry = callbacks.entries().next().value as
        | [number, (time: number) => void]
        | undefined;
      if (entry === undefined) return;
      callbacks.delete(entry[0]);
      entry[1](++clock);
    };
    let draws = 0;
    let pausedOnce = false;
    let loop!: ReturnType<typeof createFrameLoop>;
    const renderer = {
      state: () => 'alive' as const,
      attach: () => ({ ok: true, value: createRenderReadLease(world) }),
      draw: (_request: RenderFrameInput) => {
        draws++;
        return { ok: true, value: makeReceipt(draws) };
      },
    } as unknown as Renderer;
    loop = createFrameLoop({
      world,
      renderer,
      onSubmitted: () => {
        if (pausedOnce) return;
        pausedOnce = true;
        expect(loop.pause().ok).toBe(true);
        queueMicrotask(() => {
          expect(loop.resume().ok).toBe(true);
        });
      },
      platform: testPlatform({ now: () => ++clock, raf, caf }),
    });

    expect(loop.start().ok).toBe(true);
    pumpOne();
    expect(draws).toBe(1);
    expect(callbacks.size).toBe(0);

    await Promise.resolve();
    expect(callbacks.size).toBe(1);
    pumpOne();
    expect(draws).toBe(2);
    expect(callbacks.size).toBe(1);
    loop.stop();
  });
});
