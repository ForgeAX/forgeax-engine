import { createProfiler } from '@forgeax/engine-profiler';
import { describe, expect, it } from 'vitest';

import { executeScript } from '../execute';

describe('browser-safe execute profiler root', () => {
  it('runs a bounded capture start through the same eval core', async () => {
    const profiler = createProfiler();
    const result = await executeScript('profiler.startCapture({ frameLimit: 1, eventLimit: 8 })', {
      world: {},
      renderer: {},
      assets: {},
      profiler,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { ok: true, value: { captureId: 'capture-0001' } },
    });
  });

  it('allows the page to return a structured not-enabled result without a transport error', async () => {
    const result = await executeScript(
      "typeof profiler === 'undefined' ? { ok: false, error: { code: 'profiler-not-enabled', expected: 'an opted-in profiler root', hint: 'Pass profiler to createApp.', detail: { enabled: false } } } : null",
      { world: {}, renderer: {}, assets: {} },
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        ok: false,
        error: {
          code: 'profiler-not-enabled',
          expected: expect.any(String),
          hint: expect.any(String),
          detail: { enabled: false },
        },
      },
    });
  });
});
