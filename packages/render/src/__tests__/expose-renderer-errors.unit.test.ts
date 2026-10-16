import { World } from '@forgeax/engine-ecs';
import { RhiError } from '@forgeax/engine-rhi';
import { err } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { exposeRenderer } from '../assembly/factory';
import type {
  RendererHostEventListener,
  RendererHostImplementation,
} from '../assembly/host-contract';
import { DynamicGeometryError } from '../dynamic-geometry';
import { RendererContractFailureError } from '../errors/render';

describe('exposeRenderer error projection', () => {
  it('reports an internal draw contract failure as a device operation failure', () => {
    const host = {
      inspect: () => ({ state: 'alive' }),
      subscribeHostEvents: () => () => undefined,
      drawFrame: () =>
        err(
          new RendererContractFailureError(
            'draw',
            'the Standard render owner did not submit a command buffer',
          ),
        ),
    } as unknown as RendererHostImplementation;
    const renderer = exposeRenderer(host);

    const result = renderer.draw({} as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('device-operation-failed');
      if (result.error.code !== 'device-operation-failed') return;
      expect(result.error.detail.cause).toMatchObject({
        code: 'renderer-contract-failed',
        detail: { operation: 'draw' },
      });
    }
  });
  it('preserves the current draw owner failure instead of masking it with a submit contract error', () => {
    let publish: RendererHostEventListener | undefined;
    let reportCause = true;
    const cause = new RhiError({
      code: 'rhi-not-available',
      expected: 'the current frame owner can record its resource',
      hint: 'inspect the failing resource owner',
    });
    const host = {
      inspect: () => ({ state: 'alive' }),
      subscribeHostEvents: (listener: RendererHostEventListener) => {
        publish = listener;
        return () => {
          publish = undefined;
        };
      },
      drawFrame: () => {
        if (reportCause) publish?.({ kind: 'error', error: cause });
        return err(new RendererContractFailureError('draw', 'no command buffer was submitted'));
      },
    } as unknown as RendererHostImplementation;
    const renderer = exposeRenderer(host);
    const failed = renderer.draw({} as never);
    expect(failed.ok).toBe(false);
    if (failed.ok || failed.error.code !== 'device-operation-failed')
      throw new Error('draw must fail');
    expect(failed.error.detail.cause.code).toBe('rhi-not-available');
    expect(failed.error.detail.cause.hint).toBe(cause.hint);
    reportCause = false;
    const next = renderer.draw({} as never);
    expect(next.ok).toBe(false);
    if (next.ok || next.error.code !== 'device-operation-failed') throw new Error('draw must fail');
    expect(next.error.detail.cause.code).toBe('renderer-contract-failed');
  });

  it('blocks geometry operations for a host-faulted World before reaching the owner', () => {
    const world = new World();
    const fault = new DynamicGeometryError(
      'dynamic-geometry-invalid',
      'the attached World remains healthy after geometry admission',
      'rebuild the paired World and Renderer',
    );
    const prepare = vi.fn();
    const accept = vi.fn();
    const acceptBatch = vi.fn();
    const cancel = vi.fn();
    const retire = vi.fn();
    const host = {
      inspect: () => ({ state: 'alive' }),
      subscribeHostEvents: () => () => undefined,
      dynamicGeometryFault: (candidateWorld: World) =>
        candidateWorld === world ? fault : undefined,
      prepareDynamicGeometry: prepare,
      acceptDynamicGeometry: accept,
      acceptDynamicGeometryCandidates: acceptBatch,
      dynamicGeometryReceipt: vi.fn(),
      cancelDynamicGeometry: cancel,
      retireDynamicGeometry: retire,
    } as unknown as RendererHostImplementation;
    const renderer = exposeRenderer(host);
    const input = { world } as never;
    const candidate = { world } as never;

    expect(renderer.prepareDynamicGeometry(input)).toMatchObject({ ok: false, error: fault });
    expect(renderer.acceptDynamicGeometry(candidate, { world, fixedStep: 0 })).toMatchObject({
      ok: false,
      error: fault,
    });
    expect(
      renderer.acceptDynamicGeometryCandidates([candidate], { world, fixedStep: 0 }),
    ).toMatchObject({
      ok: false,
      error: fault,
    });
    expect(renderer.dynamicGeometryReceipt(candidate)).toBeUndefined();
    expect(renderer.cancelDynamicGeometry(candidate)).toMatchObject({ ok: false, error: fault });
    expect(renderer.retireDynamicGeometry(candidate)).toMatchObject({ ok: false, error: fault });
    expect(prepare).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
    expect(acceptBatch).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
  });
});

it('reads the current device owner without materializing full diagnostics', () => {
  let generation = 7;
  const inspect = vi.fn(() => ({ state: 'alive', frame: { deviceGeneration: generation } }));
  const host = {
    inspect,
    currentDeviceGeneration: () => generation,
    subscribeHostEvents: () => () => undefined,
  } as unknown as RendererHostImplementation;
  const renderer = exposeRenderer(host);
  inspect.mockClear();
  expect(renderer.currentDeviceGeneration?.()).toBe(7);
  generation = 8;
  expect(renderer.currentDeviceGeneration?.()).toBe(8);
  expect(inspect).not.toHaveBeenCalled();
});

it('preserves the generation path for older injected hosts', () => {
  let generation = 7;
  const host = {
    inspect: () => ({ state: 'alive', frame: { deviceGeneration: generation } }),
    subscribeHostEvents: () => () => undefined,
  } as unknown as RendererHostImplementation;
  const renderer = exposeRenderer(host);
  expect(renderer.currentDeviceGeneration?.()).toBe(7);
  generation = 8;
  expect(renderer.currentDeviceGeneration?.()).toBe(8);
});
