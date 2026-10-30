// rhi-webgpu adapter availability and native runtime failures.

import { err, type Result, RhiError } from '@forgeax/engine-rhi';

/** adapter null path (research F-5 single null channel). */
export function adapterUnavailable(): Result<never, RhiError> {
  return err(
    new RhiError({
      code: 'adapter-unavailable',
      expected: 'an available browser-native WebGPU adapter',
      hint: 'this only reports the browser-native WebGPU channel; ForgeAX may continue through its wgpu/WebGL2 fallback, so do not conclude that the browser or machine is unsupported unless both backend causes fail',
    }),
  );
}

/** `GPU.requestAdapter()` rejected instead of reporting adapter absence with `null`. */
export function requestAdapterFailed(cause: unknown): Result<never, RhiError> {
  const record =
    cause !== null && typeof cause === 'object'
      ? (cause as { readonly name?: unknown; readonly message?: unknown })
      : undefined;
  const name = typeof record?.name === 'string' && record.name.length > 0 ? record.name : undefined;
  let message =
    typeof record?.message === 'string' && record.message.length > 0
      ? record.message
      : typeof cause === 'string'
        ? cause
        : '';
  if (message.length === 0 && cause !== undefined) {
    try {
      const serialized = JSON.stringify(cause);
      message = serialized && serialized !== '{}' ? serialized : 'unknown thrown object';
    } catch {
      message = 'unserializable thrown object';
    }
  }
  if (message.length === 0) message = 'unknown requestAdapter failure';
  return err(
    new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'navigator.gpu.requestAdapter() resolves with an adapter or null',
      hint: 'inspect detail.error before assigning the failure to WebGPU capability; the ForgeAX runtime can still attempt its wgpu/WebGL2 fallback',
      detail: {
        error: {
          code: 'request-adapter-threw',
          ...(name === undefined ? {} : { name }),
          message,
        },
      },
    }),
  );
}

/** feature not enabled path (boundary cases / requirements). */
export function featureNotEnabled(featureName?: string | undefined): Result<never, RhiError> {
  const fname = featureName ?? 'compute';
  return err(
    new RhiError({
      code: 'feature-not-enabled',
      expected: `feature ${fname} to be enabled`,
      hint: `verify device.features.${fname} before calling this entry point`,
    }),
  );
}
