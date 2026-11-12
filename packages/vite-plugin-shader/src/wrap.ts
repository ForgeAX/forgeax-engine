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
export interface ForgeAXShaderRollupLog
  extends Pick<ShaderError, 'code' | 'message' | 'hint' | 'expected'>,
    Partial<Pick<ShaderError, 'lineNum' | 'linePos' | 'detail'>> {
  readonly loc?:
    | {
        readonly line: number;
        readonly column: number;
        readonly file?: string | undefined;
      }
    | undefined;
  readonly id?: string | undefined;
  readonly meta: Pick<ShaderError, 'hint' | 'expected'> & {
    readonly detail: Partial<
      Pick<
        Extract<ShaderErrorDetail, { code: 'shader-compile-failed' }>,
        'compilerMessages' | 'reason'
      >
    >;
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
export function toRollupLog(err: ShaderError): ForgeAXShaderRollupLog {
  const detail = err.detail;
  const reason =
    detail?.code === 'shader-compile-failed' ||
    detail?.code === 'compiler-init-failed' ||
    detail?.code === 'manifest-malformed'
      ? detail.reason
      : undefined;
  return {
    code: err.code,
    message: err.message,
    hint: err.hint,
    expected: err.expected,
    ...(err.lineNum === undefined ? {} : { lineNum: err.lineNum }),
    ...(err.linePos === undefined ? {} : { linePos: err.linePos }),
    ...(detail === undefined ? {} : { detail }),
    ...(err.lineNum === undefined || err.linePos === undefined
      ? {}
      : {
          loc: { line: err.lineNum, column: err.linePos },
        }),
    meta: {
      hint: err.hint,
      expected: err.expected,
      detail: {
        ...(detail?.code === 'shader-compile-failed'
          ? { compilerMessages: detail.compilerMessages }
          : {}),
        ...(reason === undefined ? {} : { reason }),
      },
    },
  };
}
