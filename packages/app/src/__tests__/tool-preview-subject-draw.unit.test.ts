import { describe, expect, it, vi } from 'vitest';
import { stepToolPreviewFrame, toolPreviewSubjectDrawn } from '../tool-preview/bootstrap';
import type { App } from '../types';

describe('tool preview subject evidence', () => {
  it('keeps material canonical-only protection while accepting a single-submesh mesh', () => {
    expect(toolPreviewSubjectDrawn('material', 2)).toBe(false);
    expect(toolPreviewSubjectDrawn('material', 3)).toBe(true);
    expect(toolPreviewSubjectDrawn('mesh', 0)).toBe(false);
    expect(toolPreviewSubjectDrawn('mesh', 1)).toBe(true);
    expect(toolPreviewSubjectDrawn('texture', 0)).toBe(false);
    expect(toolPreviewSubjectDrawn('texture', 1)).toBe(true);
  });

  it('waits for a returned frame receipt before retrying exhausted credit', async () => {
    const stepFrame = vi
      .fn()
      .mockReturnValueOnce({
        ok: false,
        error: {
          code: 'app-frame-step-invalid',
          expected: 'frame credit',
          hint: 'wait for a receipt',
          detail: {
            state: 'paused',
            deltaSeconds: 1 / 60,
            reason: 'credit',
          },
        },
      })
      .mockReturnValueOnce({ ok: true, value: undefined });
    const app = { stepFrame } as unknown as App;

    await expect(stepToolPreviewFrame(app, 1 / 60)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(stepFrame).toHaveBeenCalledTimes(2);
  });
});
