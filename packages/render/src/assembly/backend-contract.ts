import type {
  RenderPipeline,
  Result,
  RhiCanvasContext,
  RhiCanvasTarget,
  RhiDevice,
  RhiError,
  RhiInstance,
  ShaderModule,
} from '@forgeax/engine-rhi';

/** Optional host hooks for recorder and device-lifecycle capabilities. */
export interface RhiBackendInstrumentation {
  /** Pure recorder query; never registers an unknown opaque resource. */
  readonly resolvePipelineReference?: (
    device: RhiDevice,
    pipeline: RenderPipeline,
  ) => import('../render-contract').RecordedPipelineReference | undefined;
  readonly isCaptureGenerationCurrent?: (generation: number) => boolean;
  readonly resolveSurfaceDevice?: (device: RhiDevice) => Result<RhiDevice, RhiError>;
  /**
   * Optional deterministic submit fault seam for backend-owned integration
   * fixtures. The callback runs after `finish()` and before the queue submit;
   * returning an error aborts the frame transaction without changing the
   * production queue contract.
   */
  readonly beforeSubmit?: (device: RhiDevice) => RhiError | undefined;
  /**
   * Optional device-loss projection for deterministic recovery fixtures. A
   * backend may compose this promise with its native `device.lost` promise;
   * normal production packs leave it undefined and use the native signal.
   */
  readonly deviceLost?: (device: RhiDevice) => RhiDevice['lost'];
  readonly onFrameBoundary?: () => void;
  readonly onDeviceLost?: () => void;
}

/** Runtime-owned backend services injected into the render assembly. */
export interface RhiBackendPack {
  readonly rhi: RhiInstance & {
    readonly acquireCanvasContext: (canvas: RhiCanvasTarget) => Result<RhiCanvasContext, RhiError>;
  };
  readonly createShaderModule?: (
    device: RhiDevice,
    desc: { code: string; label?: string | undefined },
  ) => Promise<Result<ShaderModule, RhiError>>;
  /**
   * Internal render-path fast path. WebGPU creates a shader module
   * synchronously and reports WGSL diagnostics through the async
   * `createShaderModule` entry; waiting for `getCompilationInfo()` here would
   * serialize every first-use material behind a slow software adapter. The
   * render assembly still validates the module when it builds the pipeline,
   * while public callers retain the diagnostic-rich async entry above.
   */
  readonly createShaderModuleImmediate?: (
    device: RhiDevice,
    desc: { code: string; label?: string | undefined },
  ) => Result<ShaderModule, RhiError>;
  readonly translateErrorEventToRhiError?: (event: unknown) => {
    readonly ok: false;
    readonly error: RhiError;
  };
  /** Terminally release a device generation acquired by the render host. */
  readonly disposeDevice?: (device: RhiDevice) => void;
  /** @internal */
  readonly _internal_getRawDevice?: (device: RhiDevice) => unknown | undefined;
  /** Optional lifecycle hooks owned by the host capability being injected. */
  readonly instrumentation?: RhiBackendInstrumentation;
}

/** Project a backend module into the Render-owned injected pack contract. */
export function loadRhiPack(
  mod: Record<string, unknown>,
  instrumentation?: RhiBackendPack['instrumentation'],
): RhiBackendPack {
  const rhi = mod.rhi as unknown as RhiBackendPack['rhi'];
  const createShaderModule = mod.createShaderModule as
    | RhiBackendPack['createShaderModule']
    | undefined;
  const createShaderModuleImmediate = mod.createShaderModuleImmediate as
    | RhiBackendPack['createShaderModuleImmediate']
    | undefined;
  const translateErrorEventToRhiError = mod.translateErrorEventToRhiError as
    | RhiBackendPack['translateErrorEventToRhiError']
    | undefined;
  const disposeDevice = mod.disposeDevice as RhiBackendPack['disposeDevice'] | undefined;
  const backendHandleAccessor = mod._internal_getRawDevice as unknown as
    | RhiBackendPack['_internal_getRawDevice']
    | undefined;
  return {
    rhi,
    ...(createShaderModule === undefined ? {} : { createShaderModule }),
    ...(createShaderModuleImmediate === undefined ? {} : { createShaderModuleImmediate }),
    ...(translateErrorEventToRhiError === undefined ? {} : { translateErrorEventToRhiError }),
    ...(disposeDevice === undefined ? {} : { disposeDevice }),
    ...(backendHandleAccessor === undefined
      ? {}
      : { _internal_getRawDevice: backendHandleAccessor }),
    ...(instrumentation === undefined ? {} : { instrumentation }),
  };
}

export interface EngineEnvironmentErrorDetail {
  readonly webgpuError?: RhiError | Error | undefined;
  readonly wgpuError?: RhiError | Error | undefined;
}

function describeEnvironmentCause(cause: RhiError | Error | undefined): string | undefined {
  if (cause === undefined) return undefined;
  const candidate = cause as unknown as {
    readonly code?: unknown;
    readonly expected?: unknown;
    readonly hint?: unknown;
    readonly detail?: unknown;
  };
  const code = typeof candidate.code === 'string' ? candidate.code : undefined;
  const expected = typeof candidate.expected === 'string' ? candidate.expected : undefined;
  const hint = typeof candidate.hint === 'string' ? candidate.hint : undefined;
  const detail = candidate.detail;
  if (typeof detail === 'object' && detail !== null && 'compilerMessages' in detail) {
    const messages = (detail as { readonly compilerMessages?: unknown }).compilerMessages;
    if (Array.isArray(messages)) {
      const text = messages
        .map((message) => {
          const value = message as { readonly message?: unknown };
          return typeof value.message === 'string' ? value.message : undefined;
        })
        .filter((message): message is string => message !== undefined)
        .join(' | ');
      if (text.length > 0) {
        return `${code ?? cause.name}: ${expected ?? cause.message}; ${hint ?? ''} compilerMessages=${text}`;
      }
    }
  }
  if (code === undefined) return cause.message;
  return `${code}: ${expected ?? cause.message}; ${hint ?? ''}`.trimEnd();
}

export class EngineEnvironmentError extends Error {
  readonly reason: string;
  readonly webgpuError?: RhiError | Error | undefined;
  readonly wgpuError?: RhiError | Error | undefined;
  readonly detail: EngineEnvironmentErrorDetail;

  constructor(reason: string, detail: EngineEnvironmentErrorDetail = {}) {
    const cause = describeEnvironmentCause(detail.webgpuError ?? detail.wgpuError);
    super(
      `forgeax-engine: no usable backend (${reason}${cause === undefined ? '' : `; cause=${cause}`})`,
    );
    this.name = 'EngineEnvironmentError';
    this.reason = reason;
    this.webgpuError = detail.webgpuError;
    this.wgpuError = detail.wgpuError;
    this.detail = detail;
  }
}
