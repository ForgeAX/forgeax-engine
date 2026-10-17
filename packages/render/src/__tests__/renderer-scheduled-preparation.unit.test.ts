import { RhiError } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { exposeRenderer } from '../assembly/factory';
import type {
  RendererHostEventListener,
  RendererHostImplementation,
} from '../assembly/host-contract';
import { type RenderError, RendererContractFailureError } from '../errors/render';
import type {
  FrameReceipt,
  Renderer,
  RendererEvent,
  RendererState,
  RenderPreparationSchedule,
  RenderResult,
} from '../render-contract';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const receipt = (frameId = 17): FrameReceipt => ({
  frameId,
  deviceGeneration: 3,
  graphGeneration: 9,
  presentation: 'ready',
  completed: Promise.resolve(ok(undefined)),
});
const cancelled = () =>
  err(
    new RendererContractFailureError(
      'draw',
      'the scheduled preparation still owns its current frame',
    ),
  );
type ScheduledDraw = NonNullable<RendererHostImplementation['drawFrameScheduled']>;

function fixture(drawFrameScheduled: ScheduledDraw) {
  let state: RendererState = 'alive';
  let hostListener: RendererHostEventListener | undefined;
  const order: string[] = [];
  const off = vi.fn();
  const host = {
    inspect: vi.fn(() => ({ state, frame: { deviceGeneration: 3 } })),
    currentDeviceGeneration: () => 3,
    subscribeHostEvents: (listener: RendererHostEventListener) => {
      hostListener = listener;
      return off;
    },
    drawFrame: vi.fn<RendererHostImplementation['drawFrame']>(() => ok(receipt(18))),
    drawFrameScheduled: vi.fn(drawFrameScheduled),
    releaseSurface: vi.fn(() => ok(undefined)),
    restoreSurface: vi.fn(() => ok(undefined)),
    setProfile: vi.fn(() => ok(undefined)),
    setOutputColorSpace: vi.fn(() => ok(undefined)),
    setSurfaceDynamicInput: vi.fn(),
    acceptDynamicGeometry: vi.fn(() => ok(undefined)),
    dispose: vi.fn(() => {
      order.push('host-dispose');
      state = 'disposed';
      return ok(undefined);
    }),
    recover: vi.fn(async () => {
      order.push('host-recover');
      state = 'alive';
      return ok(undefined);
    }),
  };
  const renderer = exposeRenderer(host as unknown as RendererHostImplementation);
  const events: RendererEvent[] = [];
  renderer.subscribe((event) => events.push(event));
  return {
    renderer,
    host,
    events,
    order,
    off,
    loseDevice: () => {
      state = 'device-lost';
      hostListener?.({
        kind: 'health',
        health: {
          reason: 'device-lost',
          recoverable: true,
          detail: { lostReason: 'unknown', message: 'test loss' },
        },
      });
    },
    reportError: (error: RhiError) => hostListener?.({ kind: 'error', error }),
  };
}

function drawScheduled(
  renderer: Renderer,
  schedule: RenderPreparationSchedule = { checkpoint: async () => undefined },
) {
  if (renderer.drawScheduled === undefined) throw new Error('scheduled draw must be exposed');
  // The fake Host owns input validation; these contracts exercise the facade only.
  return renderer.drawScheduled({} as never, schedule);
}

const submitted = (events: readonly RendererEvent[]) =>
  events.filter((event) => event.kind === 'frame-submitted');

describe('Renderer scheduled preparation lifetime', () => {
  it('passes a live cancellation/current owner and publishes only the exact successful receipt', async () => {
    const prepared = deferred<void>();
    const completion = deferred<RenderResult<void, RenderError>>();
    const accepted = { ...receipt(), completed: completion.promise };
    let current = true;
    let received: RenderPreparationSchedule | undefined;
    const checkpoint = vi.fn(() => prepared.promise);
    const test = fixture(async (_request, schedule) => {
      received = schedule;
      await schedule.checkpoint();
      return ok(accepted);
    });

    const result = drawScheduled(test.renderer, { checkpoint, isCurrent: () => current });

    expect(received?.signal).toBeInstanceOf(AbortSignal);
    expect(received?.signal?.aborted).toBe(false);
    expect(received?.isCurrent?.()).toBe(true);
    current = false;
    expect(received?.isCurrent?.()).toBe(false);
    current = true;
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(submitted(test.events)).toEqual([]);
    prepared.resolve(undefined);
    expect(await result).toEqual(ok(accepted));
    expect(submitted(test.events)).toEqual([
      {
        kind: 'frame-submitted',
        frameId: 17,
        deviceGeneration: 3,
        graphGeneration: 9,
        receipt: accepted,
      },
    ]);
    expect(submitted(test.events)[0]?.receipt).toBe(accepted);
    // Submission does not wait for this independent queue-completion receipt.
    completion.resolve(ok(undefined));
  });

  it('rejects another draw and synchronous owner mutations while paused without calling the Host', async () => {
    const paused = deferred<void>();
    const test = fixture(async (_request, schedule) => {
      await schedule.checkpoint();
      return cancelled();
    });
    const active = drawScheduled(test.renderer, { checkpoint: () => paused.promise });

    expect(await drawScheduled(test.renderer)).toMatchObject({ ok: false });
    expect(() => test.renderer.draw({} as never)).toThrow(RendererContractFailureError);
    expect(() => test.renderer.releaseSurface()).toThrow(RendererContractFailureError);
    expect(() => test.renderer.restoreSurface()).toThrow(RendererContractFailureError);
    expect(() => test.renderer.setProfile({} as never)).toThrow(RendererContractFailureError);
    expect(() => test.renderer.setOutputColorSpace('srgb')).toThrow(RendererContractFailureError);
    expect(() => test.renderer.setSurfaceDynamicInput(undefined)).toThrow(
      RendererContractFailureError,
    );
    expect(() => test.renderer.acceptDynamicGeometry({} as never, {} as never)).toThrow(
      RendererContractFailureError,
    );
    expect(test.host.drawFrameScheduled).toHaveBeenCalledOnce();
    for (const method of [
      test.host.drawFrame,
      test.host.releaseSurface,
      test.host.restoreSurface,
      test.host.setProfile,
      test.host.setOutputColorSpace,
      test.host.setSurfaceDynamicInput,
      test.host.acceptDynamicGeometry,
    ])
      expect(method).not.toHaveBeenCalled();
    expect(test.renderer.inspect().state).toBe('alive');
    expect(test.renderer.currentDeviceGeneration?.()).toBe(3);
    expect(submitted(test.events)).toEqual([]);

    paused.resolve(undefined);
    expect(await active).toMatchObject({ ok: false });
    expect(test.renderer.draw({} as never)).toMatchObject({ ok: true });
    expect(test.host.drawFrame).toHaveBeenCalledOnce();
  });

  it('exposes active ownership before a synchronous first checkpoint disposes, then waits for raw cleanup', async () => {
    const cleanup = deferred<void>();
    let disposal: ReturnType<Renderer['dispose']> | undefined;
    let childSignal: AbortSignal | undefined;
    const test = fixture(async (_request, schedule) => {
      test.order.push('host-enter');
      childSignal = schedule.signal;
      childSignal?.addEventListener('abort', () => test.order.push('abort'), { once: true });
      await schedule.checkpoint();
      test.order.push('checkpoint-returned');
      await cleanup.promise;
      test.order.push('host-frame-cleanup');
      return cancelled();
    });

    const result = drawScheduled(test.renderer, {
      checkpoint: () => {
        test.order.push('checkpoint-dispose');
        disposal = test.renderer.dispose();
        return Promise.resolve();
      },
    });

    expect(childSignal?.aborted).toBe(true);
    expect(disposal).toBeDefined();
    expect(test.renderer.dispose()).toBe(disposal);
    expect(test.renderer.draw({} as never).ok).toBe(false);
    expect(test.host.drawFrame).not.toHaveBeenCalled();
    expect(test.host.dispose).not.toHaveBeenCalled();
    expect(test.order.slice(0, 3)).toEqual(['host-enter', 'checkpoint-dispose', 'abort']);
    expect(await drawScheduled(test.renderer)).toMatchObject({ ok: false });
    cleanup.resolve(undefined);
    expect(await result).toMatchObject({ ok: false });
    expect(await disposal).toMatchObject({ ok: true });
    expect(test.order.slice(-2)).toEqual(['host-frame-cleanup', 'host-dispose']);
    expect(test.host.dispose).toHaveBeenCalledOnce();
    expect(test.off).toHaveBeenCalledOnce();
    expect(test.renderer.state()).toBe('disposed');
    expect(submitted(test.events)).toEqual([]);
  });

  it('aborts and joins the paused frame before recovery can replace the device owner', async () => {
    const cleanup = deferred<void>();
    let childSignal: AbortSignal | undefined;
    const test = fixture(async (_request, schedule) => {
      childSignal = schedule.signal;
      await cleanup.promise;
      test.order.push('host-frame-cleanup');
      return cancelled();
    });
    const active = drawScheduled(test.renderer);
    test.loseDevice();
    const recovering = test.renderer.recover();

    expect(test.renderer.recover()).toBe(recovering);
    expect(childSignal?.aborted).toBe(true);
    expect(test.renderer.state()).toBe('recovering');
    expect(test.host.recover).not.toHaveBeenCalled();
    expect(submitted(test.events)).toEqual([]);
    cleanup.resolve(undefined);
    expect(await active).toMatchObject({ ok: false });
    expect(await recovering).toMatchObject({ ok: true });
    expect(test.order).toEqual(['host-frame-cleanup', 'host-recover']);
    expect(test.renderer.state()).toBe('alive');
    expect(test.host.recover).toHaveBeenCalledOnce();
    expect(submitted(test.events)).toEqual([]);
  });

  it('forwards an external abort and removes that listener after the failed operation settles', async () => {
    const external = new AbortController();
    const remove = vi.spyOn(external.signal, 'removeEventListener');
    const cleanup = deferred<void>();
    let childSignal: AbortSignal | undefined;
    const test = fixture(async (_request, schedule) => {
      childSignal = schedule.signal;
      await cleanup.promise;
      return cancelled();
    });
    const active = drawScheduled(test.renderer, {
      checkpoint: async () => undefined,
      signal: external.signal,
    });
    expect(childSignal).not.toBe(external.signal);
    expect(childSignal?.aborted).toBe(false);
    external.abort();
    expect(childSignal?.aborted).toBe(true);
    cleanup.resolve(undefined);
    expect(await active).toMatchObject({ ok: false });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(submitted(test.events)).toEqual([]);
    remove.mockRestore();
  });

  it('passes a pre-aborted signal to the raw owner and clears active ownership after rejection', async () => {
    const external = new AbortController();
    external.abort();
    const failure = new Error('checkpoint rejected');
    const test = fixture(async (_request, schedule) => {
      expect(schedule.signal?.aborted).toBe(true);
      await schedule.checkpoint();
      return ok(receipt());
    });
    await expect(
      drawScheduled(test.renderer, {
        signal: external.signal,
        checkpoint: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);
    expect(submitted(test.events)).toEqual([]);
    expect(test.renderer.draw({} as never)).toMatchObject({ ok: true });
    expect(test.host.drawFrame).toHaveBeenCalledOnce();
  });

  it('preserves the scheduled same-call owner error and never acknowledges a failed preparation', async () => {
    const cause = new RhiError({
      code: 'rhi-not-available',
      expected: 'the scheduled owner can prepare its resources',
      hint: 'inspect the failing resource owner',
    });
    const test = fixture(async () => {
      test.reportError(cause);
      return err(new RendererContractFailureError('draw', 'no command buffer was submitted'));
    });

    const result = await drawScheduled(test.renderer);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'device-operation-failed',
        detail: { cause: { code: 'rhi-not-available' } },
      },
    });
    expect(submitted(test.events)).toEqual([]);
    test.host.drawFrame.mockImplementation(() => cancelled());
    const next = test.renderer.draw({} as never);
    expect(next).toMatchObject({
      ok: false,
      error: {
        code: 'device-operation-failed',
        detail: { cause: { code: 'renderer-contract-failed' } },
      },
    });
  });
});
