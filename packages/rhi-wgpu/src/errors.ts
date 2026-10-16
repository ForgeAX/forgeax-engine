// @forgeax/engine-rhi-wgpu/src/errors — RhiError factory functions for the wgpu wasm
// shim path (w14 of feat-20260511-rhi-wgpu-impl, plan-strategy §6 M2 +
// §7.3 error-info table + AC-09 closed-union no-redefine gate).
//
// AC-09 invariant — the closed `RhiErrorCode` union is imported as a type
// from `@forgeax/engine-rhi` and NEVER re-declared / extended / locally enumerated
// here. The audit (M1) confirmed the 14-member shape carries over to the
// rhi-wgpu shim without minor additions; any future additions land in
// @forgeax/engine-rhi as the SSOT and surface here through the type import (charter
// proposition 3 machine-readable union + proposition 4 explicit failure).
//
// Hint copy alignment — each .expected / .hint string is grep-able against
// the M2 §7.3 error-info table:
//   - `'wgpu webgl backend'` lives on `feature-not-enabled` hints (so AI
//     users see the dual-backend capability gate inline).
//   - `'@forgeax/engine-rhi-wgpu wasm bundle'` lives on `rhi-not-available` hints
//     (so AI users see the lazy-load failure path inline).
// These two substrings are the w14 acceptanceCheck grep-gate anchors.

import { err, type Result, RhiError, type RhiErrorCode } from '@forgeax/engine-rhi';

/**
 * adapter null path — `navigator.gpu` exists but `requestAdapter()` resolved
 * to null, OR the wgpu webgl fallback adapter init returned null. The hint
 * spans the dual-impl AND-failure case (both paths exhausted) so AI users
 * see the unsupported-environment guidance inline (charter proposition 4 +
 * AGENTS.md `## RHI / WebGPU` dual-impl stance).
 */
export function adapterUnavailable(): Result<never, RhiError> {
  return err(
    new RhiError({
      code: 'adapter-unavailable',
      expected: 'an available WebGPU adapter (navigator.gpu OR wgpu webgl backend)',
      hint: 'navigator.gpu unavailable AND wgpu webgl backend init failed; createRenderer throws EngineEnvironmentError — display an unsupported-browser message',
    }),
  );
}

/**
 * feature not enabled path — the requested feature is not on the active
 * adapter OR the wgpu webgl backend hard-limits the feature (R-01 8-class
 * hard-limits). The hint references the `engine.rhi.caps` capability gate
 * so AI users learn the canonical pre-check pattern (charter proposition 4
 * explicit failure + capability-gated form).
 */
export function featureNotEnabledError(featureName?: string | undefined): RhiError {
  const fname = featureName ?? 'compute';
  return new RhiError({
    code: 'feature-not-enabled',
    expected: `feature ${fname} to be enabled on the active wgpu backend`,
    hint: `feature ${fname} not available on wgpu webgl backend; check engine.rhi.caps.${fname} before requesting`,
  });
}

export function featureNotEnabled(featureName?: string | undefined): Result<never, RhiError> {
  return err(featureNotEnabledError(featureName));
}

/**
 * limit exceeded path — a descriptor field exceeds the active adapter's
 * limit map. The hint references `device.limits` so AI users see the
 * canonical pre-check lookup site.
 */
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

/**
 * shader compile failed path — WGSL parsed + validated to a compile error.
 * The compilerMessages array surfaces every GPUCompilationMessage field
 * (research §F-3 / OQ-P2: 6 fields per message). The wgpu wasm side surfaces
 * the same struct through wasm-bindgen Promise; the rhi-webgpu side surfaces
 * it through getCompilationInfo(); both bottom out in this factory.
 */
export function shaderCompileFailed(
  compilerMessages: readonly GPUCompilationMessage[],
): Result<never, RhiError> {
  return err(
    new RhiError({
      code: 'shader-compile-failed',
      expected: 'valid WGSL source',
      hint: 'inspect RhiError.detail.compilerMessages (each entry: { message, type, lineNum, linePos, offset, length } per WebGPU GPUCompilationMessage shape)',
      detail: { compilerMessages },
    }),
  );
}

/**
 * rhi-not-available path — wgpu wasm bundle failed to load (network /
 * instantiate / structural error) OR the caller invoked an RHI entry before
 * `ensureReady()` settled. The hint reflects the M3 escape hatch
 * (`createRenderer(canvas, { rhi: explicitInstance })`) so AI users see the
 * opt-in injection path even when the default lazy load fails.
 *
 * Bundle size literal stays anchored to the M5 metrics baseline (0.51 MB =
 * 536512 bytes gzip per `report/rhi-wgpu/bundle-size.json` + AGENTS.md
 * `## RHI / WebGPU` dual-impl stance line 130 SSOT); w54 round 2 fix-up
 * round 1 finding F-1 closure aligned the literal across rhi-wgpu/errors.ts
 * + engine/createRenderer.ts.
 *
 * API form stays anchored to the actual entry `createRenderer(canvas,
 * options?)`. The `Engine` namespace alias (engine/index.ts) re-exports the
 * same factory under the `Engine.create` form for plan-strategy / docs
 * compatibility, so both call sites work — but the hint deliberately uses
 * the concrete factory name so users grep'ing the hint copy find the real
 * source-level entry directly (charter proposition 3 machine-readable SSOT).
 */
export function rhiNotAvailable(cause?: unknown): Result<never, RhiError> {
  const causeMessage =
    cause === undefined
      ? ''
      : cause instanceof Error
        ? `; cause: ${cause.message}`
        : `; cause: ${String(cause)}`;
  return err(
    new RhiError({
      code: 'rhi-not-available',
      expected: '@forgeax/engine-rhi-wgpu wasm bundle loaded and adapter / device handles wired up',
      hint: `failed to load @forgeax/engine-rhi-wgpu wasm bundle (0.51 MB gzip per M5 bundle-size baseline); check network connectivity or use createRenderer(canvas, { rhi: explicitInstance }) escape hatch${causeMessage}`,
    }),
  );
}

/**
 * command encoder reused after finish() — W3C WebGPU §22 GPUCommandEncoder
 * lifecycle. Mirrors the rhi-webgpu hint copy verbatim (cross-shim parity:
 * AI users see the same hint regardless of backend).
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
 * render pass not ended — W3C WebGPU §22.7. Mirrors rhi-webgpu hint copy.
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
 * queue.submit real-path failure — W3C WebGPU §23. Mirrors rhi-webgpu hint
 * copy and optionally appends the underlying error message for AI user
 * triage.
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
 * queue.writeBuffer out-of-bounds — W3C WebGPU §23.2. Mirrors rhi-webgpu hint
 * copy verbatim (cross-shim parity).
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

/**
 * webgpu-runtime-error — catch-all for wgpu wasm runtime exceptions surfaced
 * through wasm-bindgen `catch` (R-06 5 pattern). The detail forwards the raw
 * underlying error for AI user inspection (charter proposition 4 +
 * AGENTS.md `## RHI / Shader / Error model contract` detail.kind =
 * 'webgpu-runtime' tagged union member).
 */
export function webgpuRuntimeError(cause: unknown): Result<never, RhiError> {
  const errorMessage =
    cause === undefined ? 'unknown' : cause instanceof Error ? cause.message : String(cause);
  return err(
    new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'wgpu wasm runtime to complete the operation without throwing',
      // bug-20260610: surface the raw wgpu/wasm message in the hint itself —
      // previously the hint only said "inspect RhiError.detail.error" which
      // forced AI users to dig two levels deep when the message was usually
      // a one-liner like "Too many bindings of type StorageBuffers...". The
      // detail.error.message field is still populated for structured access.
      hint: `wgpu wasm runtime error: ${errorMessage} (common causes: device lost / driver crash / wasm panic; consider re-creating the device)`,
      detail: { error: { code: 'unknown', message: errorMessage } },
    }),
  );
}

/**
 * rhi-descriptor-invalid path — a create* entry descriptor failed to parse
 * in the wgpu-wasm backend. The stable prefix `[wgpu-wasm] failed to parse`
 * (D-1 contract) distinguishes descriptor parse failures from runtime
 * exceptions. Semantics: descriptor parse failure = caller bug (the caller
 * passed malformed descriptor data that the wasm deserializer rejected);
 * `.hint` carries the raw parse-error message including the failing field
 * index (e.g. `fragment.targets[0]`) for human triage. `.detail` is
 * `undefined` (D-8: index information lives in `.hint`, aligning with the
 * 15-member baseline).
 */
export function descriptorInvalid(cause: unknown): Result<never, RhiError> {
  const causeMessage =
    cause instanceof Error
      ? cause.message
      : cause === undefined
        ? 'unknown descriptor parse error'
        : String(cause);
  return err(
    new RhiError({
      code: 'rhi-descriptor-invalid',
      expected:
        'caller passed well-formed descriptor data matching the wgpu-wasm serialization contract',
      hint: `wgpu-wasm descriptor parse error: ${causeMessage} (check the descriptor field named in the error message for type mismatch or missing required fields)`,
    }),
  );
}

// AC-09 sanity: the closed union is consumed as a type-only import so it is
// erased at runtime. Each factory's `code:` literal is narrowed against
// `RhiErrorCode` by the RhiError class constructor signature; this type
// alias exercises the import inside `verbatimModuleSyntax` without retaining
// a runtime symbol (charter proposition 3 machine-readable union, AC-09
// closed-union no-redefine gate).
export type _AC_KEPT_UNION_REFERENCE = RhiErrorCode;
