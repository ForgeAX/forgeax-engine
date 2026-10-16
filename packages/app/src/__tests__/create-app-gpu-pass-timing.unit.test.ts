import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GpuPassTimingOptions } from '@forgeax/engine-render';
import type { RendererHostAssembly } from '@forgeax/engine-runtime/internal/renderer-host';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { CreateAppOptions } from '../types';

const constructRuntimeRendererHost = vi.hoisted(() => vi.fn());

vi.mock('@forgeax/engine-runtime/internal/renderer-host', () => ({
  constructRuntimeRendererHost,
  loadRhiPack: vi.fn(),
}));

import { createApp } from '../browser';

function rendererStub() {
  const lease = {};
  return {
    inspect: () => ({}),
    attach: () => ({ ok: true as const, value: lease }),
    draw: () => ({ ok: true as const, value: {} }),
    observe: async () => ({ ok: true as const, value: {} }),
    releaseSurface: () => ({ ok: true as const, value: undefined }),
    restoreSurface: () => ({ ok: true as const, value: undefined }),
    recover: async () => ({ ok: true as const, value: undefined }),
    subscribe: () => () => undefined,
    dispose: () => ({ ok: true as const, value: undefined }),
  };
}

describe('app GPU pass timing forwarding', () => {
  it('accepts the same option shape and forwards its identity unchanged', async () => {
    const gpuPassTiming = { retentionFrames: 4 } satisfies GpuPassTimingOptions;
    const options = { gpuPassTiming } satisfies CreateAppOptions;
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

    const result = await createApp(canvas, options);

    expect(result.ok).toBe(true);
    expect(constructRuntimeRendererHost.mock.calls[0]?.[1].gpuPassTiming).toBe(gpuPassTiming);
  });

  it('keeps GPU timing realm-bound when an execution bootstrap is selected', async () => {
    const canvas = { tagName: 'canvas', isConnected: true } as HTMLCanvasElement;
    const result = await createApp(canvas, {
      gpuPassTiming: {},
      execution: { bootstrap: 'https://example.test/engine-bootstrap.js' },
    });

    expect(result.ok).toBe(false);
  });

  it('does not create a second timing owner in App', () => {
    const source = readFileSync(fileURLToPath(new URL('../browser.ts', import.meta.url)), 'utf8');
    expect(source).toContain('gpuPassTiming: opts.gpuPassTiming');
    expect(source).not.toContain('createGpuPassTimingSession');
    expect(source).not.toContain('frameLatency');
  });
});

vi.mock('@forgeax/engine-platform-browser', () => import('./platform-fixture'));
