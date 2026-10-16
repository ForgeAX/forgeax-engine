import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeExecutionCapabilities } from '../execution/capabilities';

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
});
