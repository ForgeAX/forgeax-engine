import { decodeDocumentText } from '@forgeax/engine-codec';
import {
  isMaterialProgramAbi,
  isShaderBuiltinRole,
  isShaderCompilerProfile,
  isShaderEntryPointReads,
  isShaderProgramContract,
  isShaderReflection,
  type MaterialProgramAbi,
  type ShaderEntryPointReads,
  ShaderSource,
} from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  createMaterialShaderProgram,
  type MaterialShaderProgram,
  sameMaterialShaderEntryPoints,
  withMaterialShaderEntryPoints,
  withMaterialShaderForwardFog,
} from './material/program.js';
// @forgeax/engine-shader/ShaderRegistry — runtime shader registry, instance-per-engine shape.
//
// Shape rules (plan-strategy §S-10 / D-R10 / OQ-5 close + AC-03):
// - instance-per-engine — must be created via
//   `new ShaderRegistry({device, manifestUrl})`; module-level singletons
//   (`export const registry = ...`) and static methods (`static get`) are
//   forbidden — aligned with the instance-based style of
//   `Engine.create({ rhi })`.
// - Physical isolation — this file does **not** import @forgeax/engine-shader-compiler /
//   @forgeax/engine-naga / @forgeax/engine-wgpu-wasm (guarded by the AC-06 triple-grep gate;
//   feat-20260511-naga-rhi-wgpu-merge M4 replaced the legacy single-shim ban
//   with the merged ban list).
// - Result model — `loadManifest()` / `get()` always go through Result.ok /
//   Result.err and **never throw** (AGENTS.md "Errors are structured" / charter
//   proposition 4: explicit failure).
// - 9-member error union — `get()` returns
//   `Result<ShaderModule, RhiError | ShaderError>` (AGENTS.md "RHI / Shader /
//   error-model contract").

import { type Result, RhiError, type ShaderModule } from '@forgeax/engine-rhi';
import type {
  ImmutableParamSchemaProjection,
  ManifestEntry,
  ParamSchemaEntry,
  ParamSchemaProjectionOwnerStats,
} from '@forgeax/engine-types';
import { isDeepFrozenJson, ParamSchemaProjectionOwner } from '@forgeax/engine-types';
import {
  err,
  manifestMalformed,
  materialShaderNotFound,
  ok,
  type ResultOk,
  type ShaderError,
  ShaderError as ShaderErrorClass,
  type Result as ShaderResult,
  shaderNotFound,
} from './errors.js';
import {
  digestShaderBytes,
  hasDeferredReflection,
  manifestShaderSource,
  readOwnedShaderManifestPublication,
} from './manifest-publication.js';
import {
  equalMaterialArtifactBytes,
  type MaterialArtifactConflictError,
} from './material/artifact-registry.js';
import {
  type MaterialByteSource,
  ownMaterialByteSource,
  readMaterialByteSource,
} from './material/byte-source.js';
import {
  type MaterialShaderVariantReference,
  type MaterialVariantSource,
  materialVariantFamily,
  ownMaterialVariantReferences,
} from './material/variant-family.js';
import {
  type AdmittedShaderProgramTemplate,
  admitShaderProgramTemplate,
  readShaderProgramTemplates,
  type ShaderProgramCompilation,
  type ShaderProgramCompiler,
  selectShaderProgramDefines,
  shaderCompilerProfilesEqual,
} from './program-template.js';
import {
  type AdmittedShaderTemplateManifest,
  admitShaderTemplateManifest,
  isShaderTemplateManifestRow,
  materializeShaderTemplateManifest,
  SHADER_TEMPLATE_MANIFEST_VERSION,
} from './program-template-manifest.js';
import { findVariantByKey, type MaterialShaderManifestEntry } from './types.js';

export type { MaterialShaderVariantReference } from './material/variant-family.js';

export interface ResolvedShaderTemplateProgram extends ShaderProgramCompilation {
  readonly program: MaterialShaderProgram;
}

interface ManifestIndexes {
  readonly entries: ReadonlyMap<string, ManifestEntry>;
  readonly materials: ReadonlyMap<string, MaterialShaderManifestEntry>;
  readonly publicationEntryCount: number;
}

interface RegistryManifest extends ManifestIndexes {
  readonly template?: AdmittedShaderTemplateManifest;
}

interface AdmittedManifest extends ManifestIndexes {
  // Reuse key only. A first admission computes it after load, off the startup path.
  readonly textDigest: Promise<string>;
}

// The cache needs complete content identity, not a second retained wire copy.
// Each bounded chunk uses ASCII bytes or exact UTF-16, including lone surrogates.
// The root binds its encoding and position without retaining another wire copy.
// First admission needs no digest to decide anything; compute the reuse key once the page
// is idle so it never sits on the startup path. A failure yields a key that matches nothing.
function manifestKeyWhenIdle(key: () => Promise<string>): Promise<string> {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => number })
    .requestIdleCallback;
  // Without an idle scheduler (Node, workers) hash now: a deferred closure would keep the
  // whole decoded manifest text reachable until its timer fires.
  if (typeof idle !== 'function') return settleManifestKey(key());
  return deferManifestKey(idle, key);
}

// Kept apart from any closure that sees `key`: a handler sharing that context would
// keep the decoded manifest text alive for as long as the native digest is pending.
function settleManifestKey(pending: Promise<string>): Promise<string> {
  return pending.catch(() => '');
}

function deferManifestKey(
  idle: (cb: () => void, o?: object) => number,
  key: () => Promise<string>,
): Promise<string> {
  return new Promise<string>((resolve) => {
    idle.call(
      globalThis,
      () => {
        key().then(resolve, () => resolve(''));
      },
      { timeout: 3000 },
    );
  });
}

// A fetched manifest is keyed by its wire bytes (1.7 MB zstd): one native digest.
// Equal bytes decode to equal text, so a reuse hit is always correct; different
// bytes that decode to the same text are merely not shared. Text read through a
// host `readText` has no wire bytes and keeps the text digest above.
async function manifestWireDigest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return `wire:${bytesToHex(await digestShaderBytes(copy))}`;
}

// Each key closure captures only what it hashes, so a wire-keyed admission never
// holds the decoded manifest text through its pending digest.
function materialVariantKeyFailure(ms: MaterialShaderManifestEntry): ShaderError | undefined {
  const variantKeys = new Set<string>();
  for (const variant of isShaderTemplateManifestRow(ms) ? [] : ms.variants) {
    const canonicalKey = buildMaterialShaderVariantKey(variant.defines);
    if (variant.definesKey !== canonicalKey || variantKeys.has(variant.definesKey)) {
      return manifestMalformed({
        message:
          'ShaderRegistry: material shader variants contain a duplicate or non-canonical key',
        hint: 'each variant definesKey must be the exact sorted key derived from defines',
        reason: `invalid material shader variant key '${variant.definesKey}' for ${ms.identifier}`,
      });
    }
    variantKeys.add(variant.definesKey);
  }
  return undefined;
}

function manifestFailureReason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isTemplatePublication(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === SHADER_TEMPLATE_MANIFEST_VERSION
  );
}

function manifestReuseKey(text: string, wire: Uint8Array | undefined): () => Promise<string> {
  return wire === undefined ? textManifestKey(text) : wireManifestKey(wire);
}

function wireManifestKey(wire: Uint8Array): () => Promise<string> {
  return () => manifestWireDigest(wire);
}

function textManifestKey(text: string): () => Promise<string> {
  return () => manifestTextDigest(text);
}

async function manifestTextDigest(text: string): Promise<string> {
  const digest = sha256.create();
  const characters = new Uint16Array(Math.min(131_072, text.length));
  const bytes = new Uint8Array(characters.buffer);
  const encoding = new Uint8Array(1);
  for (let offset = 0; offset < text.length; offset += characters.length) {
    const length = Math.min(characters.length, text.length - offset);
    encoding[0] = 0;
    for (let index = 0; index < length; index++) {
      const character = text.charCodeAt(offset + index);
      if (character > 0x7f) {
        encoding[0] = 1;
        // TypedArray.set preserves the source prefix when the views overlap.
        characters.set(bytes.subarray(0, index));
        for (; index < length; index++) characters[index] = text.charCodeAt(offset + index);
        break;
      }
      bytes[index] = character;
    }
    digest.update(encoding);
    digest.update(await digestShaderBytes(bytes.subarray(0, length * (encoding[0] === 0 ? 1 : 2))));
  }
  return `text:chunks:${bytesToHex(digest.digest())}`;
}

function ownMaterialReceipt(receipt: MaterialProgramAbi): MaterialProgramAbi {
  // Package-retained ABIs are already deep-frozen and shared by every program
  // key that references them; a private clone per key would only duplicate them.
  if (receipt !== null && typeof receipt === 'object' && isDeepFrozenJson(receipt)) return receipt;
  const owned = structuredClone(receipt);
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  };
  freeze(owned);
  return owned;
}

// Identical publications share verified fragments, receipts and requested WGSL.
// Each registry holds its publication; the weak index releases it with the last
// registry. Unselected capability permutations remain fragment references.
const admittedManifests = new Map<string, WeakRef<AdmittedManifest>>();
const admittedManifestCleanup = new FinalizationRegistry<{
  url: string;
  reference: WeakRef<AdmittedManifest>;
}>(({ url, reference }) => {
  if (admittedManifests.get(url) === reference) admittedManifests.delete(url);
});

// ─── Device dependency-injection interface ──────────────────────────────────────

/**
 * Device dependency-injection interface — ShaderRegistry does not directly
 * depend on `@forgeax/engine-rhi-webgpu` (physical isolation); the caller (engine or
 * tests) supplies a device-like object that implements
 * `createShaderModule(desc) → Result<ShaderModule, RhiError>`.
 *
 * Difference from the top-level async `createShaderModule(device, desc)` in
 * `@forgeax/engine-rhi-webgpu`:
 * - This interface is synchronous — so `registry.get()` can return a cached
 *   module synchronously.
 * - The caller is responsible for wrapping the async real path into a sync one
 *   (e.g. the engine pre-compiles and caches modules during `loadManifest`).
 *
 * Mock test shape: a direct sync implementation (see `createMockDevice` in
 * src/__tests__/registry.test.ts).
 */
export interface ShaderRegistryDevice {
  createShaderModule(desc: {
    readonly code: string;
    readonly label?: string | undefined;
  }): Result<ShaderModule, RhiError>;
}

// ─── MaterialShader registry types (feat-20260523-shader-template-instance-split M5) ──

/**
 * The `forgeax::` prefix reserves engine-shipped material shader identifiers
 * (plan-strategy D-DefaultStandardPbr-Identifier + §8 charter F1 grep gate).
 * AI users grep `forgeax::` to enumerate every reserved shader identifier in
 * one shot. Custom user-side shaders pick their own identifier path
 * (typically `<package>::<id>`) — anything that is not a `<guid>`
 * (UUIDv5/v7) shape and not `forgeax::*`.
 */
export const FORGEAX_RESERVED_PATH_PREFIX = 'forgeax::' as const;

/** Stable build-time module ids for the shared closest-depth pyramid producer. */
export const DEPTH_PYRAMID_SHADER_MODULES = Object.freeze({
  seed: 'forgeax_depth_pyramid::seed',
  reduce: 'forgeax_depth_pyramid::reduce',
} as const);

/** Stable build-time module ids for the M1 spatial SSR artifact set. */
export const SSR_SHADER_MODULES = Object.freeze({
  trace: 'forgeax_ssr::trace',
  temporal: 'forgeax_ssr::temporal',
} as const);

/**
 * Material shader admission input accepted by
 * `installMaterialArtifact(identifier, entry)`. `findMaterialArtifact`
 * returns a {@link RegisteredMaterialShaderEntry} with the immutable schema
 * projection attached.
 *
 * - `source`: composed WGSL source (post-naga_oil); the final form fed to
 *   `device.createShaderModule({ code })` at pipeline-build time.
 * - `paramSchema`: closed list of `{name, type, default?}` triples that the
 *   `MaterialAsset.payload.values` is validated against at register-time
 *   (feat-20260523-shader-template-instance-split M4 3-tier validation). Per
 *   feat-20260613-material-paramschema-driven-binding M3 / w12-w13, the
 *   paramSchema is also the SSOT for the pipeline BGL via
 *   `derive(paramSchema).bglEntries` — there is no longer a separate
 *   `bindingLayout` field on this entry (D-1 / D-2).
 *
 * The shape is symmetric across engine-default + user-custom paths
 * (charter P4 consistent abstraction): both go through the same
 * `installMaterialArtifact` API regardless of whether the host wires the
 * default-standard-pbr triple at boot or the user registers a custom
 * shader after asset import.
 */
export interface MaterialShaderEntry {
  readonly forwardFog?: 'height-vertex/1' | undefined;
  readonly variantReferences?: readonly MaterialShaderVariantReference[];
  readonly entryPoints?: readonly ShaderEntryPointReads[];
  readonly source: string;
  readonly sourceReference?: ShaderSource;
  readonly paramSchema: readonly ParamSchemaEntry[];
  /** Producer-published ABI facts for this exact artifact variant. */
  readonly receipt?: MaterialProgramAbi | undefined;
}

/** Registry-owned runtime shape published after immutable schema admission. */
export interface RegisteredMaterialShaderEntry extends MaterialShaderEntry {
  readonly paramSchemaProjection: ImmutableParamSchemaProjection;
  readonly program: MaterialShaderProgram;
}

/** Cooked byte views remain read-only for their retained lifetime; first use rechecks integrity. */
export interface MaterialShaderByteEntry
  extends Omit<MaterialShaderEntry, 'source' | 'sourceReference'> {
  readonly bytes: Uint8Array;
  readonly digest: string;
}

type MaterialRegistration =
  | {
      readonly kind: 'ready';
      readonly publication: ResultOk<RegisteredMaterialShaderEntry>;
      /** Content address of the admitted program bytes; absent for a program installed as text. */
      readonly digest?: string;
    }
  | {
      readonly kind: 'bytes';
      readonly forwardFog?: 'height-vertex/1';
      readonly variantReferences?: readonly MaterialShaderVariantReference[];
      readonly owner: MaterialByteSource;
      readonly paramSchemaProjection: ImmutableParamSchemaProjection;
      readonly receipt?: MaterialProgramAbi;
      readonly entryPoints?: readonly ShaderEntryPointReads[];
    }
  | {
      readonly kind: 'template';
      readonly template: AdmittedShaderProgramTemplate;
      readonly program: string;
      readonly selection: Readonly<Record<string, boolean>>;
      readonly paramSchemaProjection: ImmutableParamSchemaProjection;
    };

// ─── Public registry types ──────────────────────────────────────────────────────

export interface ShaderRegistryOptions {
  readonly device?: ShaderRegistryDevice;
  /** Initialized program service supplied by the runtime host; the Registry owns its cache. */
  readonly programCompiler?: ShaderProgramCompiler;
  /** The host initializes the portable compiler only for a template publication. */
  readonly prepareProgramCompiler?: () => Promise<ShaderResult<ShaderProgramCompiler, ShaderError>>;
  /**
   * URL the registry fetches `manifest.json` from. `undefined` puts the
   * registry into the **zero-entry** mode: `loadManifest()` resolves
   * `Result.ok(undefined)` without issuing a fetch and `entries()` returns
   * an empty iterator. This is the bug-20260519 clear-pass-only path
   * where AI users build a `Camera`-only world (no PBR / unlit pipeline
   * is ever needed). `createRenderer.ts` Step 2 narrows on
   * `manifestEntries.length > 0` to skip the dual `createShaderModule`
   * compile in the same path (charter P3 + plan-strategy D-1 + D-2).
   */
  readonly manifestUrl: string | undefined;
  /** Read published manifest text from this host. Reject failed reads without returning partial bytes. */
  readonly readText?: (url: string) => Promise<string>;
}

type ShaderManifestDiagnostic = {
  readonly name: string;
  readonly startedAt: number;
  readonly previousElapsedMs: number;
  readonly url?: string;
  readonly status?: number;
  readonly responseUrl?: string;
  readonly entryCount?: number;
  readonly materialShaderCount?: number;
  readonly error?: string;
};

function markShaderManifestStage(
  name: string,
  detail: Omit<ShaderManifestDiagnostic, 'name' | 'startedAt' | 'previousElapsedMs'> = {},
): void {
  if (typeof globalThis === 'undefined') return;
  const host = globalThis as {
    __forgeaxShaderManifest?: ShaderManifestDiagnostic;
  };
  const previous = host.__forgeaxShaderManifest;
  const now = Date.now();
  host.__forgeaxShaderManifest = {
    name,
    startedAt: now,
    previousElapsedMs: previous === undefined ? 0 : now - previous.startedAt,
    ...detail,
  };
}

// ─── ShaderRegistry main class (instance-per-engine) ============================

/**
 * Runtime shader registry — content-addressable manifest lookup →
 * `device.createShaderModule`.
 *
 * Usage:
 * ```
 * const registry = new ShaderRegistry({ device, manifestUrl: '/shaders/manifest.json' });
 * const loaded = await registry.loadManifest();
 * if (!loaded.ok) handleError(loaded.error); // ShaderError.manifest-malformed
 *
 * const result = registry.get('abc12345');
 * if (!result.ok) handleError(result.error); // RhiError | ShaderError.shader-not-found
 * else useModule(result.value);
 * ```
 *
 * `static get` / module-level singletons are **forbidden** (plan-strategy
 * §S-10).
 */
function materialEntrySource(entry: MaterialShaderEntry, source: string): ShaderSource {
  if (entry.sourceReference !== undefined && !ShaderSource.is(entry.sourceReference))
    throw new Error('ShaderRegistry: unadmitted source reference');
  if (entry.sourceReference === undefined) return new ShaderSource([source]);
  // Exact text equality binds the reference in either identity domain without
  // hashing the supplied copy; equal content identities imply no more than this.
  if (!entry.sourceReference.matches(source))
    throw new Error('ShaderRegistry: source reference does not match material source');
  return entry.sourceReference;
}

export class ShaderRegistry {
  readonly #device: ShaderRegistryDevice | undefined;
  #programCompiler: ShaderProgramCompiler | undefined;
  readonly #prepareProgramCompiler: ShaderRegistryOptions['prepareProgramCompiler'];
  readonly #templates = new Map<string, AdmittedShaderProgramTemplate>();
  #templatePrograms = new Map<string, ResolvedShaderTemplateProgram>();
  #templateRequests = 0;
  #templateCacheHits = 0;
  #templateCompileMs = 0;
  readonly #manifestUrl: string | undefined;
  readonly #readText: ((url: string) => Promise<string>) | undefined;
  // hash → ShaderModule cache (populated lazily on first get()).
  readonly #moduleCache = new Map<string, ShaderModule>();
  // identifier → MaterialShaderEntry index (populated by
  // installMaterialArtifact; feat-20260523-shader-template-instance-split M5 / T05).
  readonly #materialShaders = new Map<string, MaterialRegistration>();
  readonly #materialPrograms = new Map<string, MaterialShaderProgram>();
  readonly #sources = new Map<string, ShaderSource>();
  readonly #paramSchemaProjectionOwner = new ParamSchemaProjectionOwner();
  #admitted: RegistryManifest | undefined;
  readonly #materialVariantFamilies = new Map<string, MaterialShaderManifestEntry>();
  #manifestLoaded = false;
  #sourceBytes = 0;

  constructor(opts: ShaderRegistryOptions) {
    this.#device = opts.device;
    this.#programCompiler = opts.programCompiler;
    this.#prepareProgramCompiler = opts.prepareProgramCompiler;
    this.#manifestUrl = opts.manifestUrl;
    this.#readText = opts.readText;
  }

  /** Retain validated CPU inputs for a replacement device with an empty GPU cache. */
  forkForDevice(device: ShaderRegistryDevice): ShaderRegistry {
    const candidate = new ShaderRegistry({
      device,
      ...(this.#programCompiler === undefined ? {} : { programCompiler: this.#programCompiler }),
      ...(this.#prepareProgramCompiler === undefined
        ? {}
        : { prepareProgramCompiler: this.#prepareProgramCompiler }),
      manifestUrl: this.#manifestUrl,
      ...(this.#readText === undefined ? {} : { readText: this.#readText }),
    });
    candidate.#templatePrograms = this.#templatePrograms;
    for (const [id, template] of this.#templates) candidate.#templates.set(id, template);
    candidate.#manifestLoaded = this.#manifestLoaded;
    const template = this.#admitted?.template;
    candidate.#admitted =
      template === undefined ? this.#admitted : candidate.#indexTemplateManifest(template);
    for (const [source, program] of this.#materialPrograms)
      candidate.#materialPrograms.set(source, program);
    for (const [id, reference] of this.#sources) candidate.#sources.set(id, reference);
    candidate.#sourceBytes = this.#sourceBytes;
    return candidate;
  }

  /** Fetch (or host-read) the manifest document; `wire` is set when the bytes came over fetch. */
  async #fetchManifestText(
    url: string,
  ): Promise<ShaderResult<{ raw: string; wire: Uint8Array | undefined }, ShaderError>> {
    let raw: string;
    let wire: Uint8Array | undefined;
    markShaderManifestStage('shader-manifest-fetch-start', { url: url });
    try {
      if (this.#readText !== undefined) {
        raw = await this.#readText(url);
      } else {
        const response = await fetch(url);
        markShaderManifestStage('shader-manifest-response', {
          url: url,
          status: response.status,
          responseUrl: response.url,
        });
        if (!response.ok) {
          markShaderManifestStage('shader-manifest-http-failed', {
            url: url,
            status: response.status,
            responseUrl: response.url,
            error: `HTTP ${response.status} ${response.statusText}`,
          });
          return err(
            manifestMalformed({
              message: `ShaderRegistry: manifest request returned HTTP ${response.status}`,
              hint: 'verify the dev manifest middleware or production manifest asset is reachable',
              reason: `${response.statusText || 'HTTP error'} at ${url}`,
            }),
          );
        }
        wire = new Uint8Array(await response.arrayBuffer());
        const text = await decodeDocumentText(wire);
        if (!text.ok) throw new Error(`shader manifest decode failed: ${text.error.code}`);
        raw = text.value;
      }
    } catch (e) {
      markShaderManifestStage('shader-manifest-fetch-failed', {
        url: url,
        error: manifestFailureReason(e),
      });
      return err(
        manifestMalformed({
          message: `ShaderRegistry: failed to fetch manifest at ${url}`,
          hint: 'verify manifest URL is reachable; check bundler emitFile output path',
          reason: manifestFailureReason(e),
        }),
      );
    }
    return ok({ raw, wire });
  }

  async #admitTemplateManifest(
    parsed: unknown,
  ): Promise<ShaderResult<AdmittedShaderTemplateManifest, ShaderError>> {
    const declaration = admitShaderTemplateManifest(parsed);
    if (!declaration.ok) return declaration;
    if (this.#programCompiler === undefined && this.#prepareProgramCompiler !== undefined) {
      try {
        const initialized = await this.#prepareProgramCompiler();
        if (!initialized.ok) return initialized;
        this.#programCompiler = initialized.value;
      } catch (cause) {
        if (cause instanceof ShaderErrorClass) return err(cause);
        return err(
          manifestMalformed({
            message: 'Shader program compiler initialization failed',
            hint: 'repair the runtime host compiler service before loading this source publication',
            reason: String(cause),
          }),
        );
      }
    }
    if (
      this.#programCompiler === undefined ||
      !shaderCompilerProfilesEqual(
        this.#programCompiler.profile,
        declaration.value.wire.library.compilerProfile,
      )
    ) {
      return err(
        manifestMalformed({
          message: 'Template manifest requires its matching portable compiler',
          hint: 'supply the runtime host program compiler before loading this publication',
        }),
      );
    }
    for (const [id, template] of declaration.value.programs) {
      const previous = this.#templates.get(id);
      if (previous !== undefined && previous.identity !== template.identity)
        return err(
          manifestMalformed({
            message: `Conflicting shader template: ${id}`,
            hint: 'replace the owning publication atomically',
          }),
        );
    }
    return declaration;
  }

  #indexTemplateManifest(template: AdmittedShaderTemplateManifest): RegistryManifest {
    const { entries, materialShaders } = materializeShaderTemplateManifest(
      template,
      (id, selection) => this.resolveProgramTemplate(id, selection),
    );
    return {
      template,
      entries: new Map(entries.map((entry) => [entry.hash, entry])),
      materials: new Map(materialShaders.map((entry) => [entry.identifier, entry])),
      publicationEntryCount: entries.length,
    };
  }

  #publishManifest(url: string, manifest: RegistryManifest): ShaderResult<void, ShaderError> {
    this.#admitted = manifest;
    this.#materialVariantFamilies.clear();
    this.#manifestLoaded = true;
    markShaderManifestStage('shader-manifest-validated', {
      url,
      status: 200,
      entryCount: manifest.publicationEntryCount,
      materialShaderCount: manifest.materials.size,
    });
    return ok(undefined);
  }

  /**
   * Loads manifest.json and populates the hash → ManifestEntry index.
   *
   * Failure paths (charter proposition 4: explicit failure):
   * - fetch / data: URL parse failed → `Result.err(ShaderError.manifest-malformed)`
   * - JSON.parse failed → ditto
   * - schema missing the `entries` field / an entries element missing
   *   hash/wgsl/bindings → ditto
   * - a material shader row is incomplete → ditto
   *
   * Validation is atomic: the registry does not publish any entry or
   * material shader row until the complete document has been validated.
   *
   * Idempotent: subsequent calls reuse the first result (never re-fetch;
   * charter proposition 6: idempotency).
   */
  async loadManifest(): Promise<ShaderResult<void, ShaderError>> {
    if (this.#manifestLoaded) return ok(undefined);

    // bug-20260519 D-2: zero-entry mode. `manifestUrl === undefined` means
    // the host opted out of shipping a shader manifest (Camera-only /
    // clear-pass-only LO 1.1 path); resolve `Result.ok` without issuing a
    // fetch. `entries()` then yields nothing and createRenderer Step 2
    // skips the dual `createShaderModule` compile (D-1 + D-3 nullable
    // PipelineState). Subsequent `get(hash)` calls fall through to the
    // shader-not-found arm via the empty entries map (charter P3
    // explicit failure on misuse).
    if (this.#manifestUrl === undefined) {
      this.#manifestLoaded = true;
      return ok(undefined);
    }

    const fetched = await this.#fetchManifestText(this.#manifestUrl);
    if (!fetched.ok) return err(fetched.error);
    const { raw, wire } = fetched.value;

    const url = this.#manifestUrl;
    let admitted = admittedManifests.get(url)?.deref();
    if (admitted !== undefined) {
      // A prior admission exists: the content key decides whether it can be shared.
      let textDigest: string;
      try {
        textDigest = await (wire === undefined
          ? manifestTextDigest(raw)
          : manifestWireDigest(wire));
      } catch (e) {
        return err(
          manifestMalformed({
            message: 'ShaderRegistry: manifest content digest failed',
            hint: 'verify the host crypto service is available',
            reason: manifestFailureReason(e),
          }),
        );
      }
      if ((await admitted.textDigest) !== textDigest) admitted = undefined;
    }
    if (admitted === undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        markShaderManifestStage('shader-manifest-json-failed', {
          url: this.#manifestUrl,
          error: manifestFailureReason(e),
        });
        return err(
          manifestMalformed({
            message: 'ShaderRegistry: manifest JSON parse failed',
            hint: 'manifest.json must be valid JSON; rebuild the project shader manifest with its configured producer',
            reason: manifestFailureReason(e),
          }),
        );
      }
      if (isTemplatePublication(parsed)) {
        const declaration = await this.#admitTemplateManifest(parsed);
        if (!declaration.ok) return declaration;
        const template = declaration.value;
        const indexes = this.#indexTemplateManifest(template);
        for (const [id, program] of template.programs) this.#templates.set(id, program);
        return this.#publishManifest(url, indexes);
      }
      try {
        parsed = await readOwnedShaderManifestPublication(parsed);
      } catch (e) {
        markShaderManifestStage('shader-manifest-publication-failed', {
          url: this.#manifestUrl,
          error: manifestFailureReason(e),
        });
        return err(
          manifestMalformed({
            message: 'ShaderRegistry: shader source publication is invalid',
            hint: 'rebuild the shader manifest with the matching Engine producer',
            reason: manifestFailureReason(e),
          }),
        );
      }
      const indexes = indexManifest(parsed);
      if (!indexes.ok) return err(indexes.error);
      admitted = {
        ...indexes.value,
        textDigest: manifestKeyWhenIdle(manifestReuseKey(raw, wire)),
      };
      const reference = new WeakRef(admitted);
      admittedManifests.set(url, reference);
      admittedManifestCleanup.register(admitted, { url, reference });
    }
    return this.#publishManifest(url, admitted);
  }

  /**
   * Iterate every `ManifestEntry` populated by the most recent successful
   * `loadManifest()` call. Order matches the manifest JSON `entries` array
   * (insertion order; charter P2 structured-over-prose: AI users walk this
   * to discover engine-shipped entries by content marker without
   * re-fetching the manifest).
   *
   * Returns an empty iterator when no manifest has been loaded yet
   * (charter P3 explicit failure: the empty case is not an error — the
   * absent SSOT is the absent contract).
   */
  entries(): IterableIterator<ManifestEntry> {
    return (this.#admitted?.entries ?? EMPTY_MANIFEST_ENTRIES).values();
  }

  /**
   * Looks up a hash and forwards to `device.createShaderModule` (creates lazily
   * on first hit, then caches).
   *
   * Error paths:
   * - hash miss → `Result.err(ShaderError.shader-not-found)`
   * - device.createShaderModule failed → `Result.err(RhiError)` passes through
   *   (it is **not** wrapped as a ShaderError).
   *
   * Sync shape: on cache miss, the underlying `device.createShaderModule` is
   * called synchronously; the caller is responsible for handling the async
   * real path at the device-wrapper layer (e.g. the engine pre-compiles
   * during `loadManifest`).
   */
  get(hash: string): Result<ShaderModule, RhiError | ShaderError> {
    const cachedModule = this.#moduleCache.get(hash);
    if (cachedModule !== undefined) {
      return ok(cachedModule);
    }

    const entry = this.#admitted?.entries.get(hash);
    if (entry === undefined) {
      return err(
        shaderNotFound({
          hash,
          hint: 'verify manifest.json contains the expected hash; rerun build to regenerate manifest',
        }),
      );
    }

    if (this.#device === undefined) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'a device-bound ShaderRegistry to create GPU modules',
          hint: 'use forkForDevice in the rendering realm; source realms only read shader metadata',
        }),
      );
    }
    let source: ShaderSource;
    try {
      source = this.shaderSource(manifestShaderSource(entry));
    } catch (cause) {
      if (cause instanceof RhiError || cause instanceof ShaderErrorClass) return err(cause);
      return err(
        new RhiError({
          code: 'limit-exceeded',
          expected: 'shader source admission capacity',
          hint: String(cause),
        }),
      );
    }
    const result = this.#device.createShaderModule(source.descriptor(hash));
    if (!result.ok) {
      return result;
    }
    this.#moduleCache.set(hash, result.value);
    return result;
  }

  // ─── MaterialShader registry surface ───────────────────────────────────────
  // (feat-20260523-shader-template-instance-split M5 / T05 — plan-strategy
  // D-DefaultStandardPbr-Identifier).
  //
  // Two-tier identifier namespace:
  //   - `forgeax::*`  — engine-shipped reserved prefix; the host wires
  //     `forgeax::default-standard-pbr` at engine boot from the
  //     vite-plugin-shader manifest's `materialShaders[]` row + the
  //     `default-standard-pbr.schema.json` SSOT (M5 / T08 + M6).
  //   - any other identifier — user-side custom material shader, registered
  //     after asset import.
  //
  // The registry is the runtime SSOT consumed by:
  //   - `parseAssetPayload`'s `'::' two-way dispatch` (M4 / T01) — the path
  //     branch validates against `paramSchema` and feeds `MaterialSnapshot.
  //     materialShaderId` (M4 / T05).
  //   - `render-system-record`'s pipeline cache key (M4 / T06) — same
  //     identifier feeds the per-pipeline `(materialShaderId, stateHash)` key.

  /** Logical unique source size; this is not retained heap or a capacity policy. */
  sourceInspection(): {
    readonly logicalBytes: number;
    readonly sources: number;
    readonly programs: number;
    readonly schemas: number;
  } {
    return {
      logicalBytes: this.#sourceBytes,
      sources: this.#sources.size,
      programs: this.#materialPrograms.size,
      schemas: this.#paramSchemaProjectionOwner.stats().projections,
    };
  }

  /** Admit a native source recipe without composing or reflecting any selection. */
  installProgramTemplate(identifier: string, input: unknown): ShaderResult<void, ShaderError> {
    if (identifier.length === 0)
      return err(
        manifestMalformed({
          message: 'Shader template requires a nonempty identifier',
          hint: 'publish the source module or material program identity',
        }),
      );
    const admitted = admitShaderProgramTemplate(input);
    if (!admitted.ok) return admitted;
    const previous = this.#templates.get(identifier);
    if (previous !== undefined && previous.identity !== admitted.value.identity) {
      return err(
        manifestMalformed({
          message: `Conflicting shader template: ${identifier}`,
          hint: 'replace the publication atomically rather than overwriting a live program identity',
        }),
      );
    }
    this.#templates.set(identifier, previous ?? admitted.value);
    return ok(undefined);
  }

  /** Atomic library admission verifies shared modules but compiles no variant. */
  installProgramTemplates(input: unknown): ShaderResult<void, ShaderError> {
    const declarations = readShaderProgramTemplates(input);
    if (!declarations.ok) return declarations;
    for (const [identifier, template] of declarations.value) {
      const previous = this.#templates.get(identifier);
      if (previous !== undefined && previous.identity !== template.identity)
        return err(
          manifestMalformed({
            message: `Conflicting shader template: ${identifier}`,
            hint: 'replace the whole owning publication before installing new source',
          }),
        );
    }
    for (const [identifier, template] of declarations.value) {
      if (!this.#templates.has(identifier)) this.#templates.set(identifier, template);
    }
    return ok(undefined);
  }

  /** Resolve only the requested feature set; uniforms and render state never enter this key. */
  resolveProgramTemplate(
    identifier: string,
    selection: Readonly<Record<string, boolean>>,
  ): ShaderResult<ResolvedShaderTemplateProgram, ShaderError> {
    this.#templateRequests++;
    const admitted = this.#templates.get(identifier);
    if (admitted === undefined)
      return err(
        shaderNotFound({
          hash: identifier,
          hint: 'load the template publication before selecting a program',
        }),
      );
    const selected = selectShaderProgramDefines(admitted, selection);
    if (!selected.ok) return selected;
    const compiler = this.#programCompiler;
    if (
      compiler === undefined ||
      !shaderCompilerProfilesEqual(compiler.profile, admitted.template.compilerProfile)
    ) {
      return err(
        manifestMalformed({
          message: `Shader template compiler is unavailable or mismatched: ${identifier}`,
          hint: 'initialize the matching portable program compiler in the runtime host before source selection',
        }),
      );
    }
    const key = `${admitted.identity}:${selected.value.key}`;
    const cached = this.#templatePrograms.get(key);
    if (cached !== undefined) {
      this.#templateCacheHits++;
      this.shaderSource(cached.program.sourceReference);
      const previous = this.#materialPrograms.get(cached.program.sourceReference.identity);
      this.#materialPrograms.set(
        cached.program.sourceReference.identity,
        previous === undefined
          ? cached.program
          : withMaterialShaderForwardFog(
              withMaterialShaderEntryPoints(previous, cached.program.entryPoints),
              cached.program.forwardFog,
            ),
      );
      return ok(cached);
    }
    const started = performance.now();
    const compiled = compiler.compile(admitted.template, selected.value.defines);
    this.#templateCompileMs += performance.now() - started;
    if (!compiled.ok) return compiled;
    const result = compiled.value;
    // Reflection, reads and the immutable source belong to this selected program.
    const manifestEntry = structuredClone(result.manifestEntry);
    const receipt = result.receipt === undefined ? undefined : structuredClone(result.receipt);
    freezeTemplateProgramFacts(manifestEntry);
    if (receipt !== undefined) freezeTemplateProgramFacts(receipt);
    const program = this.materialProgram(
      manifestEntry.wgsl,
      manifestEntry.entryPoints,
      result.forwardFog ?? receipt?.forwardFog,
    );
    const resolved = Object.freeze({
      manifestEntry,
      program,
      uvSetCount: result.uvSetCount,
      ...(program.forwardFog === undefined ? {} : { forwardFog: program.forwardFog }),
      ...(receipt === undefined ? {} : { receipt }),
    });
    this.#templatePrograms.set(key, resolved);
    return ok(resolved);
  }

  programTemplateInspection(options?: { readonly includePrograms?: true }): {
    readonly templates: number;
    readonly selections: number;
    readonly requests: number;
    readonly cacheHits: number;
    readonly compileMs: number;
    readonly programs?: readonly { readonly identifier: string; readonly definesKey: string }[];
  } {
    const names = options?.includePrograms
      ? new Map(
          [...this.#templates].map(([identifier, template]) => [template.identity, identifier]),
        )
      : undefined;
    return {
      templates: this.#templates.size,
      selections: this.#templatePrograms.size,
      requests: this.#templateRequests,
      cacheHits: this.#templateCacheHits,
      compileMs: this.#templateCompileMs,
      ...(names === undefined
        ? {}
        : {
            programs: [...this.#templatePrograms.keys()].map((key) => {
              const separator = key.indexOf(':');
              const identity = key.slice(0, separator);
              return {
                identifier: names.get(identity) ?? identity,
                definesKey: key.slice(separator + 1),
              };
            }),
          }),
    };
  }

  /** Share source storage for this Registry's registered CPU inputs. */
  shaderSource(input: string | ShaderSource): ShaderSource {
    if (typeof input !== 'string' && !ShaderSource.is(input))
      throw new Error('ShaderRegistry: unadmitted source reference');
    const source = typeof input === 'string' ? new ShaderSource([input]) : input;
    const previous = this.#sources.get(source.identity);
    if (previous !== undefined) return previous;
    this.#sources.set(source.identity, source);
    this.#sourceBytes += source.length * 2;
    return source;
  }

  materialProgram(
    input: string | ShaderSource,
    entryPoints?: readonly ShaderEntryPointReads[],
    forwardFog?: 'height-vertex/1',
  ): MaterialShaderProgram {
    const source = this.shaderSource(input);
    const cached = this.#materialPrograms.get(source.identity);
    const program = withMaterialShaderForwardFog(
      cached === undefined
        ? createMaterialShaderProgram(source, entryPoints)
        : withMaterialShaderEntryPoints(cached, entryPoints),
      forwardFog,
    );
    if (program !== cached) this.#materialPrograms.set(source.identity, program);
    return program;
  }

  /**
   * Register a material shader entry under a stable identifier.
   *
   * **Throws** on:
   *   - duplicate registration of the same identifier (programmer error per
   *     AGENTS.md "explicit registration" + Inspector "fail-fast no overwrite"
   *     pattern; charter P3 explicit failure on misuse).
   *
   * Successful path returns void — the registry mutates in-place. Use
   * {@link findMaterialArtifact} to read back.
   *
   * Identifier conventions (charter F1 / plan-strategy §8 §2):
   *   - `forgeax::<kebab-case>` — engine-shipped reserved prefix; the host
   *     registers `forgeax::default-standard-pbr` at boot.
   *   - `<package>::<id>` or `<guid>` — user-side custom shaders.
   *
   * @example
   * ```ts
   * const registry = new ShaderRegistry({ device, manifestUrl });
   * registry.installMaterialArtifact('forgeax::default-standard-pbr', {
   *   source: composedWgsl,
   *   paramSchema: defaultStandardPbrSchema,
   * });
   * ```
   */
  installMaterialArtifact(
    identifier: string,
    entry: MaterialShaderEntry,
    programSource?: ShaderRegistry,
  ): void {
    if (entry.entryPoints !== undefined && !isShaderEntryPointReads(entry.entryPoints))
      throw new Error('ShaderRegistry: invalid shader entry read contract');
    if (this.#materialShaders.has(identifier)) {
      throw new Error(
        `ShaderRegistry: material shader identifier '${identifier}' already registered; same-name re-register is forbidden (AGENTS.md "explicit registration" + Inspector "fail-fast no overwrite" pattern). Use findMaterialArtifact to read back the existing entry.`,
      );
    }
    const publication = this.#prepareMaterialArtifact(identifier, entry, programSource);
    this.#materialShaders.set(identifier, { kind: 'ready', publication });
  }

  /** Admit a material selection without composing source or creating a GPU module. */
  installMaterialManifestTemplate(
    identifier: string,
    definesKey: string,
  ): ShaderResult<void, ShaderError> {
    const declaration = this.#admitted?.template?.wire.materialShaders.find(
      (row) => row.identifier === identifier,
    );
    const family = this.#admitted?.materials.get(identifier);
    const selected = family === undefined ? undefined : findVariantByKey(family, definesKey);
    if (declaration === undefined || family === undefined || selected === undefined)
      return err(
        manifestMalformed({
          message: `Material shader '${identifier}' has no native selection '${definesKey}'`,
          hint: 'publish the material template and its exact feature selection',
        }),
      );
    return this.installMaterialArtifactTemplate(
      identifier,
      declaration.program,
      selected.defines,
      JSON.parse(family.paramSchema) as readonly ParamSchemaEntry[],
    );
  }

  /** Admit a material selection without composing source or creating a GPU module. */
  installMaterialArtifactTemplate(
    identifier: string,
    program: string,
    selection: Readonly<Record<string, boolean>>,
    paramSchema: readonly ParamSchemaEntry[],
  ): ShaderResult<void, ShaderError> {
    if (this.#materialShaders.has(identifier))
      return err(
        manifestMalformed({
          message: `Material shader '${identifier}' is already registered`,
          hint: 'keep one immutable publication per material program key',
        }),
      );
    const template = this.#templates.get(program);
    if (template === undefined)
      return err(
        shaderNotFound({ hash: program, hint: 'admit the template library before its materials' }),
      );
    const selected = selectShaderProgramDefines(template, selection);
    if (!selected.ok) return selected;
    if (
      template.template.engine !== undefined &&
      JSON.stringify(paramSchema) !== JSON.stringify(template.template.engine.paramSchema)
    )
      return err(
        manifestMalformed({
          message: `Material shader '${identifier}' conflicts with its template schema`,
          hint: 'use the parameter schema owned by the template producer',
        }),
      );
    let projection: ImmutableParamSchemaProjection;
    try {
      projection = this.#paramSchemaProjectionOwner.admit({
        ownerId: identifier,
        revision: 1,
        schema: paramSchema,
      });
    } catch (cause) {
      return err(
        manifestMalformed({
          message: `Material shader '${identifier}' has an invalid parameter schema`,
          reason: cause instanceof Error ? cause.message : String(cause),
          hint: 'repair the material parameter contract before publication',
        }),
      );
    }
    this.#materialShaders.set(identifier, {
      kind: 'template',
      template,
      program,
      selection: Object.freeze({ ...selection }),
      paramSchemaProjection: projection,
    });
    return ok(undefined);
  }

  #prepareMaterialArtifact(
    identifier: string,
    entry: MaterialShaderEntry,
    programSource?: ShaderRegistry,
    preparedProgram?: MaterialShaderProgram,
  ): ResultOk<RegisteredMaterialShaderEntry> {
    if (entry.forwardFog !== undefined && entry.forwardFog !== 'height-vertex/1')
      throw new TypeError('Unsupported Forward fog contract');
    const { source, paramSchema, receipt: inputReceipt } = entry;
    const sourceReference = materialEntrySource(entry, source);
    const receipt = inputReceipt === undefined ? undefined : ownMaterialReceipt(inputReceipt);
    if (receipt !== undefined && !isMaterialProgramAbi(receipt)) {
      throw new Error(
        `ShaderRegistry: material shader '${identifier}' carries an invalid ABI receipt; re-publish the producer reflection facts before registration`,
      );
    }
    // bug-20260619: user shaders registered directly here bypass the build-time
    // superset gate (vite-plugin-shader's WGSL reflection). A schema that omits
    // a texture field the WGSL actually samples would let the extract stage's
    // `validateTextureHandle` silently drop the handle and fall back to the
    // default white texture (opaque-white grass/windows in the LO 4.3 blending
    // demo). Fail fast at register time instead (charter P3 explicit failure).
    // Scoped to user shaders: engine `forgeax::*` shaders go through the
    // build-time gate and may sample engine-injected textures (emissive /
    // occlusion) absent from their schema by design.
    const paramSchemaProjection = this.#paramSchemaProjectionOwner.admit({
      ownerId: identifier,
      revision: 1,
      schema: paramSchema,
    });
    // Exact source facts can come from this registry or the receiving registry.
    // Each new schema is still admitted and checked before publishing the entry.
    const cached =
      this.#materialPrograms.get(sourceReference.identity) ??
      preparedProgram ??
      (programSource === undefined
        ? undefined
        : programSource.#materialPrograms.get(sourceReference.identity));
    const reads = entry.entryPoints ?? receipt?.entryPoints;
    let program =
      cached === undefined
        ? createMaterialShaderProgram(this.shaderSource(entry.sourceReference ?? source), reads)
        : withMaterialShaderEntryPoints(cached, reads);
    if (entry.entryPoints !== undefined && receipt?.entryPoints !== undefined)
      program = withMaterialShaderEntryPoints(program, receipt.entryPoints);
    program = withMaterialShaderForwardFog(program, entry.forwardFog ?? receipt?.forwardFog);
    if (!identifier.startsWith(FORGEAX_RESERVED_PATH_PREFIX)) {
      const declared = paramSchemaProjection.derivedInterface.textureFieldNames;
      const undeclared = program.sampledUserTextureFields.filter((field) => !declared.has(field));
      if (undeclared.length > 0) {
        throw new Error(
          `ShaderRegistry: material shader '${identifier}' samples texture(s) [${undeclared.join(', ')}] in its WGSL but its paramSchema does not declare them as texture entries. Add { name: '${undeclared[0]}', type: 'texture2d' } (and any others listed) to the paramSchema, or the engine would silently bind the default white texture (charter P3 explicit failure; see docs/handover/2026-06-19-blending-transparency-regression-bisect.md).`,
        );
      }
    }
    this.shaderSource(program.sourceReference);
    this.#materialPrograms.set(sourceReference.identity, program);
    return Object.freeze(
      ok(
        Object.freeze({
          get source() {
            return program.source;
          },
          program,
          paramSchema: paramSchemaProjection.schema,
          paramSchemaProjection,
          ...(entry.variantReferences === undefined
            ? {}
            : { variantReferences: ownMaterialVariantReferences(entry.variantReferences) }),
          ...(receipt === undefined ? {} : { receipt }),
          ...(program.forwardFog === undefined ? {} : { forwardFog: program.forwardFog }),
        }),
      ),
    );
  }

  #validateMaterialArtifactDependencies(
    source: ShaderRegistry,
    entries: readonly (readonly [string, MaterialRegistration])[],
  ): void {
    const incoming = new Set(entries.map(([identifier]) => identifier));
    for (const [identifier] of entries) {
      const registration = source.#materialShaders.get(identifier);
      const references =
        registration?.kind === 'bytes'
          ? registration.variantReferences
          : registration?.kind === 'ready'
            ? registration.publication.value.variantReferences
            : undefined;
      for (const reference of references ?? [])
        if (!incoming.has(reference.identifier) && !this.#materialShaders.has(reference.identifier))
          throw new Error(
            `ShaderRegistry: missing material variant program '${reference.identifier}'`,
          );
      if (references !== undefined)
        materialVariantFamily(identifier, references, (key) =>
          source.#materialShaders.has(key)
            ? source.#materialVariantSource(key)
            : this.#materialVariantSource(key),
        );
    }
  }

  #validateMaterialArtifactRegistration(
    identifier: string,
    registration: MaterialRegistration,
  ): void {
    const schema =
      registration.kind === 'ready'
        ? registration.publication.value.paramSchema
        : registration.paramSchemaProjection.schema;
    const program =
      registration.kind === 'ready'
        ? registration.publication.value.program
        : registration.kind === 'bytes'
          ? registration.owner.program
          : undefined;
    if (registration.kind === 'template') {
      const previousTemplate = this.#templates.get(registration.program);
      if (
        previousTemplate !== undefined &&
        previousTemplate.identity !== registration.template.identity
      )
        throw new Error(`ShaderRegistry: conflicting material template '${registration.program}'`);
    }
    const previous = this.#paramSchemaProjectionOwner.get(identifier, 1);
    const cached =
      program === undefined
        ? undefined
        : this.#materialPrograms.get(program.sourceReference.identity);
    if (cached?.entryPoints !== undefined)
      withMaterialShaderEntryPoints(cached, program?.entryPoints);
    if (previous !== undefined && JSON.stringify(previous.schema) !== JSON.stringify(schema))
      throw new Error(`ShaderRegistry: ${identifier}@1 reused with different schema content`);
  }

  /** Atomically adopt complete CPU facts validated by another registry; never accept author tokens. */
  installMaterialArtifactsFrom(source: ShaderRegistry, identifiers?: readonly string[]): void {
    const entries =
      identifiers === undefined
        ? [...source.#materialShaders]
        : identifiers.map((identifier) => {
            const entry = source.#materialShaders.get(identifier);
            if (entry === undefined)
              throw new Error(`ShaderRegistry: missing material shader '${identifier}'`);
            return [identifier, entry] as const;
          });
    const keys = new Set<string>();
    this.#validateMaterialArtifactDependencies(source, entries);
    for (const [identifier, registration] of entries) {
      if (keys.has(identifier) || this.#materialShaders.has(identifier))
        throw new Error(
          `ShaderRegistry: material shader identifier '${identifier}' already registered`,
        );
      keys.add(identifier);
      this.#validateMaterialArtifactRegistration(identifier, registration);
    }
    for (const [identifier, registration] of entries) {
      const schema =
        registration.kind === 'ready'
          ? registration.publication.value.paramSchema
          : registration.paramSchemaProjection.schema;
      const projection = this.#paramSchemaProjectionOwner.admit({
        ownerId: identifier,
        revision: 1,
        schema,
      });
      if (registration.kind !== 'ready') {
        if (registration.kind === 'template') {
          // Transfer immutable CPU recipe/compiler facts, never a source Registry or its device.
          this.#templates.set(registration.program, registration.template);
          this.#programCompiler ??= source.#programCompiler;
        }
        this.#materialShaders.set(identifier, {
          ...registration,
          paramSchemaProjection: projection,
        });
        continue;
      }
      const entry = registration.publication.value;
      const cached = this.#materialPrograms.get(entry.program.sourceReference.identity);
      const base =
        cached?.entryPoints === undefined && entry.program.entryPoints !== undefined
          ? entry.program
          : (cached ?? entry.program);
      const program = withMaterialShaderForwardFog(
        withMaterialShaderEntryPoints(base, entry.program.entryPoints),
        entry.program.forwardFog,
      );
      this.shaderSource(program.sourceReference);
      this.#materialPrograms.set(program.sourceReference.identity, program);
      this.#materialShaders.set(identifier, {
        kind: 'ready',
        ...(registration.digest === undefined ? {} : { digest: registration.digest }),
        publication: Object.freeze(
          ok(
            Object.freeze({
              ...entry,
              get source() {
                return program.source;
              },
              program,
              paramSchema: projection.schema,
              paramSchemaProjection: projection,
            }),
          ),
        ),
      });
    }
  }

  /** Preflight immutable byte/schema/receipt conflicts without preparing WGSL. */
  validateMaterialArtifactBytes(
    identifier: string,
    entry: MaterialShaderByteEntry,
  ): Result<boolean, MaterialArtifactConflictError> {
    const admitted = this.#preflightMaterialArtifactBytes(identifier, entry);
    return admitted.ok ? ok(admitted.value === undefined) : admitted;
  }

  /**
   * A program key admitted from bytes is identified by its content digest, as
   * a shader library resolves code by its hash alone; the digest was verified
   * with the container the bytes came from. Later admissions of the same key
   * and digest check metadata only. Returns the owner for a new key, or
   * undefined when the key already holds this program.
   */
  #preflightMaterialArtifactBytes(
    identifier: string,
    entry: MaterialShaderByteEntry,
  ): Result<MaterialByteSource | undefined, MaterialArtifactConflictError> {
    validateMaterialByteMetadata(entry);
    const registration = this.#materialShaders.get(identifier);
    const admittedDigest =
      registration === undefined
        ? undefined
        : registration.kind === 'bytes'
          ? registration.owner.digest
          : registration.kind === 'ready'
            ? registration.digest
            : undefined;
    const retained =
      admittedDigest === undefined ? ownMaterialByteSource(entry.bytes, entry.digest) : undefined;
    if (registration === undefined) return ok(retained);
    const dimension =
      admittedDigest === undefined
        ? textProgramDiffers(registration, retained, entry.bytes)
          ? 'bytes'
          : materialMetadataConflict(
              this.#paramSchemaProjectionOwner,
              identifier,
              registration,
              entry,
            )
        : admittedDigest !== entry.digest
          ? 'bytes'
          : materialMetadataConflict(
              this.#paramSchemaProjectionOwner,
              identifier,
              registration,
              entry,
            );
    if (dimension !== undefined)
      return err({
        code: 'material-artifact-conflict',
        expected: 'one immutable source, interface, and ABI receipt per program key',
        hint: 're-cook the conflicting program',
        detail: {
          key: identifier,
          dimension,
          ...(admittedDigest === undefined ? {} : { existingDigest: admittedDigest }),
          incomingDigest: entry.digest,
        },
      });
    return ok(undefined);
  }

  /** Admit complete byte evidence now; source-dependent preparation occurs on lookup. */
  installMaterialArtifactBytes(identifier: string, entry: MaterialShaderByteEntry): void {
    const owner = this.#preflightMaterialArtifactBytes(identifier, entry).unwrap();
    if (owner === undefined) return;
    if (entry.bytes.length === 0) throw new Error('ShaderRegistry: empty material program');
    const projection = this.#paramSchemaProjectionOwner.admit({
      ownerId: identifier,
      revision: 1,
      schema: entry.paramSchema,
    });
    const receipt = entry.receipt === undefined ? undefined : ownMaterialReceipt(entry.receipt);
    const entryPoints =
      entry.entryPoints === undefined ? undefined : structuredClone(entry.entryPoints);
    freezeTemplateProgramFacts(entryPoints);
    this.#materialShaders.set(identifier, {
      kind: 'bytes',
      owner,
      ...(entry.forwardFog === undefined ? {} : { forwardFog: entry.forwardFog }),
      ...(entry.variantReferences === undefined
        ? {}
        : { variantReferences: ownMaterialVariantReferences(entry.variantReferences) }),
      paramSchemaProjection: projection,
      ...(receipt === undefined ? {} : { receipt }),
      ...(entryPoints === undefined ? {} : { entryPoints }),
    });
  }

  #resolveMaterialArtifact(
    identifier: string,
    registration: MaterialRegistration,
  ): ShaderResult<RegisteredMaterialShaderEntry, ShaderError> {
    if (registration.kind === 'ready') return registration.publication;
    if (registration.kind === 'template') {
      const resolved = this.resolveProgramTemplate(registration.program, registration.selection);
      if (!resolved.ok) return resolved;
      const compiled = resolved.value;
      const publication = this.#prepareMaterialArtifact(
        identifier,
        {
          source: compiled.program.source,
          sourceReference: compiled.program.sourceReference,
          paramSchema: registration.paramSchemaProjection.schema,
          ...(compiled.receipt === undefined ? {} : { receipt: compiled.receipt }),
          ...(compiled.forwardFog === undefined ? {} : { forwardFog: compiled.forwardFog }),
          ...(compiled.program.entryPoints === undefined
            ? {}
            : { entryPoints: compiled.program.entryPoints }),
        },
        undefined,
        compiled.program,
      );
      this.#materialShaders.set(identifier, { kind: 'ready', publication });
      return publication;
    }
    const source = readMaterialByteSource(registration.owner);
    const publication = this.#prepareMaterialArtifact(
      identifier,
      {
        source: source.read(),
        sourceReference: source,
        ...(registration.variantReferences === undefined
          ? {}
          : { variantReferences: registration.variantReferences }),
        paramSchema: registration.paramSchemaProjection.schema,
        ...(registration.receipt === undefined ? {} : { receipt: registration.receipt }),
        ...(registration.forwardFog === undefined ? {} : { forwardFog: registration.forwardFog }),
        ...(registration.entryPoints === undefined
          ? {}
          : { entryPoints: registration.entryPoints }),
      },
      undefined,
      registration.owner.program,
    );
    registration.owner.program = publication.value.program;
    registration.owner.source = publication.value.program.sourceReference;
    this.#materialShaders.set(identifier, {
      kind: 'ready',
      publication,
      digest: registration.owner.digest,
    });
    return publication;
  }

  /**
   * Lookup a previously-registered material shader entry by identifier.
   *
   * Returns `Result.ok(entry)` on hit, `Result.err(material-shader-not-found)`
   * on miss. The `Result` shape mirrors `get(hash)` for consistent
   * abstraction across the runtime registry surface (charter P4).
   *
   * @example
   * ```ts
   * const r = registry.findMaterialArtifact('forgeax::default-standard-pbr');
   * if (!r.ok) return handleError(r.error);
   * const { source, paramSchema } = r.value;
   * ```
   */
  findMaterialArtifact(
    identifier: string,
  ): ShaderResult<RegisteredMaterialShaderEntry, ShaderError> {
    const entry = this.#materialShaders.get(identifier);
    if (entry === undefined) {
      return err(
        materialShaderNotFound({
          identifier,
          expected: Array.from(this.#materialShaders.keys()),
          hint: `register the shader via ShaderRegistry.installMaterialArtifact('${identifier}', ...) at engine boot, or grep '${FORGEAX_RESERVED_PATH_PREFIX}' to enumerate engine-shipped reserved identifiers`,
        }),
      );
    }
    return this.#resolveMaterialArtifact(identifier, entry);
  }

  /** Optional immutable artifact lookup; normal misses do not construct diagnostics. */
  materialArtifact(identifier: string): RegisteredMaterialShaderEntry | undefined {
    const entry = this.#materialShaders.get(identifier);
    return entry === undefined
      ? undefined
      : this.#resolveMaterialArtifact(identifier, entry).unwrap();
  }

  /** Declaration-only inspection never decodes or analyzes a pending program. */
  materialArtifactDeclaration(
    identifier: string,
  ):
    | { readonly kind: 'ready'; readonly entry: RegisteredMaterialShaderEntry }
    | ({ readonly kind: 'bytes' } & Omit<MaterialShaderByteEntry, 'bytes' | 'digest'>)
    | { readonly kind: 'template'; readonly paramSchema: readonly ParamSchemaEntry[] }
    | undefined {
    const entry = this.#materialShaders.get(identifier);
    if (entry === undefined) return undefined;
    if (entry.kind === 'ready') return { kind: 'ready', entry: entry.publication.value };
    if (entry.kind === 'template')
      return { kind: 'template', paramSchema: entry.paramSchemaProjection.schema };
    return {
      kind: 'bytes',
      ...(entry.variantReferences === undefined
        ? {}
        : { variantReferences: entry.variantReferences }),
      paramSchema: entry.paramSchemaProjection.schema,
      ...(entry.receipt === undefined ? {} : { receipt: entry.receipt }),
      ...(entry.forwardFog === undefined ? {} : { forwardFog: entry.forwardFog }),
      ...(entry.entryPoints === undefined
        ? {}
        : { entryPoints: structuredClone(entry.entryPoints) }),
    };
  }

  /**
   * Iterate every registered material shader identifier in registration
   * order (charter F1 grep gate: `for (const id of registry.materialShaderIdentifiers())`
   * lists every `forgeax::*` + user shader without a private-field reach-in).
   */
  materialShaderIdentifiers(): IterableIterator<string> {
    return this.#materialShaders.keys();
  }

  /** Runtime diagnostic counters for the immutable ParamSchema owner. */
  paramSchemaProjectionStats(): ParamSchemaProjectionOwnerStats {
    return this.#paramSchemaProjectionOwner.stats();
  }

  /**
   * Iterate every MaterialShaderManifestEntry parsed from manifest.json's
   * `materialShaders[]` field during `loadManifest()`.
   *
   * feat-20260526-pbr-uniform-fallback-no-storage-buffer M3 / w12:
   * createRenderer variant resolution consumes this list to select the
   * correct variant (by `caps.storageBuffer`) and register the resolved
   * WGSL via `installMaterialArtifact`.
   *
   * Returns an empty iterator when no manifest has been loaded yet or
   * the manifest lacks `materialShaders` (backward-compatible).
   */
  *materialShaderManifestEntries(): IterableIterator<MaterialShaderManifestEntry> {
    yield* (this.#admitted?.materials ?? EMPTY_MANIFEST_MATERIALS).values();
    yield* this.#materialVariantFamilies.values();
  }

  /** Resolve one validated material manifest row without enumerating the publication. */
  materialShaderManifestEntry(identifier: string): MaterialShaderManifestEntry | undefined {
    const held =
      this.#admitted?.materials.get(identifier) ?? this.#materialVariantFamilies.get(identifier);
    if (held !== undefined) return held;
    const registration = this.#materialShaders.get(identifier);
    const references =
      registration?.kind === 'bytes'
        ? registration.variantReferences
        : registration?.kind === 'ready'
          ? registration.publication.value.variantReferences
          : undefined;
    if (references === undefined) return undefined;
    const row = materialVariantFamily(identifier, references, (key) =>
      this.#materialVariantSource(key),
    );
    this.#materialVariantFamilies.set(identifier, row);
    return row;
  }

  #materialVariantSource(identifier: string): MaterialVariantSource {
    const registration = this.#materialShaders.get(identifier);
    if (registration === undefined || registration.kind === 'template')
      throw new Error(`ShaderRegistry: missing material variant program '${identifier}'`);
    if (registration.kind === 'ready') {
      const entry = registration.publication.value;
      return {
        read: () => entry.program.sourceReference,
        paramSchema: entry.paramSchema,
        ...(entry.receipt === undefined ? {} : { receipt: entry.receipt }),
        ...(entry.forwardFog === undefined ? {} : { forwardFog: entry.forwardFog }),
        ...(entry.program.entryPoints === undefined
          ? {}
          : { entryPoints: entry.program.entryPoints }),
      };
    }
    const owner = registration.owner;
    return {
      read: () => readMaterialByteSource(owner),
      paramSchema: registration.paramSchemaProjection.schema,
      ...(registration.receipt === undefined ? {} : { receipt: registration.receipt }),
      ...(registration.forwardFog === undefined ? {} : { forwardFog: registration.forwardFog }),
      ...(registration.entryPoints === undefined ? {} : { entryPoints: registration.entryPoints }),
    };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────────

const EMPTY_MANIFEST_ENTRIES: ReadonlyMap<string, ManifestEntry> = new Map();
const EMPTY_MANIFEST_MATERIALS: ReadonlyMap<string, MaterialShaderManifestEntry> = new Map();

/** Index only after validating every row; keep one set of CPU facts per admitted publication. */
function indexManifest(parsed: unknown): ShaderResult<ManifestIndexes, ShaderError> {
  if (typeof parsed !== 'object' || parsed === null || !('entries' in parsed)) {
    return err(
      manifestMalformed({
        message: 'ShaderRegistry: manifest missing required `entries` field',
        hint: 'manifest schema requires top-level `entries: ManifestEntry[]`',
      }),
    );
  }

  const entries = (parsed as { entries: unknown }).entries;
  if (!Array.isArray(entries)) {
    return err(
      manifestMalformed({
        message: 'ShaderRegistry: manifest.entries is not an array',
        hint: 'manifest schema requires `entries: ManifestEntry[]`',
      }),
    );
  }

  const indexedEntries = new Map<string, ManifestEntry>();
  for (const entry of entries) {
    if (!isValidManifestEntry(entry)) {
      return err(
        manifestMalformed({
          message: 'ShaderRegistry: manifest entry missing required fields',
          hint: 'every entry needs {hash, wgsl, glsl, bindings} per @forgeax/engine-types.ManifestEntry',
          reason: `bad entry: ${JSON.stringify(entry)}`,
        }),
      );
    }
    indexedEntries.set(entry.hash, entry);
  }

  // feat-20260526-pbr-uniform-fallback-no-storage-buffer M3 / w12:
  // parse and store materialShaders[] from the manifest for
  // createRenderer variant resolution. Non-existent / non-array
  // materialShaders is treated as empty (backward-compatible with
  // manifests from pre-M2 build runs).
  const { materialShaders } = parsed as { materialShaders?: unknown };
  const validatedMaterialShaderEntries = new Map<string, MaterialShaderManifestEntry>();
  if (Array.isArray(materialShaders)) {
    for (const ms of materialShaders) {
      if (!isValidMaterialShaderManifestEntry(ms)) {
        return err(
          manifestMalformed({
            message: 'ShaderRegistry: manifest material shader entry missing required fields',
            hint: 'every material shader entry needs {identifier, sourcePath, composedWgsl, paramSchema, variants}',
            reason: `bad material shader entry: ${JSON.stringify(ms)}`,
          }),
        );
      }
      if (validatedMaterialShaderEntries.has(ms.identifier)) {
        return err(
          manifestMalformed({
            message: 'ShaderRegistry: manifest contains duplicate material shader identifiers',
            hint: 'materialShaders[] must contain one row per identifier',
            reason: `duplicate material shader identifier: ${ms.identifier}`,
          }),
        );
      }
      const variantFailure = materialVariantKeyFailure(ms);
      if (variantFailure !== undefined) return err(variantFailure);
      validatedMaterialShaderEntries.set(ms.identifier, ms);
    }
  }
  return ok({
    entries: indexedEntries,
    materials: validatedMaterialShaderEntries,
    publicationEntryCount: entries.length,
  });
}

// The publication decoder creates read-only source getters only after validating
// their complete fragment references. Reading them here would materialize every
// variant during admission. Ordinary JSON manifests retain literal string checks.
function hasStringSource(value: object, field: string): boolean {
  const property = Object.getOwnPropertyDescriptor(value, field);
  return (
    typeof property?.value === 'string' ||
    (typeof property?.get === 'function' && property.set === undefined)
  );
}

function isValidManifestEntry(value: unknown): value is ManifestEntry {
  if (typeof value !== 'object' || value === null) return false;
  if (isShaderTemplateManifestRow(value)) return true;
  const v = value as Record<string, unknown>;
  if (typeof v.hash !== 'string') return false;
  if (!hasStringSource(v, 'wgsl')) return false;
  return (
    typeof v.bindings === 'string' &&
    isValidManifestEntryOptions(v) &&
    isValidOptionalShaderFacts(v)
  );
}

function isValidMaterialShaderManifestEntry(value: unknown): value is MaterialShaderManifestEntry {
  if (typeof value !== 'object' || value === null) return false;
  if (isShaderTemplateManifestRow(value)) return true;
  const v = value as Record<string, unknown>;
  if (!isValidMaterialManifestRoot(v)) return false;
  if (!isValidOptionalNonEmptyHash(v.hash)) return false;
  if (!isValidOptionalShaderFacts(v)) return false;
  if (!Array.isArray(v.variants)) return false;
  return v.variants.every(isValidMaterialShaderManifestVariant) && isValidOptionalMaterialFacts(v);
}

function isValidMaterialShaderManifestVariant(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.definesKey === 'string' &&
    hasStringSource(v, 'composedWgsl') &&
    isValidOptionalNonEmptyHash(v.hash) &&
    isValidOptionalShaderFacts(v) &&
    isValidBooleanDefines(v.defines) &&
    (v.receipt === undefined || isMaterialProgramAbi(v.receipt))
  );
}

function isValidManifestEntryOptions(v: Record<string, unknown>): boolean {
  if (v.role !== undefined && !isShaderBuiltinRole(v.role)) return false;
  // glsl allows string | undefined | null (manifest.json may serialize null as
  // 'glsl: null').
  if (v.glsl !== undefined && v.glsl !== null && typeof v.glsl !== 'string') return false;
  if (v.identifier !== undefined && (typeof v.identifier !== 'string' || v.identifier.length === 0))
    return false;
  return (
    (v.defines === undefined || isValidBooleanDefines(v.defines)) &&
    (v.programContract === undefined || isShaderProgramContract(v.programContract))
  );
}

function isValidBooleanDefines(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((define) => typeof define === 'boolean');
}

function isValidOptionalShaderFacts(v: Record<string, unknown>): boolean {
  return isValidOptionalEntryPoints(v.entryPoints) && isValidOptionalArtifactFacts(v);
}

function isValidOptionalEntryPoints(value: unknown): boolean {
  return value === undefined || isShaderEntryPointReads(value);
}

function isValidOptionalArtifactFacts(v: Record<string, unknown>): boolean {
  return (
    isValidOptionalHash(v.hash) &&
    isValidOptionalSourceDigest(v.sourceDigest) &&
    isValidOptionalCompilerProfile(v.compilerProfile) &&
    (hasDeferredReflection(v) || isValidOptionalReflection(v.reflection))
  );
}

function isValidOptionalHash(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isValidOptionalNonEmptyHash(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0);
}

function isValidOptionalSourceDigest(value: unknown): boolean {
  return value === undefined || /^[a-f0-9]{64}$/.test(String(value));
}

function isValidOptionalCompilerProfile(value: unknown): boolean {
  return value === undefined || isShaderCompilerProfile(value);
}

function isValidOptionalReflection(value: unknown): boolean {
  return value === undefined || isShaderReflection(value);
}

function isValidMaterialManifestRoot(v: Record<string, unknown>): boolean {
  return (
    typeof v.identifier === 'string' &&
    typeof v.sourcePath === 'string' &&
    hasStringSource(v, 'composedWgsl') &&
    typeof v.paramSchema === 'string'
  );
}

function isValidOptionalMaterialFacts(v: Record<string, unknown>): boolean {
  return (
    (v.receipt === undefined || isMaterialProgramAbi(v.receipt)) &&
    (v.uvSetCount === undefined || typeof v.uvSetCount === 'number')
  );
}

function buildMaterialShaderVariantKey(defines: Record<string, boolean>): string {
  const entries = Object.entries(defines).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.every(([, value]) => value)
    ? ''
    : entries.map(([key, value]) => `${key}=${value}`).join('+');
}

/** Metadata-only checks deliberately run before source preparation. */
function validateMaterialByteMetadata(entry: MaterialShaderByteEntry): void {
  if (entry.forwardFog !== undefined && entry.forwardFog !== 'height-vertex/1')
    throw new Error('ShaderRegistry: invalid Forward fog contract');
  ownMaterialVariantReferences(entry.variantReferences);
  if (entry.receipt !== undefined && !isMaterialProgramAbi(entry.receipt))
    throw new Error('ShaderRegistry: invalid material ABI receipt');
  if (entry.entryPoints !== undefined && !isShaderEntryPointReads(entry.entryPoints))
    throw new Error('ShaderRegistry: invalid shader entry read contract');
  if (
    entry.entryPoints !== undefined &&
    entry.receipt?.entryPoints !== undefined &&
    !sameMaterialShaderEntryPoints(entry.entryPoints, entry.receipt.entryPoints)
  )
    throw new Error('ShaderRegistry: conflicting shader entry read contract for immutable source');
}

/**
 * A program installed as text has no content digest, so incoming bytes (already
 * verified against their own digest) are compared with its source. A program
 * decoded from that same retained owner needs no comparison.
 */
function textProgramDiffers(
  registration: MaterialRegistration,
  retained: MaterialByteSource | undefined,
  bytes: Uint8Array,
): boolean {
  if (registration.kind !== 'ready') return true;
  const prior = registration.publication.value;
  if (retained?.source !== undefined && prior.program.sourceReference === retained.source)
    return false;
  return !equalMaterialArtifactBytes(new TextEncoder().encode(prior.source), bytes);
}

/** Schema, ABI receipt, and entry read conflicts for a key that already holds this program. */
function materialMetadataConflict(
  schemas: ParamSchemaProjectionOwner,
  identifier: string,
  registration: MaterialRegistration,
  entry: MaterialShaderByteEntry,
): 'param-schema' | 'receipt' | undefined {
  const prior = registration.kind === 'ready' ? registration.publication.value : undefined;
  const schema =
    prior?.paramSchema ??
    (registration.kind !== 'ready'
      ? registration.paramSchemaProjection.schema
      : schemas.get(identifier, 1)?.schema);
  if (schema !== undefined && JSON.stringify(schema) !== JSON.stringify(entry.paramSchema))
    return 'param-schema';
  const references =
    prior?.variantReferences ??
    (registration.kind === 'bytes' ? registration.variantReferences : undefined);
  if (
    JSON.stringify(references) !==
    JSON.stringify(ownMaterialVariantReferences(entry.variantReferences))
  )
    return 'receipt';
  const receipt =
    prior?.receipt ?? (registration.kind === 'bytes' ? registration.receipt : undefined);
  if (
    !sameMaterialShaderEntryPoints(
      materialRegistrationReads(registration),
      entry.entryPoints ?? entry.receipt?.entryPoints,
    ) ||
    JSON.stringify(receipt) !== JSON.stringify(entry.receipt)
  )
    return 'receipt';
  return undefined;
}

function materialRegistrationReads(
  registration: MaterialRegistration,
): readonly ShaderEntryPointReads[] | undefined {
  return registration.kind === 'ready'
    ? registration.publication.value.program.entryPoints
    : registration.kind === 'bytes'
      ? (registration.entryPoints ?? registration.receipt?.entryPoints)
      : undefined;
}

function freezeTemplateProgramFacts(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeTemplateProgramFacts(child);
  Object.freeze(value);
}
