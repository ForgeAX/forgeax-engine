import { join } from 'node:path';
import { expect, onTestFailed, onTestFinished, vi } from 'vitest';
import type { DawnOriginalFrameCapture } from './original-frame-capture';

const captureState = vi.hoisted(() => ({
  owners: new WeakMap<object, DawnOriginalFrameCapture>(),
}));

async function prepareRecorder() {
  try {
    const [{ attachRecorder }, webgpu, { ok }] = await Promise.all([
      import('@forgeax/engine-rhi-debug'),
      import('@forgeax/engine-rhi-webgpu'),
      import('@forgeax/engine-types'),
    ]);
    const attached = attachRecorder(webgpu);
    if (!attached.ok) throw attached.error;
    return { recorder: attached.value, ok };
  } catch (error) {
    console.warn('[original-frame] recorder unavailable', error);
    return undefined;
  }
}

vi.mock('@forgeax/engine-runtime/internal/renderer-host', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@forgeax/engine-runtime/internal/renderer-host')>();
  const { selectsDawnCapture, DawnOriginalFrameCapture } = await import('./original-frame-capture');
  if (!selectsDawnCapture(process.env.FORGEAX_DAWN_CAPTURE_TEST, expect.getState().testPath))
    return actual;
  return {
    ...actual,
    constructRuntimeRendererHost: async (
      ...args: Parameters<typeof actual.constructRuntimeRendererHost>
    ) => {
      const [canvas, options, bundler] = args;
      if (
        options?.rhi !== undefined ||
        options?.rhiInstrumentation?.resolveSurfaceDevice !== undefined ||
        (options?.renderBackend !== undefined &&
          options.renderBackend !== 'auto' &&
          options.renderBackend !== 'webgpu')
      ) {
        console.warn(
          '[original-frame] capture unavailable: constructor has an explicit backend or surface resolver',
        );
        return actual.constructRuntimeRendererHost(...args);
      }
      const recording = await prepareRecorder();
      if (recording === undefined) return actual.constructRuntimeRendererHost(...args);
      const { recorder, ok } = recording;
      let created: Awaited<ReturnType<typeof actual.constructRuntimeRendererHost>>;
      try {
        created = await actual.constructRuntimeRendererHost(
          canvas,
          {
            ...options,
            rhi: recorder.backend.rhi,
            rhiInstrumentation: {
              ...options?.rhiInstrumentation,
              resolveSurfaceDevice: (device) =>
                ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
            },
          },
          bundler,
        );
      } catch (cause) {
        try {
          await recorder.dispose();
        } catch (error) {
          console.error('[original-frame] recorder cleanup failed', error);
        }
        throw cause;
      }
      if (!created.ok) {
        try {
          await recorder.dispose();
        } catch (error) {
          console.error('[original-frame] recorder cleanup failed', error);
        }
        return created;
      }
      const owner = new DawnOriginalFrameCapture(
        recorder,
        () => created.value.renderer.inspect(),
        join(process.cwd(), 'artifacts/modeling-show/dawn/original-frame'),
      );
      captureState.owners.set(created.value.renderer, owner);
      onTestFailed(async (context) => {
        try {
          owner.failed(context.task.result?.errors);
          await owner.writeFailure();
        } catch (error) {
          console.error('[original-frame] evidence write failed', error);
        }
      });
      onTestFinished(async () => {
        try {
          await owner.dispose();
        } catch (error) {
          console.error('[original-frame] recorder disposal failed', error);
        }
      });
      return created;
    },
  };
});

vi.mock('../scripts/test/ready-render-frame.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/test/ready-render-frame.mjs')>();
  const { selectsDawnCapture } = await import('./original-frame-capture');
  if (!selectsDawnCapture(process.env.FORGEAX_DAWN_CAPTURE_TEST, expect.getState().testPath))
    return actual;
  return {
    ...actual,
    drawReadyFrame: (...args: Parameters<typeof actual.drawReadyFrame>) => {
      const [renderer, request, observation, options] = args;
      const owner = captureState.owners.get(renderer);
      if (owner === undefined) return actual.drawReadyFrame(...args);
      return actual
        .drawReadyFrame(renderer, request, observation, {
          ...options,
          beforeSubmit: async (context) => {
            await options?.beforeSubmit?.(context);
            await owner.beforeSubmit();
          },
          afterSubmit: (receipt, context) => {
            owner.afterSubmit(receipt);
            return options?.afterSubmit?.(receipt, context);
          },
        })
        .catch((cause: unknown) => {
          owner.failed(cause);
          throw cause;
        });
    },
  };
});
