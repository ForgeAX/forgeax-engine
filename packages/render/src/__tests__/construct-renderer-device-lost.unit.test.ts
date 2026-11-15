import { RhiError } from '@forgeax/engine-rhi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializationDeviceLoss } from '../assembly/renderer-helpers';
import { RendererContractFailureError } from '../errors/render';

const mocks = vi.hoisted(() => ({ createRenderer: vi.fn(), dispose: vi.fn() }));

vi.mock('../assembly/factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../assembly/factory')>();
  return { ...actual, createRenderer: mocks.createRenderer };
});

import { constructRendererHost, EngineEnvironmentError } from '../construct-renderer';

function failingInitialization(error: RhiError) {
  mocks.createRenderer.mockResolvedValueOnce({
    initialization: Promise.resolve({ ok: false, error }),
    dispose: mocks.dispose,
  });
}

describe('renderer initialization failure classes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reports a device lost before the first frame as an environment failure', async () => {
    const lost = new RhiError({
      code: 'device-lost',
      expected: 'device must remain alive during renderer initialization',
      hint: 'device-lost reason: unknown; message: GPU process terminated',
    });
    failingInitialization(lost);

    const result = await constructRendererHost({});

    expect(result.ok).toBe(false);
    if (result.ok) throw Error('unreachable');
    expect(result.error).toBeInstanceOf(EngineEnvironmentError);
    expect((result.error as EngineEnvironmentError).detail.webgpuError).toBe(lost);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('keeps an invalid descriptor a renderer contract failure', async () => {
    failingInitialization(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'a valid pipeline descriptor',
        hint: 'invalid shader module',
      }),
    );

    const result = await constructRendererHost({});

    expect(result.ok).toBe(false);
    if (result.ok) throw Error('unreachable');
    expect(result.error).toBeInstanceOf(RendererContractFailureError);
    expect(result.error.message).toContain('rhi-descriptor-invalid');
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});

describe('device loss behind a failed renderer initialization', () => {
  const interrupted = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'a complete current WebGPU pipeline library',
    hint: 'OperationError',
  });
  const lost = (lostReason: 'unknown' | 'destroyed') =>
    ({
      reason: 'device-lost',
      detail: { lostReason, message: 'GPU process terminated' },
      recoverable: true,
    }) as const;
  const alive = { reason: 'alive', recoverable: false } as const;

  it('reports a native loss as device-lost whatever step it interrupted', () => {
    expect(initializationDeviceLoss(interrupted, lost('unknown'), false)?.code).toBe('device-lost');
  });

  it('keeps the original failure when the device is not lost', () => {
    expect(initializationDeviceLoss(interrupted, alive, false)).toBeUndefined();
  });

  it('does not report a device its owner destroyed as device-lost', () => {
    expect(initializationDeviceLoss(interrupted, lost('destroyed'), false)).toBeUndefined();
  });

  it('does not report a loss after the renderer was disposed', () => {
    const deviceLost = new RhiError({
      code: 'device-lost',
      expected: 'device must remain alive',
      hint: 'device-lost reason: unknown',
    });
    expect(initializationDeviceLoss(deviceLost, lost('unknown'), true)).toBeUndefined();
    expect(initializationDeviceLoss(deviceLost, alive, false)).toBe(deviceLost);
  });
});
