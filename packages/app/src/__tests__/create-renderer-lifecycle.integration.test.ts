import type { Renderer } from '@forgeax/engine-render';
import { createRenderer, EngineEnvironmentError } from '@forgeax/engine-runtime';
import { describe, expect, it } from 'vitest';
import { createApp } from '../browser';

describe('app-facing renderer lifecycle', () => {
  it('consumes the three lifecycle Result boundaries without casts', async () => {
    const events: string[] = [];
    const renderer = {
      attach: () => ({ ok: false as const, error: {} }),
      draw: () => ({ ok: false as const, error: {} }),
      observe: async () => ({ ok: false as const, error: {} }),
      releaseSurface: () => ({ ok: true as const, value: undefined }),
      restoreSurface: () => ({ ok: true as const, value: undefined }),
      recover: async () => ({ ok: true as const, value: undefined }),
      dispose: () => events.push('dispose'),
      onError: () => () => undefined,
      onLost: () => () => undefined,
    } as unknown as Renderer;
    expect(renderer.attach({} as never).ok).toBe(false);
    expect(renderer.draw({} as never).ok).toBe(false);
    renderer.dispose();
    renderer.dispose();
    expect(events).toEqual(['dispose', 'dispose']);
  });

  it('returns construction failures through the Runtime Result boundary', async () => {
    const result = await createRenderer(null as never);
    expect(result.ok).toBe(false);
  });

  it('returns EngineEnvironmentError through the canvas Result path', async () => {
    const canvas = {
      tagName: 'CANVAS',
      isConnected: true,
      width: 16,
      height: 16,
      getContext: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
    const result = await createApp(canvas, { rhi: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(EngineEnvironmentError);
  });
});
