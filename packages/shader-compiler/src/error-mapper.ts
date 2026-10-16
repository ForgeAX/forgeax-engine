// error-mapper — wasm JsError -> structured ShaderError adapter
// (feat-20260512-naga-oil-composition-hmr M3 T-13).
//
// Input shape (feat-20260512 M1 compose.rs convention): raw JsError.message
// begins with a structured prefix:
//   - `shader-import-not-found: <rest>` for naga_oil ImportNotFound variants
//   - `shader-compile-failed: <rest>`   for the other 21 ComposerErrorInner
//                                       variants + JSON parse + wgsl
//                                       writeback failures.
//
// Output: ShaderError with `.code` narrowed to the 7-member union and
// `.detail` narrowed to the discriminated `ShaderErrorDetail` variants from
// `@forgeax/engine-types` (feat-20260512 M3 T-09 D-08) when the prefix is
// `shader-import-not-found` (so AI users can access
// `err.detail.importPath` / `err.detail.fromModuleId` without parsing the
// message string — AC-15 red line). The `shader-compile-failed` pathway
// keeps the legacy `.message` forward compat (plan-strategy D-05).
//
// Design stance: message-string shape is the only contract the wasm side
// honours; this adapter is the single chokepoint that translates it into the
// structured surface (charter proposition 4 explicit failure — never throw
// raw, never ask consumers to parse `.message`).
//
// Anchors: plan-strategy §2 D-12 (offset passthrough); plan-strategy §7 AI
// User Affordance Strategy (err.hint actionable); requirements §AC-05
// (err.detail.importPath / fromModuleId / err.hint actionable).

import { ShaderError } from '@forgeax/engine-naga';
import type { ShaderErrorCode, ShaderImportNotFoundDetail } from '@forgeax/engine-types';

const IMPORT_NOT_FOUND_PREFIX = 'shader-import-not-found:';
const COMPILE_FAILED_PREFIX = 'shader-compile-failed:';

/**
 * naga_oil `ImportNotFound(<module_name>, <offset>)` renders through the Rust
 * Display impl roughly as:
 *
 *   required import 'mod_a::foo_fn' not found in ...
 *
 * We extract the quoted import path when present. The fromModuleId is the
 * caller-supplied entry identifier (options.id) — NOT inferred from the
 * message — because naga_oil's ComposerError format does not stable-carry the
 * entry id. The caller passes fromModuleId via the wrapper signature below.
 */
const QUOTED_IMPORT_RE = /'([^']+)'/;

export interface MapWasmErrorContext {
  /**
   * The entry id (options.id) the caller passed into compileShader. When
   * omitted at the compileShader layer, the caller substitutes the
   * `<anonymous-entry-<hash8>>` placeholder (D-11) before calling this mapper
   * so the detail.fromModuleId is always populated.
   */
  readonly fromModuleId: string;
  /** Optional byte offset (D-12) when naga_oil surfaces one. */
  readonly offset?: number;
}

/**
 * Translate a wasm compose_shader JsError into a structured ShaderError.
 *
 * The wrap:
 *   - parses the structured prefix from `e.message` to pick the .code
 *   - when the prefix is `shader-import-not-found`, extracts the quoted
 *     import path (regex) + fromModuleId + optional offset into
 *     ShaderImportNotFoundDetail (D-12; .hint is actionable per AC-05)
 *   - falls back to `shader-compile-failed` + prose `.message` otherwise;
 *     the resulting ShaderError still populates `.hint` so AI users always
 *     have an actionable recovery signal (charter proposition 4).
 */
export function mapWasmError(e: unknown, ctx: MapWasmErrorContext): ShaderError {
  const msg = e instanceof Error ? e.message : String(e);

  if (msg.startsWith(IMPORT_NOT_FOUND_PREFIX)) {
    const rest = msg.slice(IMPORT_NOT_FOUND_PREFIX.length).trim();
    const match = QUOTED_IMPORT_RE.exec(rest);
    const importPath = match?.[1] ?? rest;
    const detail: ShaderImportNotFoundDetail = {
      code: 'shader-import-not-found',
      importPath,
      fromModuleId: ctx.fromModuleId,
      ...(typeof ctx.offset === 'number' ? { offset: ctx.offset } : {}),
    };
    return makeShaderError({
      code: 'shader-import-not-found',
      message: `#import '${importPath}' not found from module '${ctx.fromModuleId}'`,
      expected: `options.imports contains a module that declares #define_import_path ${importPath.split('::')[0] ?? importPath}`,
      hint: `check options.imports; ensure '${importPath}' is provided and its source declares #define_import_path at the top`,
      detail,
    });
  }

  if (msg.startsWith(COMPILE_FAILED_PREFIX)) {
    const rest = msg.slice(COMPILE_FAILED_PREFIX.length).trim();
    return makeShaderError({
      code: 'shader-compile-failed',
      message: rest,
      expected: 'WGSL source parses + validates against naga IR after naga_oil composition',
      hint: 'check WGSL syntax, #define values are boolean (not numeric), and each companion module declares #define_import_path',
    });
  }

  // No prefix: treat as compile failure with verbatim message (fallback).
  return makeShaderError({
    code: 'shader-compile-failed',
    message: msg,
    expected: 'naga_oil composition returns a composed WGSL string',
    hint: 'ensure bash packages/wgpu-wasm/build.sh produced a fresh .wasm; rerun compileShader',
  });
}

// ----- local helpers -----

interface MakeShaderErrorInit {
  readonly code: ShaderErrorCode;
  readonly message: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: ShaderImportNotFoundDetail | undefined;
}

/**
 * Construct a ShaderError from the naga package's class with the typed
 * ShaderErrorDetail payload attached through the constructor directly
 * (feat-small-20260513-dx-docs-types-cleanup M1-T3: the naga ShaderError
 * class's `detail` field now points at the 6-variant typed union in
 * @forgeax/engine-types, so the previous structural-cast workaround on the
 * `.detail` slot is no longer needed).
 */
function makeShaderError(init: MakeShaderErrorInit): ShaderError {
  return new ShaderError({
    code: init.code,
    message: init.message,
    expected: init.expected,
    hint: init.hint,
    ...(init.detail !== undefined ? { detail: init.detail } : {}),
  });
}
