import type { Result, RhiCanvasContext, RhiDevice } from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { RhiErrorListenerRegistry } from '../lifecycle';
import type { OutputColorSpaceState } from '../output-color-space';
import type { PipelineSpecError } from '../pipeline-spec';
import { configurePipelineSurface, type PipelineState } from '../record/render-context';
import type { HealthSnapshot } from '../render-contract';

/** Minimum device-bound surface contract needed by lazy context configuration. */
interface RendererSurfaceInternals {
  readonly device: RhiDevice;
  readonly context: RhiCanvasContext;
  /** Output colour-space negotiation refreshed by every surface configure. */
  readonly outputColorSpace?: OutputColorSpaceState | undefined;
  readonly pack: {
    readonly instrumentation?: {
      readonly resolveSurfaceDevice?: (device: RhiDevice) => Result<RhiDevice, RhiError>;
    };
  };
}

export function wrapDisposeError(cause: unknown, step: string): RhiError {
  if (cause instanceof RhiError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new RhiError({
    code: 'webgpu-runtime-error',
    expected: `${step} completes during Renderer.dispose() without throwing`,
    hint: `dispose sub-step '${step}' threw: ${message}; cascade continues to subsequent steps`,
  });
}

export function rendererInitializationPipelineError(error: PipelineSpecError): RhiError {
  return new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'Renderer.initialization three-step strict-serial succeeds',
    hint: 'inspect detail.error for the underlying PipelineSpecError and GPU cause',
    detail: {
      error: {
        name: error.name,
        code: error.code,
        message: error.message,
        detail: error.detail,
      },
    },
  });
}

export function rendererInitializationError(cause: unknown): RhiError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'Renderer.initialization three-step strict-serial succeeds',
    hint: `pipeline build raised: ${message}`,
  });
}

/**
 * The device loss behind a failed renderer initialization, when a caller may
 * treat it as an environment failure and assemble another backend. A native
 * loss (`unknown`) is reported as `device-lost`. A disposed renderer or a
 * device its owner destroyed is not a device loss.
 */
export function initializationDeviceLoss(
  cause: unknown,
  health: HealthSnapshot,
  disposed: boolean,
): RhiError | undefined {
  if (disposed) return undefined;
  if (health.reason === 'device-lost')
    return health.detail.lostReason === 'destroyed'
      ? undefined
      : new RhiError({
          code: 'device-lost',
          expected: 'device must remain alive during renderer initialization',
          hint: `the GPU device was lost while the renderer prepared its scene (${health.detail.message || '<empty>'}); interrupted step: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
  return cause instanceof RhiError && cause.code === 'device-lost' ? cause : undefined;
}

export function ensureContextConfigured(
  internals: RendererSurfaceInternals,
  state: PipelineState,
  errorRegistry: RhiErrorListenerRegistry,
  context: RhiCanvasContext = internals.context,
  device: RhiDevice = internals.device,
): Result<void, RhiError> {
  if (state.perPassResources.configured) return ok(undefined);
  const configuredDevice = internals.pack.instrumentation?.resolveSurfaceDevice?.(device);
  if (configuredDevice !== undefined && !configuredDevice.ok) {
    errorRegistry.fire(configuredDevice.error);
    return err(configuredDevice.error);
  }
  const configured = configurePipelineSurface(
    context,
    configuredDevice?.value ?? device,
    state,
    internals.outputColorSpace,
  );
  if (!configured.ok) errorRegistry.fire(configured.error);
  return configured;
}

export function runShimSyncStep<T>(
  fn: () => Result<T, RhiError>,
  fallbackCode:
    | 'shader-compile-failed'
    | 'webgpu-runtime-error'
    | 'queue-write-buffer-out-of-bounds',
  expected: string,
  hint: string,
): Result<T, RhiError> {
  try {
    return fn();
  } catch (caught) {
    if (caught instanceof RhiError) return err(caught);
    const detail = caught instanceof Error ? caught.message : String(caught);
    return err(
      new RhiError({
        code: fallbackCode,
        expected,
        hint: `${hint} (cause: ${detail})`,
      }),
    );
  }
}

export async function runShimStep<T>(
  fn: () => Promise<Result<T, RhiError>>,
  fallbackCode: 'shader-compile-failed' | 'webgpu-runtime-error',
  expected: string,
  hint: string,
): Promise<Result<T, RhiError>> {
  try {
    return await fn();
  } catch (caught) {
    if (caught instanceof RhiError) return err(caught);
    const detail = caught instanceof Error ? caught.message : String(caught);
    return err(
      new RhiError({
        code: fallbackCode,
        expected,
        hint: `${hint} (cause: ${detail})`,
      }),
    );
  }
}
