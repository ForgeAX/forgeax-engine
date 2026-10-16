// @forgeax/engine-naga/errors — build-time ShaderError factories + wrapShaderError.
//
// The ShaderError class, its runtime factories (manifestMalformed /
// shaderNotFound) and the closed ShaderErrorCode / ShaderErrorDetail unions have
// one owner each: the class in @forgeax/engine-shader, the unions in
// @forgeax/engine-types. This file adds only the build-time failure paths of the
// Naga WASM boundary (compileFailed / initFailed) and the JsError -> ShaderError
// adapter used by parse / validate / emit_reflection in index.ts. Sharing one
// class keeps `instanceof ShaderError` true across build and runtime callers.

/// <reference types="@webgpu/types" />

import { ShaderError } from '@forgeax/engine-shader';

export { ShaderError, type ShaderErrorCode, type ShaderErrorDetail } from '@forgeax/engine-shader';

// === build-time factory helpers =====================================================

/** `shader-compile-failed`: naga parse_str or Validator::validate failure. */
export function compileFailed(args: {
  readonly message: string;
  readonly hint: string;
  readonly lineNum?: number | undefined;
  readonly linePos?: number | undefined;
  readonly compilerMessages?: readonly GPUCompilationMessage[] | undefined;
  readonly reason?: string | undefined;
}): ShaderError {
  return new ShaderError({
    code: 'shader-compile-failed',
    expected: 'WGSL source parses + validates against naga IR',
    message: args.message,
    hint: args.hint,
    ...(args.lineNum !== undefined ? { lineNum: args.lineNum } : {}),
    ...(args.linePos !== undefined ? { linePos: args.linePos } : {}),
    ...(args.compilerMessages !== undefined
      ? {
          detail: {
            code: 'shader-compile-failed',
            compilerMessages: args.compilerMessages,
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
          },
        }
      : {}),
  });
}

/** `compiler-init-failed`: wasm loading or init() failure (cold start / missing wasm artifact). */
export function initFailed(args: {
  readonly message: string;
  readonly hint: string;
  readonly reason?: string | undefined;
}): ShaderError {
  return new ShaderError({
    code: 'compiler-init-failed',
    expected: '@forgeax/engine-wgpu-wasm ensureReady() resolves with naga raw bindings available',
    message: args.message,
    hint: args.hint,
    detail: {
      code: 'compiler-init-failed',
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    },
  });
}

// === wrapShaderError: JsError -> ShaderError adapter ================================

/**
 * Translate a thrown wasm-bindgen JsError to a structured ShaderError.
 *
 * The Rust side serializes `ParseErrorPayload { message, summary, line_num,
 * line_pos }` to a JSON string and uses it as the JsError message. We attempt
 * JSON.parse first; on success the lineNum/linePos are extracted as top-level
 * surface fields (MVP-2.3). On failure (validator errors, reflection errors,
 * non-JSON messages) we fall back to the prose message — hint is always
 * populated so AI consumers always have an actionable recovery signal
 * (charter proposition 4 explicit failure + proposition 3 machine-readable hint).
 */
export function wrapShaderError(e: unknown, hint?: string): ShaderError {
  if (e instanceof Error) {
    try {
      const payload = JSON.parse(e.message) as {
        message?: string;
        summary?: string;
        line_num?: number | null;
        line_pos?: number | null;
      };
      return compileFailed({
        message: payload.summary ?? payload.message ?? e.message,
        hint:
          hint ??
          'fix the WGSL source at the indicated line/column; see ShaderError.detail.compilerMessages for full diagnostic frame',
        ...(typeof payload.line_num === 'number' ? { lineNum: payload.line_num } : {}),
        ...(typeof payload.line_pos === 'number' ? { linePos: payload.line_pos } : {}),
      });
    } catch {
      return compileFailed({
        message: e.message,
        hint: hint ?? 'check WGSL syntax + validation rules; consult naga error output for details',
      });
    }
  }
  return compileFailed({
    message: String(e),
    hint:
      hint ??
      'unknown error type from @forgeax/engine-wgpu-wasm; report as @forgeax/engine-naga bug',
  });
}

// === Result<T, E> ====================================================================
//
// Result<T, E> + ok / err + ResultOk / ResultErr live in `@forgeax/engine-types`
// (tweak-20260612-result-into-types). They were duplicated here as a lite
// (plain-object, no `unwrap`) variant; consolidated upstream into the same
// shape used by rhi / ecs. The barrel here re-exports them so existing
// `import { err, ok, Result, ResultOk, ResultErr } from '@forgeax/engine-naga'`
// consumers stay unchanged.
export {
  err,
  ok,
  type Result,
  type ResultErr,
  type ResultOk,
} from '@forgeax/engine-types';
