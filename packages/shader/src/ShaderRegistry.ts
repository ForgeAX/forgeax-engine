import { decodeDocumentText } from '@forgeax/engine-codec';
import {
  isMaterialProgramAbi,
  isShaderEntryPointReads,
  type MaterialProgramAbi,
  type ShaderEntryPointReads,
} from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  createMaterialShaderProgram,
  type MaterialShaderProgram,
  withMaterialShaderEntryPoints,
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
  type Result as ShaderResult,
  shaderNotFound,
} from './errors.js';
import { digestShaderBytes, readShaderManifestPublication } from './manifest-publication.js';
import type { MaterialShaderManifestEntry } from './types.js';

interface AdmittedManifest {
  readonly textDigest: string;
  readonly manifest: unknown;
}

// The cache needs complete content identity, not a second retained wire copy.
// Native SHA hashes fixed 256 KiB UTF-16 chunks, preserving unpaired surrogates
// without copying the complete wire text. The root binds their ordered digests.
async function manifestTextDigest(text: string): Promise<string> {
  const digest = sha256.create();
  const characters = new Uint16Array(Math.min(131_072, text.length));
  const bytes = new Uint8Array(characters.buffer);
  for (let offset = 0; offset < text.length; offset += characters.length) {
    const length = Math.min(characters.length, text.length - offset);
    for (let index = 0; index < length; index++)
      characters[index] = text.charCodeAt(offset + index);
    digest.update(await digestShaderBytes(bytes.subarray(0, length * 2)));
  }
  return bytesToHex(digest.digest());
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
  readonly entryPoints?: readonly ShaderEntryPointReads[];
  readonly source: string;
  readonly paramSchema: readonly ParamSchemaEntry[];
  /** Producer-published ABI facts for this exact artifact variant. */
  readonly receipt?: MaterialProgramAbi | undefined;
}

/** Registry-owned runtime shape published after immutable schema admission. */
export interface RegisteredMaterialShaderEntry extends MaterialShaderEntry {
  readonly paramSchemaProjection: ImmutableParamSchemaProjection;
  readonly program: MaterialShaderProgram;
}

// ─── Public registry types ──────────────────────────────────────────────────────

export interface ShaderRegistryOptions {
  readonly device?: ShaderRegistryDevice;
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
export class ShaderRegistry {
  readonly #device: ShaderRegistryDevice | undefined;
  readonly #manifestUrl: string | undefined;
  readonly #readText: ((url: string) => Promise<string>) | undefined;
  // hash → ManifestEntry index (populated after loadManifest).
  readonly #entries = new Map<string, ManifestEntry>();
  // hash → ShaderModule cache (populated lazily on first get()).
  readonly #moduleCache = new Map<string, ShaderModule>();
  // identifier → MaterialShaderEntry index (populated by
  // installMaterialArtifact; feat-20260523-shader-template-instance-split M5 / T05).
  readonly #materialShaders = new Map<string, ResultOk<RegisteredMaterialShaderEntry>>();
  readonly #materialPrograms = new Map<string, MaterialShaderProgram>();
  readonly #paramSchemaProjectionOwner = new ParamSchemaProjectionOwner();
  readonly #materialShaderManifestEntries = new Map<string, MaterialShaderManifestEntry>();
  #admitted: AdmittedManifest | undefined;
  #manifestLoaded = false;

  constructor(opts: ShaderRegistryOptions) {
    this.#device = opts.device;
    this.#manifestUrl = opts.manifestUrl;
    this.#readText = opts.readText;
  }

  /** Retain validated CPU inputs for a replacement device with an empty GPU cache. */
  forkForDevice(device: ShaderRegistryDevice): ShaderRegistry {
    const candidate = new ShaderRegistry({
      device,
      manifestUrl: this.#manifestUrl,
      ...(this.#readText === undefined ? {} : { readText: this.#readText }),
    });
    for (const [hash, entry] of this.#entries) candidate.#entries.set(hash, entry);
    for (const [identifier, entry] of this.#materialShaderManifestEntries)
      candidate.#materialShaderManifestEntries.set(identifier, entry);
    candidate.#manifestLoaded = this.#manifestLoaded;
    candidate.#admitted = this.#admitted;
    for (const [source, program] of this.#materialPrograms)
      candidate.#materialPrograms.set(source, program);
    return candidate;
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

    let raw: string;
    markShaderManifestStage('shader-manifest-fetch-start', { url: this.#manifestUrl });
    try {
      if (this.#readText !== undefined) {
        raw = await this.#readText(this.#manifestUrl);
      } else {
        const response = await fetch(this.#manifestUrl);
        markShaderManifestStage('shader-manifest-response', {
          url: this.#manifestUrl,
          status: response.status,
          responseUrl: response.url,
        });
        if (!response.ok) {
          markShaderManifestStage('shader-manifest-http-failed', {
            url: this.#manifestUrl,
            status: response.status,
            responseUrl: response.url,
            error: `HTTP ${response.status} ${response.statusText}`,
          });
          return err(
            manifestMalformed({
              message: `ShaderRegistry: manifest request returned HTTP ${response.status}`,
              hint: 'verify the dev manifest middleware or production manifest asset is reachable',
              reason: `${response.statusText || 'HTTP error'} at ${this.#manifestUrl}`,
            }),
          );
        }
        const text = await decodeDocumentText(new Uint8Array(await response.arrayBuffer()));
        if (!text.ok) throw new Error(`shader manifest decode failed: ${text.error.code}`);
        raw = text.value;
      }
    } catch (e) {
      markShaderManifestStage('shader-manifest-fetch-failed', {
        url: this.#manifestUrl,
        error: e instanceof Error ? e.message : String(e),
      });
      return err(
        manifestMalformed({
          message: `ShaderRegistry: failed to fetch manifest at ${this.#manifestUrl}`,
          hint: 'verify manifest URL is reachable; check bundler emitFile output path',
          reason: e instanceof Error ? e.message : String(e),
        }),
      );
    }

    const url = this.#manifestUrl;
    let textDigest: string;
    try {
      textDigest = await manifestTextDigest(raw);
    } catch (e) {
      return err(
        manifestMalformed({
          message: 'ShaderRegistry: manifest content digest failed',
          hint: 'verify the host crypto service is available',
          reason: e instanceof Error ? e.message : String(e),
        }),
      );
    }
    let admitted = admittedManifests.get(url)?.deref();
    if (admitted?.textDigest !== textDigest) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        markShaderManifestStage('shader-manifest-json-failed', {
          url: this.#manifestUrl,
          error: e instanceof Error ? e.message : String(e),
        });
        return err(
          manifestMalformed({
            message: 'ShaderRegistry: manifest JSON parse failed',
            hint: 'manifest.json must be valid JSON; rebuild via @forgeax/engine-vite-plugin-shader generateBundle',
            reason: e instanceof Error ? e.message : String(e),
          }),
        );
      }
      try {
        parsed = await readShaderManifestPublication(parsed);
      } catch (e) {
        markShaderManifestStage('shader-manifest-publication-failed', {
          url: this.#manifestUrl,
          error: e instanceof Error ? e.message : String(e),
        });
        return err(
          manifestMalformed({
            message: 'ShaderRegistry: shader source publication is invalid',
            hint: 'rebuild the shader manifest with the matching Engine producer',
            reason: e instanceof Error ? e.message : String(e),
          }),
        );
      }
      admitted = { textDigest, manifest: parsed };
      admittedManifests.set(url, new WeakRef(admitted));
    }
    const parsed = admitted.manifest;

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

    const validatedEntries: ManifestEntry[] = [];
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
      validatedEntries.push(entry);
    }

    // feat-20260526-pbr-uniform-fallback-no-storage-buffer M3 / w12:
    // parse and store materialShaders[] from the manifest for
    // createRenderer variant resolution. Non-existent / non-array
    // materialShaders is treated as empty (backward-compatible with
    // manifests from pre-M2 build runs).
    const parsedSlim = parsed as { materialShaders?: unknown };
    const validatedMaterialShaderEntries = new Map<string, MaterialShaderManifestEntry>();
    if (Array.isArray(parsedSlim.materialShaders)) {
      for (const ms of parsedSlim.materialShaders) {
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
        const variantKeys = new Set<string>();
        for (const variant of ms.variants) {
          const canonicalKey = buildMaterialShaderVariantKey(variant.defines);
          if (variant.definesKey !== canonicalKey || variantKeys.has(variant.definesKey)) {
            return err(
              manifestMalformed({
                message:
                  'ShaderRegistry: material shader variants contain a duplicate or non-canonical key',
                hint: 'each variant definesKey must be the exact sorted key derived from defines',
                reason: `invalid material shader variant key '${variant.definesKey}' for ${ms.identifier}`,
              }),
            );
          }
          variantKeys.add(variant.definesKey);
        }
        validatedMaterialShaderEntries.set(ms.identifier, ms);
      }
    }

    this.#entries.clear();
    for (const entry of validatedEntries) {
      this.#entries.set(entry.hash, entry);
    }
    this.#materialShaderManifestEntries.clear();
    for (const [identifier, entry] of validatedMaterialShaderEntries)
      this.#materialShaderManifestEntries.set(identifier, entry);
    this.#admitted = admitted;
    this.#manifestLoaded = true;
    markShaderManifestStage('shader-manifest-validated', {
      url: this.#manifestUrl,
      status: 200,
      entryCount: validatedEntries.length,
      materialShaderCount: validatedMaterialShaderEntries.size,
    });
    return ok(undefined);
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
    return this.#entries.values();
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

    const entry = this.#entries.get(hash);
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
    const result = this.#device.createShaderModule({ code: entry.wgsl, label: hash });
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

  /** Publish source-derived facts once per composed program, independent of GPU lifetime. */
  materialProgram(
    source: string,
    entryPoints?: readonly ShaderEntryPointReads[],
  ): MaterialShaderProgram {
    const cached = this.#materialPrograms.get(source);
    const program =
      cached === undefined
        ? createMaterialShaderProgram(source, entryPoints)
        : withMaterialShaderEntryPoints(cached, entryPoints);
    if (program !== cached) this.#materialPrograms.set(source, program);
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
    const { source, paramSchema, receipt: inputReceipt } = entry;
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
      this.#materialPrograms.get(source) ??
      (programSource === undefined ? undefined : programSource.#materialPrograms.get(source));
    const reads = entry.entryPoints ?? receipt?.entryPoints;
    const program =
      cached === undefined
        ? createMaterialShaderProgram(source, reads)
        : withMaterialShaderEntryPoints(cached, reads);
    if (entry.entryPoints !== undefined && receipt?.entryPoints !== undefined)
      withMaterialShaderEntryPoints(program, receipt.entryPoints);
    if (!identifier.startsWith(FORGEAX_RESERVED_PATH_PREFIX)) {
      const declared = paramSchemaProjection.derivedInterface.textureFieldNames;
      const undeclared = program.sampledUserTextureFields.filter((field) => !declared.has(field));
      if (undeclared.length > 0) {
        throw new Error(
          `ShaderRegistry: material shader '${identifier}' samples texture(s) [${undeclared.join(', ')}] in its WGSL but its paramSchema does not declare them as texture entries. Add { name: '${undeclared[0]}', type: 'texture2d' } (and any others listed) to the paramSchema, or the engine would silently bind the default white texture (charter P3 explicit failure; see docs/handover/2026-06-19-blending-transparency-regression-bisect.md).`,
        );
      }
    }
    this.#materialPrograms.set(source, program);
    this.#materialShaders.set(
      identifier,
      Object.freeze(
        ok(
          Object.freeze({
            // Retained copies publish one composed program under many keys. Keep
            // the program's first-admitted source, not each Worker-cloned copy.
            source: program.source,
            program,
            paramSchema: paramSchemaProjection.schema,
            paramSchemaProjection,
            ...(receipt === undefined ? {} : { receipt }),
          }),
        ),
      ),
    );
  }

  /** Atomically adopt complete CPU facts validated by another registry; never accept author tokens. */
  installMaterialArtifactsFrom(source: ShaderRegistry): void {
    const entries = [...source.#materialShaders];
    for (const [identifier, publication] of entries) {
      const entry = publication.value;
      if (this.#materialShaders.has(identifier))
        throw new Error(
          `ShaderRegistry: material shader identifier '${identifier}' already registered`,
        );
      const previous = this.#paramSchemaProjectionOwner.get(identifier, 1);
      const cached = this.#materialPrograms.get(entry.source);
      if (cached?.entryPoints !== undefined)
        withMaterialShaderEntryPoints(cached, entry.program.entryPoints);
      if (
        previous !== undefined &&
        JSON.stringify(previous.schema) !== JSON.stringify(entry.paramSchema)
      )
        throw new Error(`ShaderRegistry: ${identifier}@1 reused with different schema content`);
    }
    // Only private registered entries reach this commit. Their source, schema
    // and receipt are owned; admission reuses the existing immutable interface
    // while recording the receiving registry's own projection and lifetime.
    for (const [identifier, publication] of entries) {
      const entry = publication.value;
      const projection = this.#paramSchemaProjectionOwner.admit({
        ownerId: identifier,
        revision: 1,
        schema: entry.paramSchema,
      });
      const cachedProgram = this.#materialPrograms.get(entry.source);
      const program =
        cachedProgram?.entryPoints === undefined && entry.program.entryPoints !== undefined
          ? entry.program
          : (cachedProgram ?? entry.program);
      this.#materialPrograms.set(entry.source, program);
      this.#materialShaders.set(
        identifier,
        Object.freeze(
          ok(
            Object.freeze({
              ...entry,
              source: program.source,
              program,
              paramSchema: projection.schema,
              paramSchemaProjection: projection,
            }),
          ),
        ),
      );
    }
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
    return entry;
  }

  /** Optional immutable artifact lookup; normal misses do not construct diagnostics. */
  materialArtifact(identifier: string): RegisteredMaterialShaderEntry | undefined {
    return this.#materialShaders.get(identifier)?.value;
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
  materialShaderManifestEntries(): IterableIterator<MaterialShaderManifestEntry> {
    return this.#materialShaderManifestEntries.values();
  }

  /** Resolve one validated material manifest row without enumerating the publication. */
  materialShaderManifestEntry(identifier: string): MaterialShaderManifestEntry | undefined {
    return this.#materialShaderManifestEntries.get(identifier);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────────

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
  const v = value as Record<string, unknown>;
  if (typeof v.hash !== 'string') return false;
  if (!hasStringSource(v, 'wgsl')) return false;
  // glsl allows string | undefined | null (manifest.json may serialize null as
  // 'glsl: null').
  if (v.glsl !== undefined && v.glsl !== null && typeof v.glsl !== 'string') return false;
  if (typeof v.bindings !== 'string') return false;
  if (v.entryPoints !== undefined && !isShaderEntryPointReads(v.entryPoints)) return false;
  return true;
}

function isValidMaterialShaderManifestEntry(value: unknown): value is MaterialShaderManifestEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.identifier !== 'string') return false;
  if (typeof v.sourcePath !== 'string') return false;
  if (!hasStringSource(v, 'composedWgsl')) return false;
  if (v.entryPoints !== undefined && !isShaderEntryPointReads(v.entryPoints)) return false;
  if (typeof v.paramSchema !== 'string') return false;
  if (!Array.isArray(v.variants)) return false;
  if (!v.variants.every(isValidMaterialShaderManifestVariant)) return false;
  return (
    (v.receipt === undefined || isMaterialProgramAbi(v.receipt)) &&
    (v.uvSetCount === undefined || typeof v.uvSetCount === 'number')
  );
}

function isValidMaterialShaderManifestVariant(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.definesKey !== 'string') return false;
  if (!hasStringSource(v, 'composedWgsl')) return false;
  if (v.entryPoints !== undefined && !isShaderEntryPointReads(v.entryPoints)) return false;
  if (typeof v.defines !== 'object' || v.defines === null || Array.isArray(v.defines)) {
    return false;
  }
  return (
    Object.values(v.defines).every((define) => typeof define === 'boolean') &&
    (v.receipt === undefined || isMaterialProgramAbi(v.receipt))
  );
}

function buildMaterialShaderVariantKey(defines: Record<string, boolean>): string {
  const entries = Object.entries(defines).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.every(([, value]) => value)
    ? ''
    : entries.map(([key, value]) => `${key}=${value}`).join('+');
}
