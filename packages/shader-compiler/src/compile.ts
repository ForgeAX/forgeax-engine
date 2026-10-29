import { fnv1aUtf16 } from '@forgeax/engine-types';
import { projectShaderConditionals } from './conditionals.js';
// @forgeax/engine-shader-compiler — compileShader implementation.
//
// Top-level surface (charter proposition 1 progressive disclosure / proposition 5 consistent abstraction):
// - compileShader / CompileOptions / CompileResult — main API (pure function + Result)
// - ShaderError / 4 factories + Result<T,E> — error model (re-exported from @forgeax/engine-naga;
//   feat-20260511-naga-rhi-wgpu-merge moved the ShaderError class + factories down to the
//   @forgeax/engine-naga thin shell, this package now re-exports for backward compat).
// - parseReflectionJson — internal module (re-exported for vite-plugin-shader to reuse)
//
// Form invariants (plan-strategy §S-5 + §S-7 + §S-9 + feat-20260511 D-P4):
// - wasm initialisation is delegated to @forgeax/engine-naga (which itself awaits
//   @forgeax/engine-wgpu-wasm.ensureReady()); this package does not own the wasm
//   boundary plumbing.
// - Pure function: same input always yields same output (research Finding 7 invariant);
//   no dependency on mutable globals or filesystem state (except wasm loading inside
//   @forgeax/engine-naga, which is deterministic after a single ensureReady).
//
// feat-20260512-naga-oil-composition-hmr M3 T-07 extension:
// - CompileOptions gains `imports?: Record<string,string>` / `defines?: Record<string,boolean>`
//   (non-boolean values rejected at the TS layer via Record<string,boolean>, D-06).
// - CompileResult gains `deps: string[]` (AC-13; AI-F2 breadcrumb).
// - Pre-scan order (plan-strategy §1 architecture concept — before naga_oil call):
//   1. non-boolean `#define NAME VALUE` literal scan -> shader-compile-failed (D-05 OOS-1)
//   2. scanDefineConflicts (T-12) -> shader-define-conflict (D-07)
//   3. detectCycle (T-11) -> shader-circular-import (D-04)
//   4. composeShader (naga_oil) -> one portable WGSL canonicalization facade ->
//      shader-import-not-found / shader-compile-failed (via T-13 mapper)
//   5. naga parse/validate/emit_reflection (legacy path) on the canonical WGSL
// - options.id missing -> fromModuleId placeholder `<anonymous-entry-<hash8>>` (D-11).

import {
  composeShader,
  emit_reflection,
  parse,
  type ShaderReflection,
  validate,
  validateRenderEntries,
} from '@forgeax/engine-naga';
import type {
  BindGroupLayoutDescriptor,
  ManifestEntry,
  MaterialSurfaceModel,
} from '@forgeax/engine-types';
import { detectCycle } from './cycle-detect.js';
import { scanDefineConflicts } from './define-scan.js';
import { mapWasmError } from './error-mapper.js';
import {
  compileFailed,
  err,
  manifestMalformed,
  ok,
  type Result,
  ShaderError,
  type ShaderError as ShaderErrorType,
} from './errors.js';
import {
  composeSurfaceSource,
  hoistWgslEnables,
  isImportedWgslSymbol,
} from './material/compose.js';
import { buildMaterialSourceCatalog } from './material/source-catalog.js';
import { parseReflection } from './reflection.js';
import { canonicalizePortableWgsl } from './wgsl-compat.js';

// === Public types ===================================================================

/** Options accepted by `compileShader`. */
export interface CompileOptions {
  /** Graphics stages selected by the consumer; checked against the Naga IR. */
  readonly renderEntries?: {
    readonly vertex: string;
    readonly fragment?: string;
    readonly colorFormats?: readonly GPUTextureFormat[];
  };
  /**
   * Source module id (the id from the vite plugin transform hook; used for
   * error signal locating + as detail.fromModuleId on shader-import-not-found).
   * Omitted -> compileShader substitutes `<anonymous-entry-<hash8>>` (D-11).
   */
  readonly id?: string;
  /**
   * naga_oil composition imports: `moduleId -> wgslSource`. Each value's first
   * line must declare `#define_import_path <moduleId>` so the upstream composer
   * can register it (AC-14). Omitted defaults to empty map.
   */
  readonly imports?: Record<string, string>;
  /**
   * Compiler-owned MaterialParameters module used when lowering a Surface
   * slot. The material cooker/Vite producer supplies this from the root
   * ParamSchema; omitting it keeps a raw Surface entry fail-closed instead of
   * inventing an ABI.
   */
  readonly generatedParameters?: string;
  /** Surface template contract used when compiling a material-slot entry. */
  readonly surfaceModel?: MaterialSurfaceModel;
  /** Explicit imported Surface module for a non-Standard template. */
  readonly surfaceModule?: string;
  /**
   * `#ifdef` branch selector: `DEFINE_NAME -> boolean`. D-06: TS strictly
   * enforces boolean values; a numeric or string literal is a TS compile-time
   * error here. Omitted defaults to empty map.
   */
  readonly defines?: Record<string, boolean>;
  /**
   * Dynamic offset annotation list of (group, binding) pairs.
   *
   * Naga IR does not express the dynamic offset dimension (research Finding 2 footnote).
   * Callers annotate explicitly via this field so the reflection JSON output records
   * hasDynamicOffset:true.
   */
  readonly dynamicOffsets?: readonly { readonly group: number; readonly binding: number }[];
}

/** Success-branch value of `compileShader`. */
export interface CompileResult {
  /** Composed + validated WGSL source (post naga_oil #import + #ifdef resolution). */
  readonly wgsl: string;
  /** GLSL placeholder (empty string in M1 scope; non-WebGL fallback path). */
  readonly glsl: string;
  /** Reflection-derived output, fully explicit with integer visibility bitmask (plan-strategy §S-9). */
  readonly bindings: readonly BindGroupLayoutDescriptor[];
  /** Single manifest entry (4 fields: hash / wgsl / glsl / bindings; AC-04). */
  readonly manifestEntry: ManifestEntry;
  /**
   * Resolved moduleIds consumed by the entry (from options.imports keys +
   * transitive resolution). Empty array when no imports were used (AC-13
   * AI-F2 breadcrumb; Vite plugin consumes this for HMR reverseDeps).
   */
  readonly deps: string[];
  /**
   * UV set count derived from vertex @location declarations (feat-20260629 M4
   * D-3: build-time naga reflection, AC-09). 0 = no vertex entry-point, 1 = uv0
   * only, N = uv0 + uv1..uv_{N-1}. The runtime uses this to drive
   * deriveVertexBufferLayout for clamp-to-last alias (M3).
   */
  readonly uvSetCount: number;
  /** Business-neutral raw Naga reflection facts, kept build-time only. */
  readonly reflection: ShaderReflection;
}

// === Main API =======================================================================

const PRAGMA_RE = /^\s*#pragma\s+\S.*$/gm;
const DEFINE_WITH_VALUE_RE = /^\s*#define\s+\w+\s+(\S.*)$/;
const IMPORT_DIRECTIVE_RE = /^\s*#import\s+([A-Za-z0-9_.:-]+)/;
const MODULE_ID_PREFIX_RE = /^([A-Za-z0-9_-]+(?:::[A-Za-z0-9_-]+)*)/;
const DEFINE_IMPORT_PATH_RE = /^\s*#define_import_path\s+([A-Za-z0-9_.:-]+)/;

/**
 * Specialize every module in one shader composition closure before naga_oil
 * sees it. naga_oil receives one define map for an entry, but imported WGSL
 * modules are parsed as independent source strings; leaving their conditional
 * declarations intact can make the true and false branches collide after
 * linking. Keeping this small preprocessor in the compiler makes the entry
 * and every reachable import consume the same effective defines.
 */
function specializeConditionalDefines(
  source: string,
  defines: Readonly<Record<string, boolean>>,
): string {
  const output = projectShaderConditionals(source, defines, 'all').split('\n');
  // An inlined Surface and its template may import different symbols from
  // the same module. naga_oil treats repeated symbol lists as replacements.
  // Merge only active group imports after conditional projection; otherwise a
  // disabled branch could accidentally make its symbols mandatory.
  const groups = new Map<string, { index: number; symbols: Set<string> }>();
  for (const [index, line] of output.entries()) {
    if (!line.includes('#import')) continue;
    const match = /^\s*#import\s+([A-Za-z0-9_.:-]+)::\{([^}]+)\}\s*$/.exec(line);
    if (match === null) continue;
    const moduleId = match[1] ?? '';
    const symbols = (match[2] ?? '')
      .split(',')
      .map((symbol) => symbol.trim())
      .filter(Boolean);
    const previous = groups.get(moduleId);
    if (previous === undefined) groups.set(moduleId, { index, symbols: new Set(symbols) });
    else {
      for (const symbol of symbols) previous.symbols.add(symbol);
      output[previous.index] = `#import ${moduleId}::{${[...previous.symbols].join(', ')}}`;
      output[index] = '';
    }
  }
  return output.join('\n');
}

export function reachableShaderImportIds(
  source: string,
  imports: Readonly<Record<string, string>>,
): Set<string> {
  const resolve = (raw: string): string | undefined => {
    let candidate = raw.replace(/::$/, '').split('::{')[0] ?? raw;
    while (candidate.length > 0) {
      if (imports[candidate] !== undefined) return candidate;
      const separator = candidate.lastIndexOf('::');
      if (separator < 0) break;
      candidate = candidate.slice(0, separator);
    }
    return undefined;
  };
  const reachable = new Set<string>();
  const pending = [...source.matchAll(/^\s*#import\s+([A-Za-z0-9_.:-]+)/gm)].map(
    (match) => match[1] ?? '',
  );
  while (pending.length > 0) {
    const raw = pending.shift();
    if (raw === undefined) continue;
    const moduleId = resolve(raw);
    if (moduleId === undefined || reachable.has(moduleId)) continue;
    reachable.add(moduleId);
    const moduleSource = imports[moduleId];
    if (moduleSource === undefined) continue;
    for (const child of moduleSource.matchAll(/^\s*#import\s+([A-Za-z0-9_.:-]+)/gm)) {
      pending.push(child[1] ?? '');
    }
  }
  return reachable;
}
function resolveOmittedVertexColorBranch(source: string, available: boolean): string {
  if (!source.includes('VERTEX_COLOR_AVAILABLE')) return source.replace(/\r\n/g, '\n');
  const lines = source.split(/\r?\n/);
  const resolveRange = (range: readonly string[]): string[] => {
    const result: string[] = [];
    for (let index = 0; index < range.length; index++) {
      const line = range[index] ?? '';
      if (
        !line.includes('VERTEX_COLOR_AVAILABLE') ||
        line.trim() !== '#ifdef VERTEX_COLOR_AVAILABLE'
      ) {
        result.push(line);
        continue;
      }
      let depth = 1;
      let elseIndex = -1;
      let endIndex = index + 1;
      for (; endIndex < range.length; endIndex++) {
        const candidate = range[endIndex] ?? '';
        if (!candidate.includes('#')) continue;
        const directive = candidate.trim();
        if (/^#if(n?def)?\b/.test(directive)) depth++;
        else if (directive === '#else' && depth === 1) elseIndex = endIndex;
        else if (directive === '#endif') {
          depth--;
          if (depth === 0) break;
        }
      }
      const branchStart = index + 1;
      const branch = available
        ? range.slice(branchStart, elseIndex < 0 ? endIndex : elseIndex)
        : elseIndex < 0
          ? []
          : range.slice(elseIndex + 1, endIndex);
      result.push(...resolveRange(branch));
      index = endIndex;
    }
    return result;
  };
  return resolveRange(lines).join('\n');
}

function stripPragmas(source: string): string {
  return source.replace(PRAGMA_RE, '');
}

function stripComposerDirectives(source: string): string {
  return source.replace(/^\s*#.*$/gm, (line) => line.replace(/[^\r\n]/g, ' '));
}

async function locateSourceSyntaxError(
  source: string,
  imports: Readonly<Record<string, string>>,
): Promise<ShaderErrorType | undefined> {
  for (const candidate of [source, ...Object.values(imports)]) {
    const parsed = await parse(stripComposerDirectives(candidate));
    if (parsed.ok) {
      parsed.value.free();
      continue;
    }
    if (parsed.error.lineNum !== undefined && parsed.error.linePos !== undefined) {
      const line = candidate.split(/\r?\n/)[parsed.error.lineNum - 1] ?? '';
      const symbol = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(parsed.error.linePos - 1))?.[0];
      if (symbol !== undefined && isImportedWgslSymbol(candidate, symbol)) continue;
      return parsed.error;
    }
  }
  return undefined;
}

/**
 * Build-time pure function: WGSL -> triplet artefacts + reflection derivation.
 *
 * Flow (feat-20260512 M3 T-07):
 * 1. Resolve fromModuleId (options.id or <anonymous-entry-hash8>).
 * 2. Pre-scan non-boolean `#define NAME VALUE` in entry + imports sources
 *    -> shader-compile-failed (OOS-1, D-05).
 * 3. scanDefineConflicts -> shader-define-conflict (D-07).
 * 4. detectCycle on the import graph -> shader-circular-import (D-04).
 * 5. composeShader (naga_oil) -> canonicalizePortableWgsl -> post-link WGSL +
 *    resolved deps. Errors from the wasm layer flow through mapWasmError (T-13)
 *    as structured ShaderError.
 * 6. naga parse / validate / emit_reflection on the canonical WGSL.
 * 7. Assemble triplet + Result.ok.
 *
 * All error paths return Result.err — never throw (AGENTS.md "Errors are structured").
 */
export async function compileShader(
  rawSource: string,
  options: CompileOptions = {},
): Promise<Result<CompileResult, ShaderErrorType>> {
  return compileShaderWithComposition(rawSource, options, composeShader);
}

/** Internal Pack seam: source admission precedes bounded composition/program reuse. */
export async function compileShaderWithComposition(
  rawSource: string,
  options: CompileOptions,
  compose: typeof composeShader,
  compileProgram: typeof compileShaderProgram = compileShaderProgram,
): Promise<Result<CompileResult, ShaderErrorType>> {
  const requestedVertexColor = options.defines?.VERTEX_COLOR_AVAILABLE === true;
  let entrySource = rawSource;
  let entryImports: Readonly<Record<string, string>> = options.imports ?? {};
  if (rawSource.includes('#pragma material_slot surface')) {
    const templateModule = /^\s*#define_import_path\s+([A-Za-z0-9_.:-]+)/m.exec(rawSource)?.[1];
    if (templateModule === undefined) {
      return err(
        compileFailed({
          message: 'Surface material entry is missing #define_import_path',
          hint: 'Declare one stable module identity before using material_slot surface.',
        }),
      );
    }
    const catalog = buildMaterialSourceCatalog({
      engine: [
        { path: options.id ?? templateModule, source: rawSource },
        ...Object.entries(entryImports)
          .filter(([path]) => path !== templateModule && path !== options.id)
          .map(([path, source]) => ({ path, source })),
      ],
      project: [],
    });
    if (!catalog.ok) {
      return err(
        compileFailed({
          message: catalog.error.message,
          hint: catalog.error.hint,
        }),
      );
    }
    const lowered = composeSurfaceSource({
      material: options.id ?? templateModule,
      pass: 'Forward',
      templateModule,
      surfaceModule:
        options.surfaceModule ??
        (options.surfaceModel === 'single-layer-medium'
          ? 'forgeax_material::default_single_layer_medium_surface'
          : 'forgeax_material::default_standard_surface'),
      ...(options.surfaceModel === undefined ? {} : { surfaceModel: options.surfaceModel }),
      sources: catalog.value,
      ...(options.generatedParameters === undefined
        ? {}
        : { generatedParameters: options.generatedParameters }),
    });
    if (!lowered.ok) {
      return err(
        compileFailed({
          message: lowered.error.message,
          hint: lowered.error.hint,
        }),
      );
    }
    entrySource = lowered.value.source;
    entryImports = lowered.value.imports;
  }
  const defines = { ...(options.defines ?? {}) };
  const source = hoistWgslEnables(
    specializeConditionalDefines(
      resolveOmittedVertexColorBranch(stripPragmas(entrySource), requestedVertexColor),
      defines,
    ),
  );
  const imports = entryImports;
  delete defines.VERTEX_COLOR_AVAILABLE;
  if (requestedVertexColor) defines.VERTEX_COLOR_AVAILABLE = true;
  const reachable = reachableShaderImportIds(source, imports);
  const specializedImports = Object.fromEntries(
    Object.entries(imports).map(([moduleId, moduleSource]) => [
      moduleId,
      stripPragmas(
        reachable.has(moduleId)
          ? specializeConditionalDefines(moduleSource, defines)
          : moduleSource,
      ),
    ]),
  );
  const fromModuleId = options.id ?? `<anonymous-entry-${computeHash(source)}>`;

  // Stage 0a: non-boolean #define value pre-scan (D-05 OOS-1).
  const nonBooleanErr = findNonBooleanDefine({
    [fromModuleId]: source,
    ...specializedImports,
  });
  if (nonBooleanErr !== null) {
    return err(
      compileFailed({
        message: `#define with value is not supported (OOS-1); offending declaration in module '${nonBooleanErr.moduleId}': ${nonBooleanErr.line}`,
        hint: 'v1 supports only boolean defines via options.defines; remove the value (e.g. `#define TILE_SIZE` becomes a boolean), or hoist the numeric literal into the WGSL source directly. See OOS-1 in packages/shader-compiler/README.md.',
      }),
    );
  }

  // Stage 0b: #define conflict pre-scan (D-07).
  const conflicts = scanDefineConflicts({
    [fromModuleId]: source,
    ...specializedImports,
  });
  if (conflicts.length > 0) {
    const first = conflicts[0];
    if (first !== undefined) {
      const siteList = first.sites.map((s) => s.moduleId).join(', ');
      return err(
        new ShaderError({
          code: 'shader-define-conflict',
          expected: `each #define NAME declared in at most one module`,
          message: `#define '${first.defineName}' conflicts across modules: ${siteList}`,
          hint: `rename the duplicate define in one of: ${siteList}; or move the declaration to a single common module`,
          detail: first,
        }),
      );
    }
  }

  // Stage 0c: cycle detection (D-04).
  const graph = buildImportGraph(source, specializedImports, fromModuleId);
  const cycle = detectCycle(graph);
  if (cycle !== null) {
    return err(
      new ShaderError({
        code: 'shader-circular-import',
        expected: 'the import graph is acyclic',
        message: `circular #import chain detected: ${cycle.join(' -> ')}`,
        hint: `break the cycle by extracting the shared symbols into a third module imported by both sides of: ${cycle.join(' -> ')}`,
        detail: {
          code: 'shader-circular-import',
          cycle,
        },
      }),
    );
  }

  // Stage 0d: import-resolvability pre-check. naga_oil composes successfully
  // when an #import target is unused by the entry body (it silently drops the
  // directive), which hides AC-02 errors AI users need to see at build time.
  // Scan entry + imports for every #import <moduleId>::<symbol> directive and
  // require the <moduleId> prefix to appear in options.imports. When the
  // target module source exists but lacks a `#define_import_path <moduleId>`
  // header, surface the same shader-import-not-found code (the module cannot
  // bind under its declared id).
  const importResolveErr = checkImportsResolvable(source, specializedImports, fromModuleId);
  if (importResolveErr !== null) return err(importResolveErr);

  // Stage 1: compose via naga_oil, then canonicalize portable WGSL. Errors from
  // the wasm boundary flow through mapWasmError as structured ShaderError data.
  let composed: string;
  try {
    composed = canonicalizePortableWgsl(await compose(source, specializedImports, defines));
  } catch (e) {
    const mapped = mapWasmError(e, { fromModuleId });
    if (mapped.code === 'shader-compile-failed' && mapped.lineNum === undefined) {
      const located = await locateSourceSyntaxError(source, specializedImports);
      if (located !== undefined) return err(located);
    }
    return err(mapped);
  }
  // Collect deps: keys of options.imports that are referenced from the entry
  // (AC-13 AI-F2 breadcrumb). naga_oil drops unused imports during composition,
  // but the TS layer reports the declared set so the Vite plugin HMR graph
  // tracks every possible edge (plan-strategy D-10 reverseDeps Map).
  const deps = Object.keys(imports);

  const compiled = await compileProgram(composed, options, () =>
    locateSourceSyntaxError(source, specializedImports),
  );
  return compiled.ok ? ok({ ...compiled.value, deps }) : compiled;
}

/** Validate one actual WGSL program and its selected entry/reflection contract. */
export async function compileShaderProgram(
  composed: string,
  options: Pick<CompileOptions, 'renderEntries' | 'dynamicOffsets'>,
  locateSyntaxError?: () => Promise<ShaderErrorType | undefined>,
): Promise<Result<CompileResult, ShaderErrorType>> {
  // Stage 2: parse composed WGSL. Native handles remain invocation-owned.
  const parsedResult = await parse(composed);
  if (!parsedResult.ok) {
    const located = await locateSyntaxError?.();
    return err(located ?? parsedResult.error);
  }

  // Stage 3: validate.
  const validatedResult = await validate(parsedResult.value);
  if (!validatedResult.ok) {
    return err(validatedResult.error);
  }
  try {
    if (options.renderEntries !== undefined) {
      const entries = await validateRenderEntries(
        validatedResult.value,
        options.renderEntries.vertex,
        options.renderEntries.fragment,
        options.renderEntries.colorFormats,
      );
      if (!entries.ok) return entries;
    }

    // Stage 4: emit_reflection.
    const optionsJson = JSON.stringify({
      dynamicOffsets: options.dynamicOffsets ?? [],
    });
    const reflectionResult = await emit_reflection(validatedResult.value, optionsJson);
    if (!reflectionResult.ok) {
      return err(
        compileFailed({
          message: `reflection emit failed: ${reflectionResult.error.message}`,
          hint: 'verify naga IR consistency; emit_reflection should not fail after validate succeeded',
        }),
      );
    }
    const reflectionJson = reflectionResult.value;

    // Stage 5: JSON.parse + triplet assembly.
    let reflectionParsed: ReturnType<typeof parseReflection>;
    try {
      reflectionParsed = parseReflection(reflectionJson);
    } catch (e) {
      return err(
        manifestMalformed({
          message: 'reflection JSON parse failed',
          hint: 'naga emit_reflection output is malformed; report as @forgeax/engine-naga bug',
          reason: e instanceof Error ? e.message : String(e),
        }),
      );
    }
    const bindings = reflectionParsed.bindings;
    const uvSetCount = reflectionParsed.uvSetCount;

    // ManifestEntry.bindings is the BGL-array JSON (every consumer parses it as
    // `BindGroupLayoutDescriptor[]`: vite-plugin-shader's superset gate, the
    // emitted `.bindings.json` sidecar, ShaderRegistry). Since feat-20260629 m4-w2
    // naga emit_reflection wraps the array in `{ bindings, uvSetCount }`, so the
    // raw `reflectionJson` is an object, not an array. Serialize the unwrapped
    // array here; uvSetCount travels separately via CompileResult.uvSetCount, so
    // storing the wrapper string would also duplicate it (Derive violation).
    const bindingsJson = JSON.stringify(bindings);

    const hash = computeHash(composed);
    const result: CompileResult = {
      wgsl: composed,
      glsl: '',
      bindings,
      manifestEntry: {
        hash,
        wgsl: composed,
        glsl: undefined,
        bindings: bindingsJson,
        ...(reflectionParsed.wire.entryPoints === undefined
          ? {}
          : { entryPoints: reflectionParsed.wire.entryPoints }),
      },
      deps: [],
      uvSetCount,
      reflection: reflectionParsed.wire,
    };
    return ok(result);
  } finally {
    validatedResult.value.free();
  }
}

// === helpers ========================================================================

/** Preserve directive lines exactly without allocating every ordinary WGSL body line. */
function directiveLines(source: string): string[] {
  return Array.from(source.matchAll(/(?:^|\n)([^\S\n]*#[^\n]*)/g), (match) => {
    const line = match[1] ?? '';
    // Match split(/\r?\n/): remove one CR only when it precedes an actual LF.
    return line.endsWith('\r') && source[match.index + match[0].length] === '\n'
      ? line.slice(0, -1)
      : line;
  });
}

/**
 * Find the first `#define NAME VALUE` line where VALUE is present and
 * non-empty. The naga_oil + TS-layer contract is that `#define NAME` (no
 * value) is a boolean directive; `#define NAME VALUE` is out of scope (OOS-1).
 *
 * Returns { moduleId, line } of the first offender, or null.
 */
function findNonBooleanDefine(
  modules: Record<string, string>,
): { moduleId: string; line: string } | null {
  for (const [moduleId, source] of Object.entries(modules)) {
    for (const line of directiveLines(source)) {
      const match = DEFINE_WITH_VALUE_RE.exec(line);
      if (match) {
        return { moduleId, line: line.trim() };
      }
    }
  }
  return null;
}

/**
 * Build a moduleId -> [importedModuleId...] adjacency map from the entry +
 * imports sources by regex-scanning `#import <path>` lines. Each import path
 * resolves to its longest `::`-segment prefix that names a known module, so
 * `#import lab::cyc_b::fb` binds to `lab::cyc_b` and `#import cyc_b::fb` to
 * `cyc_b`. Paths that name no known module add no edge; the resolvability
 * pre-check reports them.
 *
 * The entry appears under `fromModuleId`; each options.imports value is
 * scanned under its own moduleId so nested dependencies are traced.
 */
function buildImportGraph(
  entry: string,
  imports: Record<string, string>,
  fromModuleId: string,
): Record<string, string[]> {
  const modules = new Set([fromModuleId, ...Object.keys(imports)]);
  const graph: Record<string, string[]> = {};
  graph[fromModuleId] = extractImports(entry, modules);
  for (const [moduleId, source] of Object.entries(imports)) {
    graph[moduleId] = extractImports(source, modules);
  }
  return graph;
}

function extractImports(source: string, modules: ReadonlySet<string>): string[] {
  const deps: string[] = [];
  for (const line of directiveLines(source)) {
    const full = IMPORT_DIRECTIVE_RE.exec(line)?.[1];
    if (full === undefined) continue;
    const segments = full.split('::').filter((segment) => segment.length > 0);
    const dep = longestKnownModulePrefix(segments, modules);
    if (dep !== undefined) deps.push(dep);
  }
  return deps;
}

/**
 * naga_oil import paths are `::` segmented: an import binds to the longest
 * segment prefix that names a known module path.
 */
function longestKnownModulePrefix(
  segments: readonly string[],
  known: ReadonlySet<string>,
): string | undefined {
  for (let length = segments.length; length > 0; length--) {
    const candidate = segments.slice(0, length).join('::');
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * TS-layer import resolvability pre-check (AC-02).
 *
 * naga_oil's #import dispatch is lazy: unused directives do not error, so an
 * entry with `#import forgeax_missing::mod` + empty `options.imports` still
 * composes successfully. AI users consuming err.code expect the structured
 * `shader-import-not-found` signal in this case — so we scan the entry + every
 * companion module for `#import` directives and require:
 *
 *   (a) the leading moduleId prefix to appear as an `options.imports` key OR
 *       as the tail of an existing `#define_import_path` header in some
 *       companion module source (AC-02 two-step resolution)
 *   (b) each options.imports value declares `#define_import_path <moduleId>`
 *       at or near the top (otherwise naga_oil cannot bind it and the same
 *       error code applies)
 *
 * `entry` is already define-specialized by the caller, so an `#import` inside
 * an inactive conditional branch is no longer present here.
 *
 * Returns the first unresolved import as a ShaderError, or null when every
 * #import chain resolves.
 */
function checkImportsResolvable(
  entry: string,
  imports: Record<string, string>,
  fromModuleId: string,
): ShaderError | null {
  // (b) every options.imports entry must declare its moduleId via
  //     #define_import_path; naga_oil throws on add otherwise. The same scan
  //     collects every path some companion module declares for (a).
  const declaredPaths = new Set<string>();
  for (const [moduleId, src] of Object.entries(imports)) {
    declaredPaths.add(moduleId);
    let hasHeader = false;
    for (const line of directiveLines(src)) {
      const declared = DEFINE_IMPORT_PATH_RE.exec(line)?.[1];
      if (declared === undefined) continue;
      declaredPaths.add(declared);
      if (declared === moduleId) hasHeader = true;
    }
    if (!hasHeader) {
      return makeImportNotFound({
        importPath: moduleId,
        fromModuleId,
        message: `module '${moduleId}' is registered in options.imports but its source does not declare '#define_import_path ${moduleId}' at the top`,
      });
    }
  }

  // (a) walk every #import directive in entry + imports and verify the
  //     leading module segment resolves against declaredPaths.
  const sources: [callerId: string, source: string][] = [
    [fromModuleId, entry],
    ...Object.entries(imports),
  ];
  for (const [callerId, source] of sources) {
    for (const line of directiveLines(source)) {
      const full = IMPORT_DIRECTIVE_RE.exec(line)?.[1];
      if (full === undefined) continue;
      const prefix = MODULE_ID_PREFIX_RE.exec(full)?.[1] ?? full;
      if (longestKnownModulePrefix(prefix.split('::'), declaredPaths) === undefined) {
        return makeImportNotFound({
          importPath: prefix,
          fromModuleId: callerId,
          message: `#import '${prefix}' cannot be resolved from module '${callerId}': no matching '#define_import_path' found across options.imports`,
        });
      }
    }
  }
  return null;
}

function makeImportNotFound(args: {
  importPath: string;
  fromModuleId: string;
  message: string;
}): ShaderError {
  return new ShaderError({
    code: 'shader-import-not-found',
    expected: `options.imports contains a module that declares #define_import_path ${args.importPath.split('::')[0] ?? args.importPath}`,
    message: args.message,
    hint: `check options.imports; ensure '${args.importPath}' is provided and its source declares #define_import_path at the top`,
    detail: {
      code: 'shader-import-not-found',
      importPath: args.importPath,
      fromModuleId: args.fromModuleId,
    },
  });
}

// === helper: content-addressable hash ==============================================

/** Stable legacy manifest identity; this 32-bit hash is not an integrity proof. */
function computeHash(source: string): string {
  const hash = fnv1aUtf16(source);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
