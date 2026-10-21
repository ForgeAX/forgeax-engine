// rhi-wgpu adapter availability and native runtime failures.

import { err, type Result, RhiError } from '@forgeax/engine-rhi';

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
function featureNotEnabledError(featureName?: string | undefined): RhiError {
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
