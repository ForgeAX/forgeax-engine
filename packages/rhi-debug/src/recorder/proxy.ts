import type {
  RhiCanvasContext,
  RhiCanvasTarget,
  RhiDevice,
  RhiError,
  RhiInstance,
} from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import {
  type CreateShaderModuleFn,
  type CreateShaderModuleImmediateFn,
  type DebugRhiInstance,
  recorderDeviceIdentity,
} from './core';
import { wrapCreateShaderModule, wrapCreateShaderModuleImmediate } from './shader';
import { wrap } from './wrap';

export interface RecordableBackend {
  readonly rhi: RhiInstance & {
    readonly acquireCanvasContext?: (canvas: RhiCanvasTarget) => Result<RhiCanvasContext, RhiError>;
  };
  readonly createShaderModule: CreateShaderModuleFn;
  /** Optional synchronous factory retained for render's first-use path. */
  readonly createShaderModuleImmediate?: CreateShaderModuleImmediateFn;
}

export interface RecorderBackend extends RecordableBackend {
  /** Native surfaces need raw identity; structural Null surfaces retain recorded factories. */
  readonly unwrapDeviceForSurface: (device: RhiDevice) => Result<RhiDevice, RhiDebugError>;
}

export interface RecorderProxy {
  readonly backend: RecorderBackend;
  readonly recorder: DebugRhiInstance;
}

export function createRecorderProxy(backend: RecordableBackend): RecorderProxy {
  const recorder = wrap(backend.rhi);
  const wrappedCreateShaderModule = wrapCreateShaderModule(backend.createShaderModule, recorder);
  const originalCreateShaderModuleImmediate = backend.createShaderModuleImmediate;
  const wrappedCreateShaderModuleImmediate =
    originalCreateShaderModuleImmediate === undefined
      ? undefined
      : wrapCreateShaderModuleImmediate(originalCreateShaderModuleImmediate, recorder);
  const acquireCanvasContext = backend.rhi.acquireCanvasContext;
  const surfaceDevice = (device: RhiDevice): RhiDevice | undefined => {
    const raw = recorderDeviceIdentity(device);
    // Null's context allocates through the configured RhiDevice. Preserve the
    // recorder so its actual creation arguments and returned handles are recorded.
    // Native canvas shims instead require the backend's raw device identity.
    return raw?.caps.backendKind === 'null' ? device : raw;
  };
  // Runtime's explicit-RHI seam receives the wrapped singleton as one value.
  // Keep the standalone shader factory enumerable on that value so the
  // renderer can preserve the complete typed backend pack after capture
  // attachment; the public RhiInstance contract remains unchanged.
  const rhi: RecordableBackend['rhi'] & {
    readonly createShaderModule: CreateShaderModuleFn;
    readonly createShaderModuleImmediate?: CreateShaderModuleImmediateFn;
  } = {
    requestAdapter: recorder.requestAdapter.bind(recorder),
    createShaderModule: wrappedCreateShaderModule,
    ...(wrappedCreateShaderModuleImmediate === undefined
      ? {}
      : { createShaderModuleImmediate: wrappedCreateShaderModuleImmediate }),
    ...(acquireCanvasContext === undefined
      ? {}
      : {
          acquireCanvasContext(canvas) {
            const result = acquireCanvasContext.call(backend.rhi, canvas);
            if (!result.ok) return result;
            const context = result.value;
            // The selected backend owns configuration and resource lifetime.
            const wrapped: RhiCanvasContext = {
              ...context,
              // Native/class-backed contexts keep methods on their prototype.
              // Bind their own authority rather than losing it through spread.
              getCurrentTexture: context.getCurrentTexture.bind(context),
              unconfigure: context.unconfigure.bind(context),
              configure(configuration) {
                const device = surfaceDevice(configuration.device);
                const configured = context.configure({
                  ...configuration,
                  ...(device === undefined ? {} : { device }),
                });
                if (configured.ok) {
                  // The presented color space is what the context reports back, not
                  // what was requested: a backend without canvas color spaces drops it.
                  const reported = context.getConfiguration();
                  recorder.recordCanvasConfiguration({
                    canvasFormat: configuration.format ?? reported?.format ?? 'bgra8unorm',
                    canvasColorSpace: reported?.colorSpace === 'display-p3' ? 'display-p3' : 'srgb',
                  });
                }
                return configured;
              },
              getConfiguration: () => context.getConfiguration(),
            };
            // configure() creates this proof and unconfigure() removes it.
            // A spread snapshot loses the real surface's evolving evidence.
            Object.defineProperty(wrapped, 'supportedAlphaModes', {
              enumerable: true,
              configurable: true,
              get: () => context.supportedAlphaModes,
            });
            Object.defineProperty(wrapped, 'presentationProof', {
              configurable: true,
              enumerable: true,
              get: () => context.presentationProof,
            });
            return ok(wrapped);
          },
        }),
  };
  const wrappedBackend: RecorderBackend = {
    rhi,
    createShaderModule: wrappedCreateShaderModule,
    ...(wrappedCreateShaderModuleImmediate === undefined
      ? {}
      : { createShaderModuleImmediate: wrappedCreateShaderModuleImmediate }),
    unwrapDeviceForSurface(device) {
      const resolved = surfaceDevice(device);
      if (resolved !== undefined) return ok(resolved);
      return err(
        createRhiDebugError('capture-unavailable', {
          stage: 'capture',
          cause: 'the recorder backend does not expose a surface device resolver',
        }),
      );
    },
  };
  return { backend: wrappedBackend, recorder };
}
