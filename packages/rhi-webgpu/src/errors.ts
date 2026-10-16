// @forgeax/engine-rhi-webgpu/src/errors — RhiError factory functions.
//
// Source of truth for the .expected / .hint copy: plan-strategy 7.3 error-info
// table. After feat-20260508-rhi-surface-completion w7 (D-S3) the surface
// covers 8 factories: 4 device/shader paths (Round 1) + 4 command/queue paths
// (this closure: command-encoder-finished / render-pass-not-ended /
// queue-submit-failed / queue-write-buffer-out-of-bounds).
//
// Each .expected / .hint string aligns one-to-one with requirements boundary
// cases + plan-strategy 7.3 (charter proposition 3: machine-readable hint
// over prose).

import { err, type Result, RhiError, type RhiShaderCompileDetail } from '@forgeax/engine-rhi';

/** adapter null path (research F-5 single null channel). */
export function adapterUnavailable(): Result<never, RhiError> {
  return err(
    new RhiError({
      code: 'adapter-unavailable',
      expected: 'an available browser-native WebGPU adapter',
      hint: 'this only reports the browser-native WebGPU channel; ForgeaX may continue through its wgpu/WebGL2 fallback, so do not conclude that the browser or machine is unsupported unless both backend causes fail',
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
      hint: 'inspect detail.error before assigning the failure to WebGPU capability; the ForgeaX runtime can still attempt its wgpu/WebGL2 fallback',
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

/** limit exceeded path (boundary cases / requirements). */
export function limitExceeded(limitName?: string | undefined): Result<never, RhiError> {
  const lname = limitName ?? 'maxBindGroups';
  return err(
    new RhiError({
      code: 'limit-exceeded',
      expected: `${lname} to be within bounds`,
      hint: `verify device.limits.${lname}`,
    }),
  );
}

/** shader compile failed path + detail.compilerMessages forwarding (OQ-P2 6 fields). */
export function shaderCompileFailed(
  compilerMessages: readonly GPUCompilationMessage[],
): Result<never, RhiError> {
  const detail: RhiShaderCompileDetail = { compilerMessages };
  return err(
    new RhiError({
      code: 'shader-compile-failed',
      expected: 'valid WGSL source',
      hint: 'inspect RhiError.detail.compilerMessages (each entry: { message, type, lineNum, linePos, offset, length } per WebGPU GPUCompilationMessage shape)',
      detail,
    }),
  );
}

/**
 * Command encoder reused after finish() (W3C WebGPU 22 GPUCommandEncoder lifecycle).
 *
 * Trigger: encoder.beginRenderPass / copyXxx / finish called after a prior finish().
 * Distinct from 'rhi-not-available': this is a real-path validation failure,
 * not a placeholder for unimplemented surface (plan-strategy D-S3 template 1).
 */
export function commandEncoderFinished(): Result<never, RhiError> {
  return err(
    new RhiError({
      code: 'command-encoder-finished',
      expected: 'command encoder must not be finished before recording new commands',
      hint: 'create a new command encoder via device.createCommandEncoder() for each frame; do not reuse a finished encoder',
    }),
  );
}

/**
 * Render pass not ended before next pass / finish (W3C WebGPU 22.7 Render pass).
 *
 * Trigger: encoder.beginRenderPass while previous pass active, or encoder.finish
 * with active pass still recording (plan-strategy D-S3 template 2).
 */
export function renderPassNotEnded(): Result<never, RhiError> {
  return err(
    new RhiError({
      code: 'render-pass-not-ended',
      expected:
        'previous render pass must be ended before beginning a new pass or finishing the encoder',
      hint: 'call pass.end() before beginRenderPass() or encoder.finish()',
    }),
  );
}

/**
 * Queue.submit real-path failure (W3C WebGPU 23 Queue).
 *
 * Trigger: submit([cb]) with destroyed buffer/pipeline references, or GPU validation
 * error fan-out via onuncapturederror. Explicitly distinct from 'rhi-not-available'
 * (device-lost subclass) - submit-failed signals dynamic resource life-cycle issues
 * the AI user can self-recover from (plan-strategy D-S3 template 3).
 */
export function queueSubmitFailed(detailMessage?: string | undefined): Result<never, RhiError> {
  const baseHint =
    'check if any referenced buffer / pipeline / texture has been destroyed before submit';
  const hint =
    detailMessage !== undefined && detailMessage.length > 0
      ? `${baseHint}; underlying GPU error: ${detailMessage}`
      : baseHint;
  return err(
    new RhiError({
      code: 'queue-submit-failed',
      expected:
        'command buffer references must be valid at submit time (not destroyed; not from a different device)',
      hint,
    }),
  );
}

/**
 * Queue.writeBuffer offset/size out of bounds (W3C WebGPU 23.2 writeBuffer).
 *
 * Trigger: writeBuffer(buf, offset, data) where offset is not 4-byte aligned, or
 * offset + data.byteLength exceeds buffer.size. Distinct from 'limit-exceeded'
 * (static device.limits) - out-of-bounds is a dynamic per-buffer boundary
 * (plan-strategy D-S3 template 4).
 */
export function queueWriteBufferOutOfBounds(args: {
  offset: number;
  byteLength: number;
  bufferSize: number;
}): Result<never, RhiError> {
  return err(
    new RhiError({
      code: 'queue-write-buffer-out-of-bounds',
      expected:
        'writeBuffer offset + data.byteLength must be <= buffer.size; offset must be 4-byte aligned',
      hint: `verify offset alignment and bounds: offset (got ${args.offset}) + data.byteLength (got ${args.byteLength}) must be <= buffer.size (got ${args.bufferSize})`,
    }),
  );
}
