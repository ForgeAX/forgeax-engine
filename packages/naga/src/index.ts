import { isShaderEntryPointReads, type ShaderEntryPointReads } from '@forgeax/engine-types';
// @forgeax/engine-naga — TS-only thin shell over @forgeax/engine-wgpu-wasm raw naga bindings.
//
// Form invariants (locked by plan-strategy D-P3 / D-P4 + research F-4):
//
// - snake_case three-phase functions byte-for-byte aligned with naga upstream
//   naming (this package replaces the legacy wasm-pack shim archived in
//   feat-20260511-naga-rhi-wgpu-merge M5 — charter proposition 2 industry
//   analogy + proposition 5 consistent abstraction).
// - Each public function awaits ensureReady() from @forgeax/engine-wgpu-wasm before
//   calling the raw wasm-bindgen export — one wasm boundary crossing per page
//   lifecycle, shared with @forgeax/engine-rhi-wgpu (research F-4 ensureReady SSOT).
// - Throws are caught at the wrapper boundary and translated to
//   Result.err(ShaderError) — never throw for expected failures
//   (AGENTS.md "Errors are structured" + charter proposition 4 explicit failure).
// - The opaque handle types ParsedModule / ValidatedModule are re-exported
//   so downstream consumers (@forgeax/engine-shader-compiler) can hold the handle
//   between phases without inspecting the underlying naga IR
//   (plan-strategy §S-1 opaque handle invariant).

import { manifestMalformed } from '@forgeax/engine-shader';
import {
  ensureReady,
  getCompilerFingerprint as verifiedCompilerFingerprint,
} from '@forgeax/engine-wgpu-wasm';
import {
  err,
  initFailed,
  ok,
  type Result,
  ShaderError,
  type ShaderError as ShaderErrorType,
  wrapShaderError,
} from './errors.js';

export {
  compileFailed,
  err,
  initFailed,
  ok,
  type Result,
  type ResultErr,
  type ResultOk,
  ShaderError,
  type ShaderErrorCode,
  type ShaderErrorDetail,
} from './errors.js';

/** The same verified native execution owner used by parse/validate/compose. */
export async function getCompilerFingerprint(): Promise<Result<string, ShaderErrorType>> {
  try {
    return ok(await verifiedCompilerFingerprint());
  } catch (cause) {
    return err(
      initFailed({
        message: 'Native compiler identity is unavailable',
        reason: cause instanceof Error ? cause.message : String(cause),
        hint: 'repair the verified wgpu-wasm payload before reusing compiled products',
      }),
    );
  }
}

// === Opaque handle types ============================================================

interface ModuleHandle {
  /** Release the owned native IR; do not use a consumed or released handle. */
  free(): void;
}

/**
 * Handle for the `parse` output. The underlying type is a wasm-bindgen exported
 * struct: JS can only hold the handle — it cannot inspect naga IR fields
 * directly (charter proposition 4 + opaque handle invariant). Pass through to
 * `validate` to advance to phase 2.
 *
 * Only native release is exposed; IR fields remain private without a pkg ABI
 * dependency. Free the handle if stopping before validation; validate consumes it.
 */
export type ParsedModule = ModuleHandle;

/** Build-time Naga projection of the complete reachable closure of a compute entry. */
export async function specializeComputeEntries(
  source: string,
  entryPoints: readonly string[],
): Promise<
  Result<readonly { readonly entryPoint: string; readonly source: string }[], ShaderError>
> {
  try {
    const wasm = await ensureReady();
    const specialize = (
      wasm as {
        specialize_compute_entries: (source: string, entries: string) => string;
      }
    ).specialize_compute_entries;
    return ok(JSON.parse(specialize(source, JSON.stringify(entryPoints))));
  } catch (error) {
    return err(wrapShaderError(error));
  }
}

/**
 * Handle for the `validate` output (Module + ModuleInfo); pass through to
 * `emit_reflection` for the reflection JSON emit. Free it after the last borrowed
 * operation, including an operation that returns a failure.
 */
export type ValidatedModule = ModuleHandle;

export interface ShaderReflectionMember {
  readonly name: string;
  readonly type: string;
  readonly offset: number;
  readonly size: number;
  readonly alignment: number;
}

export interface ShaderReflectionBoundGlobal {
  readonly group: number;
  readonly binding: number;
  readonly addressSpace: string;
  readonly resourceKind: string;
  readonly visibility: number;
  readonly name?: string;
  readonly members?: readonly ShaderReflectionMember[];
  readonly span?: number;
  /** Naga byte stride of a uniform/storage array element or storage record. */
  readonly elementStride?: number;
}

export interface ShaderReflection {
  readonly entryPoints?: readonly ShaderEntryPointReads[];
  readonly schemaVersion: 'shader-reflection/2';
  readonly boundGlobals: readonly ShaderReflectionBoundGlobal[];
  readonly uvSetCount: number;
}

type ReflectionRecord = Record<string, unknown>;

function reflectionMalformed(reason: string): ShaderError {
  return manifestMalformed({
    message: `shader-reflection/2 is malformed: ${reason}`,
    hint: 'rebuild the shader with the current Naga/WASM producer and preserve every bound-global fact',
    reason,
  });
}

function isRecord(value: unknown): value is ReflectionRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredNonNegativeInteger(record: ReflectionRecord, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw reflectionMalformed(`boundGlobals entry requires non-negative integer '${key}'`);
  }
  return value;
}

function readMember(value: unknown, index: number): ShaderReflectionMember {
  if (!isRecord(value)) throw reflectionMalformed(`member ${index} is not an object`);
  const name = value.name;
  const type = value.type;
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    typeof type !== 'string' ||
    type.length === 0
  ) {
    throw reflectionMalformed(`member ${index} requires name and type`);
  }
  return {
    name,
    type,
    offset: requiredNonNegativeInteger(value, 'offset'),
    size: requiredNonNegativeInteger(value, 'size'),
    alignment: requiredNonNegativeInteger(value, 'alignment'),
  };
}

function readBoundGlobal(value: unknown, index: number): ShaderReflectionBoundGlobal {
  if (!isRecord(value)) throw reflectionMalformed(`boundGlobals entry ${index} is not an object`);
  const addressSpace = value.addressSpace;
  const resourceKind = value.resourceKind;
  if (typeof addressSpace !== 'string' || addressSpace.length === 0) {
    throw reflectionMalformed(`boundGlobals entry ${index} requires addressSpace`);
  }
  if (typeof resourceKind !== 'string' || resourceKind.length === 0) {
    throw reflectionMalformed(`boundGlobals entry ${index} requires resourceKind`);
  }
  const visibility = requiredNonNegativeInteger(value, 'visibility');
  const membersValue = value.members;
  const hasMembers = membersValue !== undefined;
  if (hasMembers && !Array.isArray(membersValue)) {
    throw reflectionMalformed(`boundGlobals entry ${index} members must be an array`);
  }
  const hasSpan = value.span !== undefined;
  const hasElementStride = value.elementStride !== undefined;
  if (resourceKind === 'buffer' || resourceKind === 'storage-buffer') {
    if (!hasMembers || !hasSpan) {
      throw reflectionMalformed(`buffer boundGlobals entry ${index} requires members and span`);
    }
  } else if (hasMembers !== hasSpan) {
    throw reflectionMalformed(`boundGlobals entry ${index} members and span must be paired`);
  }
  if (hasElementStride) {
    if (resourceKind !== 'storage-buffer' && resourceKind !== 'buffer') {
      throw reflectionMalformed(
        `boundGlobals entry ${index} elementStride is only valid for buffer resources`,
      );
    }
    const elementStride = value.elementStride;
    if (
      typeof elementStride !== 'number' ||
      !Number.isSafeInteger(elementStride) ||
      elementStride <= 0
    ) {
      throw reflectionMalformed(
        `boundGlobals entry ${index} elementStride must be a positive integer`,
      );
    }
  }
  if (value.name !== undefined && typeof value.name !== 'string') {
    throw reflectionMalformed(`boundGlobals entry ${index} diagnostic name must be a string`);
  }
  return {
    group: requiredNonNegativeInteger(value, 'group'),
    binding: requiredNonNegativeInteger(value, 'binding'),
    addressSpace,
    resourceKind,
    visibility,
    ...(value.name !== undefined ? { name: value.name as string } : {}),
    ...(hasMembers
      ? {
          members: (membersValue as unknown[]).map((member, memberIndex) =>
            readMember(member, memberIndex),
          ),
          span: requiredNonNegativeInteger(value, 'span'),
        }
      : {}),
    ...(hasElementStride
      ? { elementStride: requiredNonNegativeInteger(value, 'elementStride') }
      : {}),
  };
}

/** Parse and validate the business-neutral shader-reflection/2 wire. */
export function parseReflectionWire(json: string): ShaderReflection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw reflectionMalformed(cause instanceof Error ? cause.message : 'JSON.parse failed');
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 'shader-reflection/2') {
    throw reflectionMalformed("schemaVersion must equal 'shader-reflection/2'");
  }
  if ('material' in parsed) throw reflectionMalformed('legacy material projection is not accepted');
  if (!Array.isArray(parsed.boundGlobals)) {
    throw reflectionMalformed('boundGlobals must be an array');
  }
  if (
    typeof parsed.uvSetCount !== 'number' ||
    !Number.isSafeInteger(parsed.uvSetCount) ||
    parsed.uvSetCount < 0
  ) {
    throw reflectionMalformed('uvSetCount must be a non-negative integer');
  }
  const boundGlobals = parsed.boundGlobals.map((global, index) => readBoundGlobal(global, index));
  const coordinates = new Set<string>();
  for (const global of boundGlobals) {
    const coordinate = `${global.group}:${global.binding}`;
    if (coordinates.has(coordinate))
      throw reflectionMalformed(`duplicate bound-global coordinate ${coordinate}`);
    coordinates.add(coordinate);
  }
  const entryPoints = parsed.entryPoints;
  if (entryPoints !== undefined && !isShaderEntryPointReads(entryPoints))
    throw reflectionMalformed('entryPoints must contain reflected stage and binding reads');
  return {
    schemaVersion: 'shader-reflection/2',
    boundGlobals,
    uvSetCount: parsed.uvSetCount,
    ...(entryPoints === undefined
      ? {}
      : { entryPoints: entryPoints as unknown as readonly ShaderEntryPointReads[] }),
  };
}

/** Result-form reader for callers that need an explicit unavailable/malformed branch. */
export function readReflectionWire(
  json: string | undefined,
): Result<ShaderReflection, ShaderErrorType> {
  if (json === undefined) {
    return err(
      initFailed({
        message: 'shader-reflection/2 is unavailable before the Naga producer emits a wire',
        hint: 'run the validated compose -> reflect path and retain its raw reflection bytes',
        reason: 'reflection wire unavailable',
      }),
    );
  }
  try {
    return ok(parseReflectionWire(json));
  } catch (error) {
    return err(error instanceof ShaderError ? error : reflectionMalformed(String(error)));
  }
}

// === Phase 1: parse =================================================================

/**
 * WGSL source -> `ParsedModule`.
 *
 * On failure returns `Result.err(ShaderError code='shader-compile-failed')`
 * whose `lineNum` / `linePos` carry the source position (from the wasm-side
 * `ParseErrorPayload`). The hint defaults to actionable WGSL fix guidance.
 *
 * Wasm boundary: awaits ensureReady() on first call (shared singleton with
 * @forgeax/engine-rhi-wgpu); subsequent calls take the cached path.
 */
export async function parse(source: string): Promise<Result<ParsedModule, ShaderError>> {
  let wasm: Awaited<ReturnType<typeof ensureReady>>;
  try {
    wasm = await ensureReady();
  } catch (e) {
    return err(
      wrapShaderError(
        e,
        'rerun bash packages/wgpu-wasm/build.sh and verify packages/wgpu-wasm/pkg contains a fresh .wasm',
      ),
    );
  }
  try {
    const parsed = wasm.parse(source);
    return ok(parsed as ParsedModule);
  } catch (e) {
    return err(wrapShaderError(e));
  }
}

// === Phase 2: validate ==============================================================

/**
 * `ParsedModule` -> `ValidatedModule` (Module + ModuleInfo).
 *
 * **Ownership transfer** — wasm-bindgen consumes the `parsed` handle. Do not
 * reuse the handle after this call; passing a consumed handle is undefined
 * behaviour on the wasm side (research Finding 6 ownership semantics).
 *
 * On failure returns `Result.err(ShaderError code='shader-compile-failed')`.
 * Validator errors have no source position attached on the wasm side, so
 * `lineNum` / `linePos` remain undefined.
 */
export async function validate(
  parsed: ParsedModule,
): Promise<Result<ValidatedModule, ShaderError>> {
  let wasm: Awaited<ReturnType<typeof ensureReady>>;
  try {
    wasm = await ensureReady();
  } catch (e) {
    return err(
      wrapShaderError(
        e,
        'rerun bash packages/wgpu-wasm/build.sh and verify packages/wgpu-wasm/pkg contains a fresh .wasm',
      ),
    );
  }
  try {
    const validated = (wasm.validate as (p: unknown) => unknown)(parsed);
    return ok(validated as ValidatedModule);
  } catch (e) {
    return err(wrapShaderError(e));
  }
}

/** Validate a selected vertex/fragment pair against the validated Naga module. */
export async function validateRenderEntries(
  module: ValidatedModule,
  vertex: string,
  fragment?: string,
  colorFormats?: readonly string[],
): Promise<Result<void, ShaderError>> {
  try {
    const wasm = await ensureReady();
    (
      wasm.validate_render_entries as (
        module: unknown,
        vertex: string,
        fragment?: string,
        colorFormats?: string,
      ) => void
    )(
      module,
      vertex,
      fragment,
      colorFormats === undefined ? undefined : JSON.stringify(colorFormats),
    );
    return ok(undefined);
  } catch (error) {
    return err(wrapShaderError(error));
  }
}

// === Composer passthrough ===========================================================

/**
 * naga_oil Composer passthrough — `#import` + `#ifdef` composition over WGSL.
 *
 * Thin TS wrap over `@forgeax/engine-wgpu-wasm`'s raw `compose_shader` export
 * (feat-20260512 M1 compose.rs). Three-argument surface:
 *
 * - `entry` — the entry-point WGSL source (may contain `#import` directives
 *   and `#ifdef` guards).
 * - `imports` — `moduleId -> wgslSource` map; each value is a companion
 *   module whose header declares `#define_import_path <moduleId>` so the
 *   upstream composer can register it. The map is JSON.stringified at the
 *   wasm boundary.
 * - `defines` — `name -> boolean` map driving `#ifdef` branch elimination
 *   (plan-strategy D-06: non-boolean values are rejected at the TS layer by
 *   the shader-compiler wrapper; this wrap takes booleans verbatim). Also
 *   JSON.stringified at the boundary.
 *
 * Return: the composed WGSL string (entry + inlined imports, `#ifdef` branches
 * resolved).
 *
 * Errors: the raw wasm export throws `JsError` whose message carries a
 * `shader-import-not-found: ...` or `shader-compile-failed: ...` prefix
 * (feat-20260512 M1 compose.rs convention). This wrap does **not** translate
 * the prefix into a structured `ShaderError`; that splitting happens one layer
 * up at `@forgeax/engine-shader-compiler` (feat-20260512 M3), which is where
 * the three-argument `compileShader(src, { imports, defines, id })` entry lives.
 * Callers of this raw passthrough should `try / catch` the thrown error.
 *
 * Wasm boundary: awaits `ensureReady()` on first call (shared singleton with
 * `@forgeax/engine-rhi-wgpu` + other naga phases); subsequent calls take the
 * cached path.
 */
export async function composeShader(
  entry: string,
  imports: Record<string, string>,
  defines: Record<string, boolean>,
): Promise<string> {
  const wasm = await ensureReady();
  const compose = (wasm as { compose_shader: (e: string, i: string, d: string) => string })
    .compose_shader;
  return compose(entry, JSON.stringify(imports), JSON.stringify(defines));
}

// === Phase 3: emit_reflection =======================================================

/**
 * `ValidatedModule` + options JSON -> `BindGroupLayoutDescriptor[]` JSON string.
 *
 * `options_json` shape: `{ "dynamicOffsets": [{ "group": u32, "binding": u32 }, ...] }`.
 * The naga IR does not express the dynamic-offset dimension (research Finding 2
 * footnote), so it is injected via this JS-side options string. Pass an empty
 * `{}` (or a JSON-encoded object without `dynamicOffsets`) for the no-dynamic-
 * offset path.
 *
 * The validator's borrowed reference is **not** consumed — the same
 * `ValidatedModule` handle can be reused for repeated emits with different
 * options (e.g. for variant generation).
 */
export async function emit_reflection(
  validated: ValidatedModule,
  options_json: string,
): Promise<Result<string, ShaderError>> {
  let wasm: Awaited<ReturnType<typeof ensureReady>>;
  try {
    wasm = await ensureReady();
  } catch (e) {
    return err(
      wrapShaderError(
        e,
        'rerun bash packages/wgpu-wasm/build.sh and verify packages/wgpu-wasm/pkg contains a fresh .wasm',
      ),
    );
  }
  try {
    const reflectionJson = (wasm.emit_reflection as (v: unknown, o: string) => string)(
      validated,
      options_json,
    );
    return ok(reflectionJson);
  } catch (e) {
    return err(wrapShaderError(e));
  }
}
