import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executionWorkerScriptsReachable,
  probeExecutionCapabilities,
} from '../execution/capabilities';

describe('probeExecutionCapabilities', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('allows a delayed Worker probe when the startup deadline is disabled', async () => {
    vi.useFakeTimers();
    let worker!: {
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: ((event: ErrorEvent) => void) | null;
      terminate: ReturnType<typeof vi.fn>;
    };
    vi.stubGlobal(
      'Worker',
      class {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        terminate = vi.fn();

        constructor() {
          worker = this;
        }
      },
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:capability-probe');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const pending = probeExecutionCapabilities(
      {
        transferControlToOffscreen: vi.fn(),
      } as unknown as HTMLCanvasElement,
      null,
    );
    await vi.advanceTimersByTimeAsync(2_001);

    expect(worker.terminate).not.toHaveBeenCalled();
    worker.onmessage?.({
      data: { workerAnimationFrame: true, workerWebGpu: true, atomicsWait: true },
    } as MessageEvent);

    await expect(pending).resolves.toMatchObject({
      workerAnimationFrame: { available: true },
      workerWebGpu: { available: true },
      atomicsWait: { available: true },
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it.each([
    'unavailable',
    'rejected',
    'available',
    'webgl2',
    'webgl2-denied',
    'stub',
  ] as const)('checks the real Worker adapter outcome when the API is %s', async (outcome) => {
    let script!: Blob;
    const requestAdapter = vi.fn(async () => {
      if (outcome === 'rejected') throw new Error('adapter denied');
      return outcome === 'available' ? {} : null;
    });
    const loseContext = vi.fn();
    const getContext = vi.fn(() =>
      outcome === 'webgl2' ? { getExtension: () => ({ loseContext }) } : null,
    );
    vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
      script = value as Blob;
      return 'blob:adapter-probe';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal(
      'Worker',
      class {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        terminate = vi.fn();
        constructor() {
          void script
            .text()
            .then((source) =>
              runInNewContext(source, {
                navigator: { gpu: { requestAdapter } },
                OffscreenCanvas: class {
                  getContext = getContext;
                },
                requestAnimationFrame: () => {},
                Atomics,
                postMessage: (data: unknown) => this.onmessage?.({ data } as MessageEvent),
              }),
            )
            .catch(() => this.onerror?.({} as ErrorEvent));
        }
      },
    );
    const capabilities = await probeExecutionCapabilities(
      { transferControlToOffscreen: vi.fn() } as unknown as HTMLCanvasElement,
      undefined,
      outcome === 'stub',
    );
    expect(capabilities.workerWebGpu.available).toBe(
      outcome === 'available' || outcome === 'webgl2' || outcome === 'stub',
    );
    expect(requestAdapter).toHaveBeenCalledTimes(outcome === 'stub' ? 0 : 1);
    expect(getContext).toHaveBeenCalledTimes(outcome === 'available' || outcome === 'stub' ? 0 : 1);
    expect(loseContext).toHaveBeenCalledTimes(outcome === 'webgl2' ? 1 : 0);
  });
});

describe('executionWorkerScriptsReachable', () => {
  it('rejects Worker scripts from an opaque sandboxed document', () => {
    expect(
      executionWorkerScriptsReachable(
        'null',
        'https://host.test/modeling-studio/show/assets/app.js',
      ),
    ).toBe(false);
    expect(
      executionWorkerScriptsReachable('https://other.test', 'https://host.test/assets/app.js'),
    ).toBe(false);
  });

  it('accepts same-origin scripts and realms without a document origin', () => {
    expect(executionWorkerScriptsReachable('https://host.test', 'https://host.test/a.js')).toBe(
      true,
    );
    expect(executionWorkerScriptsReachable('null', 'blob:null/0b8d7f0e')).toBe(true);
    expect(executionWorkerScriptsReachable(undefined, 'file:///app/a.js')).toBe(true);
  });

  it('disables execution Workers before probing when their scripts are cross-origin', async () => {
    const constructed = vi.fn();
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          constructed();
        }
      },
    );
    vi.stubGlobal('origin', 'https://other.test');
    const capabilities = await probeExecutionCapabilities(
      { transferControlToOffscreen: vi.fn() } as unknown as HTMLCanvasElement,
      null,
    );
    expect(capabilities.worker).toEqual({
      available: false,
      reason: 'Worker scripts are cross-origin to this document',
    });
    expect(capabilities.workerWebGpu.available).toBe(false);
    expect(constructed).not.toHaveBeenCalled();
  });
});
