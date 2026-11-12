import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';
import { createFrameLoop } from '../internal/frame-loop';
import { testPlatform } from './platform-fixture';

const renderer = {
  state: () => 'alive' as const,
  backend: 'webgpu',
  ready: Promise.resolve({ ok: true, value: undefined }),
  attach: () => ({ ok: true, value: undefined }),
  detachWorld: () => {},
  draw: vi.fn(() => ({ ok: true, value: undefined })),
  onError: () => () => {},
  onLost: () => () => {},
  dispose: () => {},
} as unknown as Renderer;

describe('frame loop skipped frames', () => {
  it('reports an update-only step so frame-scoped debug geometry is dropped', () => {
    const skipped = vi.fn();
    const loop = createFrameLoop({
      world: new World(),
      renderer,
      platform: testPlatform({ now: () => 0, raf: () => 1, caf: () => undefined }),
      onFrameSkipped: skipped,
    });
    loop.start().unwrap();
    loop.pause().unwrap();
    expect(loop.stepFrame(1 / 60, false).ok).toBe(true);
    expect(skipped).toHaveBeenCalledTimes(1);
    expect(renderer.draw).not.toHaveBeenCalled();
    expect(loop.stepFrame(1 / 60).ok).toBe(true);
    expect(skipped).toHaveBeenCalledTimes(1);
  });
});
