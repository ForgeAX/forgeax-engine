import { defineComponent, World } from '@forgeax/engine-ecs';
import { createStateProjection, StateProjectionExpiredError } from '@forgeax/engine-ecs/projection';
import { RenderGraphError } from '@forgeax/engine-render-graph';
import { err } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type {
  RendererHostEventListener,
  RendererHostImplementation,
} from '../assembly/host-contract';
import { exposeRenderer } from '../assembly/renderer-facade';
import { RendererContractFailureError } from '../errors/render';
import { runtimeFailureDetails } from '../errors/runtime-failure-details';
import { recordFailureError } from '../render-system-record-attempt';

describe('renderer failure details', () => {
  it.each([
    'result',
    'event',
  ] as const)('preserves a real expired World projection through the %s draw failure path', (path) => {
    const component = defineComponent('FailureProjectionSource', {});
    const world = new World();
    const candidate = createStateProjection(world, [component]).read();
    world.spawn({ component, data: {} }).unwrap();
    let failure: unknown;
    try {
      candidate.validate();
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(StateProjectionExpiredError);
    const expired = failure as StateProjectionExpiredError;
    const wrapped = recordFailureError(expired);
    let listener: RendererHostEventListener | undefined;
    const host = {
      inspect: () => ({ state: 'alive' }),
      subscribeHostEvents: (next: RendererHostEventListener) => {
        listener = next;
        return () => undefined;
      },
      drawFrame: () => {
        if (path === 'result') return err(wrapped);
        listener?.({ kind: 'error', error: wrapped });
        return err(new RendererContractFailureError('draw', 'no command buffer was submitted'));
      },
    } as unknown as RendererHostImplementation;
    const renderer = exposeRenderer(host);

    expect(renderer.draw({} as never)).toMatchObject({
      ok: false,
      error: {
        code: 'scene-projection-failed',
        detail: {
          operation: 'draw',
          cause: {
            code: expired.code,
            expected: expired.expected,
            hint: expired.hint,
          },
        },
      },
    });
    expect(() => candidate.accept()).toThrow(StateProjectionExpiredError);
  });

  it('keeps an unstructured recording exception a device operation failure', () => {
    const host = {
      inspect: () => ({ state: 'alive' }),
      subscribeHostEvents: () => () => undefined,
      drawFrame: () => err(recordFailureError(new Error('unstructured record failure'))),
    } as unknown as RendererHostImplementation;

    expect(exposeRenderer(host).draw({} as never)).toMatchObject({
      ok: false,
      error: {
        code: 'device-operation-failed',
        detail: {
          cause: {
            code: 'webgpu-runtime-error',
            detail: { error: { code: 'unknown', message: 'unstructured record failure' } },
          },
        },
      },
    });
  });

  it('preserves the pass-owned cause behind a RenderGraphError', () => {
    const cause = new Error('GPUValidationError: sampled texture limit exceeded');
    const failure = new RenderGraphError({
      code: 'pass-encode-failed',
      expected: "pass 'reflection-probe.0.capture.0' encodes without throwing",
      hint: 'inspect detail.cause and repair the pass-owned RHI command',
      detail: {
        passName: 'reflection-probe.0.capture.0',
        passKind: 'raster',
        cause,
      },
    });

    expect(runtimeFailureDetails(failure)).toEqual({
      code: 'pass-encode-failed',
      message: failure.message,
      name: 'RenderGraphError',
      expected: failure.expected,
      hint: failure.hint,
      detail: failure.detail,
    });
    expect(recordFailureError(failure).detail).toEqual({ error: runtimeFailureDetails(failure) });
  });
});
