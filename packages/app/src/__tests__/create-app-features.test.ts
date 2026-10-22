import type { RenderFeature } from '@forgeax/engine-render';
import type { RendererHostAssembly } from '@forgeax/engine-runtime/internal/renderer-host';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';

const constructRuntimeRendererHost = vi.hoisted(() => vi.fn());

vi.mock('@forgeax/engine-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgeax/engine-runtime')>();
  return actual;
});

vi.mock('@forgeax/engine-runtime/internal/renderer-host', () => ({
  constructRuntimeRendererHost,
  loadRhiPack: vi.fn(),
}));

import { createApp } from '../browser';

function rendererStub() {
  const lease = {};
  return {
    state: () => 'alive' as const,
    inspect: () => ({}),
    subscribe: () => () => undefined,
    attach: () => ({ ok: true as const, value: lease }),
    draw: () => ({ ok: true as const, value: {} }),
    observe: async () => ({ ok: true as const, value: {} }),
    releaseSurface: () => ({ ok: true as const, value: undefined }),
    restoreSurface: () => ({ ok: true as const, value: undefined }),
    recover: async () => ({ ok: true as const, value: undefined }),
    onError: () => () => undefined,
    onLost: () => () => undefined,
    dispose: () => undefined,
  };
}

describe('createApp features passthrough', () => {
  it('forwards the same ordered feature array to createRenderer', async () => {
    const first = { identity: 'test.first' } as unknown as RenderFeature<unknown>;
    const second = { identity: 'test.second' } as unknown as RenderFeature<unknown>;
    const features = [first, second] as const;
    constructRuntimeRendererHost.mockResolvedValue({
      ok: true,
      value: {
        renderer: rendererStub(),
        assets: undefined,
        initialization: Promise.resolve(
          ok(undefined),
        ) satisfies RendererHostAssembly['initialization'],
      },
    });

    const canvas = { tagName: 'canvas', isConnected: true } as HTMLCanvasElement;
    const dynamicGeometryMeshBudgetBytes = 512 * 1024 * 1024;
    const assetBudgetBytes = 6 * 1024 * 1024 * 1024;
    const result = await createApp(canvas, {
      features,
      dynamicGeometryMeshBudgetBytes,
      assetBudgetBytes,
    });

    expect(result.ok).toBe(true);
    expect(constructRuntimeRendererHost).toHaveBeenCalledTimes(1);
    expect(constructRuntimeRendererHost.mock.calls[0]?.[1]).toMatchObject({
      features,
      dynamicGeometryMeshBudgetBytes,
      assetBudgetBytes,
    });
    expect(constructRuntimeRendererHost.mock.calls[0]?.[1].features).toBe(features);
  });

  it('rejects an invalid asset budget before any renderer realm is constructed', async () => {
    constructRuntimeRendererHost.mockClear();
    const canvas = { tagName: 'canvas', isConnected: true } as HTMLCanvasElement;
    for (const assetBudgetBytes of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])
      await expect(createApp(canvas, { assetBudgetBytes })).rejects.toThrow(
        'assetBudgetBytes must be a positive safe integer',
      );
    expect(constructRuntimeRendererHost).not.toHaveBeenCalled();
  });
});

vi.mock('@forgeax/engine-platform-browser', () => import('./platform-fixture'));
