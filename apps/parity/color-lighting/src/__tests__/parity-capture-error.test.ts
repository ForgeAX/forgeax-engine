// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@forgeax/engine-runtime', () => ({
  createRenderer: vi.fn(),
}));
vi.mock('virtual:forgeax/bundler', () => ({
  forgeaxBundlerAdapter: () => ({}),
}));

import { createRenderer } from '@forgeax/engine-runtime';
import { captureForgeax } from '../main';

const mockedCreateRenderer = vi.mocked(createRenderer);

describe('color-lighting parity capture renderer diagnostics', () => {
  beforeEach(() => {
    mockedCreateRenderer.mockReset();
  });

  it('retains the complete structured renderer.ready error on the fail-closed path', async () => {
    const compilerMessages = [
      {
        message: 'expected a type',
        type: 'error',
        lineNum: 7,
        linePos: 11,
        offset: 42,
        length: 3,
      },
    ];
    const readyError = Object.assign(new Error('shader compile failed'), {
      code: 'shader-compile-failed',
      expected: 'valid shader module',
      hint: 'inspect compiler diagnostics',
      detail: { compilerMessages },
    });
    const dispose = vi.fn();
    mockedCreateRenderer.mockResolvedValue({
      ready: Promise.resolve({ ok: false, error: readyError }),
      dispose,
    } as never);

    await expect(
      captureForgeax(
        {
          caseId: 'parity-capture-error',
          required: true,
          colorDomain: 'displayEncoded',
          scene: { width: 1, height: 1, background: [0, 0, 0, 1] },
          budget: { analyticMax: 0, roiMax: 0, byteMax: 0 },
        },
        'webgl',
      ),
    ).rejects.toThrow(
      JSON.stringify({
        code: 'shader-compile-failed',
        message: 'shader compile failed',
        hint: 'inspect compiler diagnostics',
        detail: { compilerMessages },
        compilerMessages,
      }),
    );
    expect(dispose).toHaveBeenCalledOnce();
  });
});
