import { World } from '@forgeax/engine-ecs';
import { createProfiler } from '@forgeax/engine-profiler';
import type { Renderer } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';
import { createFrameLoop } from '../internal/frame-loop';
import { testPlatform } from './platform-fixture';

function makeRenderer(): Renderer {
  return {
    state: () => 'alive' as const,
    backend: 'webgpu',
    ready: Promise.resolve({ ok: true, value: undefined }),
    attach: () => ({ ok: true, value: undefined }),
    detachWorld: () => {},
    draw: () => ({ ok: true, value: undefined }),
    onError: () => () => {},
    onLost: () => () => {},
    dispose: () => {},
  } as unknown as Renderer;
}

describe('App profiler default-off allocation boundary', () => {
  it('reports zero profiler-owned event objects and no artifact on the full loop', () => {
    const allocationReport = { profilerEventObjectAllocations: 0 };
    const profiler = createProfiler({ enabled: false, allocationReport });
    const scheduler = {
      callback: undefined as ((timestamp: number) => void) | undefined,
      raf(callback: (timestamp: number) => void): number {
        this.callback = callback;
        return 1;
      },
      caf(): void {
        this.callback = undefined;
      },
    };
    const loop = createFrameLoop({
      world: new World(),
      renderer: makeRenderer(),
      profiler,
      platform: testPlatform({
        now: () => 1000,
        raf: scheduler.raf.bind(scheduler),
        caf: scheduler.caf.bind(scheduler),
      }),
    });

    loop.start().unwrap();
    scheduler.callback?.(1000);
    loop.stop().unwrap();

    expect({
      profilerEventObjectAllocations: allocationReport.profilerEventObjectAllocations,
      artifact: profiler.latestCapture(),
    }).toEqual({ profilerEventObjectAllocations: 0, artifact: undefined });
  });
});
