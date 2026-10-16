// @forgeax/engine-vite-plugin-shader/wrap — ShaderError → RollupLog projection (w14).
//
// Form invariants (plan-strategy §S-7 / D-R7 / OQ-2 close):
// - Hint double surface: ShaderError.hint is placed at both the RollupLog top
//   level and meta.hint (charter proposition 5 consistent abstraction — AI
//   consumers read err.hint at the top level rather than parsing message prose).
// - Field alignment: lineNum/linePos forwarded via RollupLog.loc.{line, column};
//   compilerMessages forwarded via meta.detail.compilerMessages (byte-for-byte
//   aligned with RhiError.detail).
// - exactOptionalPropertyTypes: missing vs explicit-undefined strictly
//   distinguished (the 'x' in src guard).

/// <reference types="@webgpu/types" />

import type { ShaderError, ShaderErrorDetail } from '@forgeax/engine-shader-compiler';

/**
 * Extension to the Rollup `RollupLog` shape — the top-level `hint` surface is
 * an forgeax custom field (not part of the Rollup spec), preserving charter
 * proposition 5 "consistent abstraction" (runtime RhiError.hint at the top
 * level = build-time err.hint at the top level).
 *
 * Rollup spec fields (see the `RollupLog` interface in
 * `node_modules/rollup/dist/rollup.d.ts`):
 *   message / code? / id? / loc? / frame? / hook? / plugin? / pluginCode? / meta?
 *
 * forgeax extension: `hint` (top-level surface, runtime/build-time consistent).
 */
export interface ForgeaXShaderRollupLog {
  readonly code: string;
  readonly message: string;
  readonly hint: string;
  readonly expected: string;
  readonly lineNum?: number | undefined;
  readonly linePos?: number | undefined;
  readonly detail?: ShaderErrorDetail | undefined;
  readonly loc?:
    | {
        readonly line: number;
        readonly column: number;
        readonly file?: string | undefined;
      }
    | undefined;
  readonly id?: string | undefined;
  readonly meta: {
    readonly hint: string;
    readonly expected: string;
    readonly detail: {
      readonly compilerMessages?: readonly GPUCompilationMessage[] | undefined;
      readonly reason?: string | undefined;
    };
  };
}

/**
 * `ShaderError → RollupLog` projection: hint at the top level + meta.hint
 * concurrently + lineNum/linePos forwarded as loc.{line, column} +
 * compilerMessages forwarded as meta.detail.compilerMessages.
 *
 * Key constraints (plan-strategy §S-7):
 * - `err.hint` is projected to the **top level** of RollupLog — not a Rollup
 *   spec field, but PluginContext does not drop it during forwarding.
 * - `meta.hint` is also present — satisfies the Rollup spec forwarding contract.
 * - AI consumers read `err.hint` at the top level rather than parsing message
 *   prose or going through `err.meta.hint` (charter proposition 5 consistent
 *   abstraction; runtime RhiError.hint at the top level = build-time err.hint
 *   at the top level).
 */
export function toRollupLog(err: ShaderError): ForgeaXShaderRollupLog {
  const log: {
    code: string;
    message: string;
    hint: string;
    expected: string;
    lineNum?: number;
    linePos?: number;
    detail?: ShaderErrorDetail;
    loc?: { line: number; column: number };
    meta: {
      hint: string;
      expected: string;
      detail: {
        compilerMessages?: readonly GPUCompilationMessage[];
        reason?: string;
      };
    };
  } = {
    code: err.code,
    message: err.message,
    hint: err.hint, // top-level surface (forgeax custom, charter proposition 5)
    expected: err.expected,
    meta: {
      hint: err.hint, // Rollup spec forwarding contract
      expected: err.expected,
      detail: {},
    },
  };

  // exactOptionalPropertyTypes: only attach loc when both values are defined
  // (in the spirit of the research F-3 'x' in src guard).
  if (err.lineNum !== undefined && err.linePos !== undefined) {
    log.loc = { line: err.lineNum, column: err.linePos };
  }
  if (err.lineNum !== undefined) log.lineNum = err.lineNum;
  if (err.linePos !== undefined) log.linePos = err.linePos;
  if (err.detail !== undefined) log.detail = err.detail;

  // Forward detail.compilerMessages / detail.reason (byte-for-byte aligned with
  // RhiError.detail). The typed ShaderErrorDetail union narrows
  // `compilerMessages` to the `shader-compile-failed` variant and `reason` to
  // the 3 prose-bearing variants (feat-small-20260513-dx-docs-types-cleanup
  // M1-T1 / D-9 6-variant union).
  if (err.detail !== undefined) {
    if (err.detail.code === 'shader-compile-failed') {
      log.meta.detail.compilerMessages = err.detail.compilerMessages;
      if (err.detail.reason !== undefined) {
        log.meta.detail.reason = err.detail.reason;
      }
    } else if (
      err.detail.code === 'compiler-init-failed' ||
      err.detail.code === 'manifest-malformed'
    ) {
      if (err.detail.reason !== undefined) {
        log.meta.detail.reason = err.detail.reason;
      }
    }
  }

  return log;
}
