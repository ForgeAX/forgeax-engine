import type { RhiInstance } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { attachRecorder, type RecordableBackend } from '../recorder/session';

function backend(): RecordableBackend {
  return {
    rhi: {
      requestAdapter: vi.fn(() => Promise.resolve({ ok: false as const, error: {} })),
    } as unknown as RhiInstance,
    createShaderModule: vi.fn(),
  };
}

describe('RecorderSession lifecycle', () => {
  it('turns device loss into a terminal failure and permits a fresh generation', async () => {
    const attached = attachRecorder(backend());
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const first = attached.value.captureFrame();
    attached.value.deviceLost();
    expect(await first).toMatchObject({ ok: false, error: { code: 'capture-unavailable' } });

    const second = attached.value.captureFrame();
    await attached.value.frameBoundary();
    await attached.value.frameBoundary();
    expect(await second).toMatchObject({ ok: true });
  });

  it('makes dispose idempotent and rejects later captures without throwing', async () => {
    const attached = attachRecorder(backend());
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    expect((await attached.value.dispose()).ok).toBe(true);
    expect((await attached.value.dispose()).ok).toBe(true);
    expect(await attached.value.captureFrame()).toMatchObject({
      ok: false,
      error: { code: 'capture-unavailable' },
    });
  });
});
