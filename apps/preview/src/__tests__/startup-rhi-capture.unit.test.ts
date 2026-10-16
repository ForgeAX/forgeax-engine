import type { App } from '@forgeax/engine-app';
import { describe, expect, it, vi } from 'vitest';
import { capturePreviewStartupRhi } from '../startup-rhi-capture';

function host(capture: unknown, frameId = 0) {
  return {
    renderer: { inspect: () => ({ frame: { frameId }, capabilities: { backendKind: 'webgpu' } }) },
    rhiCapture: capture,
  } as unknown as Pick<App, 'renderer' | 'rhiCapture'>;
}

describe('Preview first ordinary-frame recorder observation', () => {
  it('arms the existing front door synchronously and streams the original artifact', async () => {
    const artifact = {
      byteLength: 21,
      get bytes() {
        throw new Error('do not materialize');
      },
    };
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const captureFrame = vi.fn(() => pending);
    const upload = vi.fn(async (_artifact: unknown, _options: unknown) => ({
      ok: true,
      value: { kind: 'rhi-tape', digest: 'server-digest' },
    }));
    const report = vi.fn();
    const signal = new AbortController().signal;
    const observed = capturePreviewStartupRhi(
      host({ captureFrame, upload }),
      'game-capability-lab',
      signal,
      report,
    );
    expect(captureFrame).toHaveBeenCalledWith({
      signal,
      snapshotTimeoutMs: 1000,
      seed: { maxResourceBytes: 0 },
    });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'armed', backendKind: 'webgpu', frames: 1 }),
    );
    finish({ ok: true, value: artifact });
    await observed;
    expect(upload.mock.calls[0]?.[0]).toBe(artifact);
    expect(upload.mock.calls[0]?.[1]).toEqual({
      signal,
      runId: expect.stringMatching(/^preview-startup-/),
    });
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'uploaded' }));
  });

  it('retains a queue-drain capture failure and does not upload a substitute', async () => {
    const error = { code: 'capture-timeout', detail: { snapshotStage: 'queue-drain' } };
    const upload = vi.fn();
    const report = vi.fn();
    await capturePreviewStartupRhi(
      host({ captureFrame: async () => ({ ok: false, error }), upload }),
      'lab',
      new AbortController().signal,
      report,
    );
    expect(report).toHaveBeenLastCalledWith({ slug: 'lab', status: 'capture-failed', error });
    expect(upload).not.toHaveBeenCalled();
  });

  it('fails closed when recording is missing or the first frame already ran', async () => {
    const report = vi.fn();
    const captureFrame = vi.fn();
    await capturePreviewStartupRhi(host(undefined), 'lab', new AbortController().signal, report);
    expect(report).toHaveBeenLastCalledWith({
      slug: 'lab',
      status: 'unavailable',
      code: 'capture-unavailable',
    });
    await capturePreviewStartupRhi(
      host({ captureFrame }, 2),
      'lab',
      new AbortController().signal,
      report,
    );
    expect(captureFrame).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'initial-frame-already-submitted' }),
    );
  });

  it('does not reject startup when capture or the observer throws', async () => {
    await expect(
      capturePreviewStartupRhi(
        host({
          captureFrame() {
            throw new Error('owner unavailable');
          },
        }),
        'lab',
        new AbortController().signal,
        () => {
          throw new Error('observer unavailable');
        },
      ),
    ).resolves.toBeUndefined();
  });
});
