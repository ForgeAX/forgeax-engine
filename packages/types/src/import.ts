import type { AssetStageErrorBase } from './asset-errors.js';
import type { SourceOverrideErrorCode, SourceOverrideMap } from './asset-producer.js';
import type { PackIndexEntry } from './catalog.js';
import type { Asset, AssetCodec, AssetRef, ImageError, TextureAsset } from './index.js';

export type ImportStageContractError = AssetStageErrorBase<'import', 'import-failed'>;

// === Import contract SSOT (feat-20260603-asset-import-loader-injection M2 / w12) ===
//
// Decision anchors:
//   - requirements AC-07 (Importer dispatched by `meta.importer` string key) +
//     AC-08 (`importer-not-registered` fail-fast) + AC-09 (GUID import-stable
//     iron law: `guid-mismatch` / `import-produced-no-assets`) + AC-10
//     (`ImportErrorCode` is a closed union with exhaustive switch without default)
//   - plan-strategy D-6 (error model add-only: `ImportErrorCode` is an
//     independent closed union, not folded into `AssetErrorCode`) + D-1
//     (`ImporterRegistry` register/get/fail-fast mirrors LoaderRegistry) + D-4
//     (import runner skips the reserved `importer: 'shader'` key)
//   - research Finding 8 (`ImportTransport` interface slot; HTTP adapter is
//     OOS-2, landed in M4) + Finding 9 (`PackError` four-field shape is the
//     structural template)
//   - charter P3 (structured failure: `.code` / `.expected` / `.hint` /
//     `.detail`; AI users consume via property access, never `.message`
//     parsing) + P4 (consistent abstraction, structurally parallel to
//     `PackError` / `AssetError`)
//
// The import side is the build-time half of the import/load split. An
// `Importer` turns an external source (a `.gltf` / `.png` / `.ttf` on disk)
// plus its `*.meta.json` GUID declarations into in-memory `ImportedAsset[]`
// (internal `Asset` PODs stamped with the meta-declared GUIDs). The import
// runner then materializes those into the DDC (`.pack.json` / `.bin`). The
// `Importer` itself stays pure of disk write + GUID minting — it consumes the
// meta-declared GUIDs (GUID import-stable iron law) and emits PODs only.

/**
 * Closed `ImportErrorCode` union for build-time import failures.
 * Used exclusively by the build-time `@forgeax/engine-import` runner +
 * `ImporterRegistry` fail-fast chain. Domain-separated from the runtime
 * `AssetErrorCode` (the `loadByGuid` / `get` surface) and the disk-scanner
 * `PackErrorCode` — disjoint lifecycle phases. Counts evolve; see
 * AGENTS.md §Error model for the live roster.
 *
 * Exhaustive `switch (err.code)` needs no `default:` — TypeScript guards
 * union completeness at compile time (charter P2 machine-readable union >
 * prose + P3 explicit failure).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'importer-not-registered'` | the import runner read `meta.importer` but the injected `ImporterRegistry` has no importer for that key; `.detail.importer` is the missing key and `.detail.registeredImporters` lists the keys currently wired (charter P3 — AI users read `.detail.registeredImporters` to know what to inject). |
 * | `'source-read-failed'` | the source file referenced by `meta.source` could not be read (missing / unreadable); `.detail.source` is the path and `.detail.reason` the underlying error string. |
 * | `'import-produced-no-assets'` | the importer returned an empty `ImportedAsset[]`, or omitted a GUID that `meta.subAssets[]` declared (the produced GUID set is not a superset of the declared set); `.detail.missingGuids` lists the declared GUIDs the importer failed to produce. |
 * | `'guid-mismatch'` | the importer produced a GUID that `meta.subAssets[]` never declared (violates the GUID import-stable iron law); `.detail.unexpectedGuids` lists the produced GUIDs absent from the declared set. |
 * | `'import-internal-error'` | the importer failed at runtime. Two sub-cases ride `.detail`: a build-time module-LOAD failure surfaces `.detail.loadError`, while a conversion THROW surfaces `.detail.reason`. |
 * | `'source-validation-failed'` | the source was readable but failed an authoring rule; `.detail.diagnostics` contains source-located, machine-readable findings. |
 */
export type ImportErrorCode =
  | SourceOverrideErrorCode
  | 'importer-not-registered'
  | 'source-read-failed'
  | 'import-produced-no-assets'
  | 'guid-mismatch'
  | 'mesh-material-slot-topology-change'
  | 'mesh-lod-contract-invalid'
  | 'mesh-lod-topology-change'
  | 'mesh-lod-authority-conflict'
  | 'import-internal-error'
  | 'source-validation-failed';

/** A source range shared by all import diagnostics. */
export interface ImportSourceRange {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

/** A related source location for a cross-file import diagnostic. */
export interface ImportDiagnosticLocation {
  readonly sourcePath: string;
  readonly sourceRange: ImportSourceRange;
}

/** Machine-readable provenance for one blocking or quality import finding. */
export interface ImportDiagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly sourcePath: string;
  readonly sourceRange: ImportSourceRange;
  readonly rule: string;
  readonly expected: string;
  readonly actual: string;
  readonly hint: string;
  readonly relatedLocations?: readonly ImportDiagnosticLocation[];
}

/**
 * Discriminated detail union for {@link ImportError} — narrowed per
 * `ImportError.code`. AI users access `err.detail.<field>` directly after
 * `switch (err.code)` narrows the variant. Structurally parallel to
 * `PackErrorDetail` (the `code` field is intentionally absent from each
 * variant; identify via the top-level `ImportError.code`).
 */
export type ImportErrorDetail =
  | {
      /** The `meta.importer` key with no registered importer. */
      readonly importer: string;
      /** The importer keys currently wired into the registry (insertion order). */
      readonly registeredImporters: readonly string[];
    }
  | {
      /** The `meta.source` path that could not be read. */
      readonly source: string;
      /** The underlying read error message. */
      readonly reason: string;
    }
  | {
      /** Declared sub-asset GUIDs the importer failed to produce (empty when the importer produced nothing at all). */
      readonly missingGuids: readonly string[];
    }
  | {
      /** Produced GUIDs absent from the `meta.subAssets[]` declared set. */
      readonly unexpectedGuids: readonly string[];
    }
  | {
      /** The original thrown error message (importer loaded but its conversion threw). */
      readonly reason: string;
    }
  | {
      /**
       * The module-load failure message (feat-20260629 D-5): the importer
       * module / native addon could not be loaded at build time (e.g.
       * module-not-found, native-addon-not-built). Distinguishes a LOAD
       * failure from a conversion THROW (`reason`) under the same
       * `import-internal-error` code without growing the closed ImportErrorCode
       * union. AI users branch on `'loadError' in err.detail`.
       */
      readonly loadError: string;
    }
  | {
      /** Source-located authoring findings retained across the import boundary. */
      readonly diagnostics: readonly ImportDiagnostic[];
    }
  | {
      /** Source override identity that failed Meta topology validation. */
      readonly sourceKey?: string;
      readonly declaredSourceKeys: readonly string[];
      readonly reason?: string;
    }
  | {
      readonly meshGuid: string;
      readonly meshSourceKey?: string;
      readonly previousIndices: readonly number[];
      readonly nextIndices: readonly number[];
    }
  | {
      readonly meshLodSourceKey?: string;
      readonly reason: string;
    };

/**
 * Structured import error — four-field surface (`.code` / `.expected` /
 * `.hint` / `.detail`) structurally parallel to `PackError` / `AssetError`
 * (charter P4 consistent abstraction). `.detail` is narrowed per `.code` via
 * {@link ImportErrorDetail}.
 *
 * AI users consume the structured surface via property access:
 * `switch (err.code) { case 'guid-mismatch': ... err.detail.unexpectedGuids ... }`
 * — never by parsing `.message` (charter P3 red line).
 */
export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly expected: string;
  readonly actual?: string;
  readonly hint: string;
  readonly detail: ImportErrorDetail;

  constructor(args: {
    code: ImportErrorCode;
    expected: string;
    actual?: string;
    hint: string;
    detail: ImportErrorDetail;
  }) {
    super(`[ImportError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'ImportError';
    this.code = args.code;
    this.expected = args.expected;
    if (args.actual !== undefined) this.actual = args.actual;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

/**
 * Per-code `.hint` string literals SSOT. `Record<ImportErrorCode, string>`
 * makes a new closed-union member a compile-time error here as well
 * (reinforces charter P3 explicit failure). Consumed by the import runner +
 * tests so the producer and the fixtures share one source of truth.
 */
export const IMPORT_ERROR_HINTS: Readonly<Record<ImportErrorCode, string>> = {
  'importer-not-registered':
    'no importer registered for this meta.importer key; register one via importers.register(importer) (the importer carries its own key, e.g. gltfImporter / imageImporter); err.detail.registeredImporters lists the keys currently wired',
  'source-read-failed':
    'the file at meta.source could not be read; check the path is correct relative to the sidecar and the process has read access',
  'import-produced-no-assets':
    'the importer produced no assets, or omitted a GUID that meta.subAssets[] declared; the produced GUID set must be a superset of the declared set (GUID import-stable iron law); err.detail.missingGuids lists the declared GUIDs not produced',
  'guid-mismatch':
    'the importer produced a GUID that meta.subAssets[] never declared (violates the GUID import-stable iron law: GUIDs come from the external meta, never minted by the importer); err.detail.unexpectedGuids lists the offending GUIDs',
  'mesh-material-slot-topology-change':
    'the importer could not match previous and current Mesh material slots without ambiguity; name source materials uniquely or repair their stable sourceKey values before reimport',
  'mesh-lod-contract-invalid':
    'the normalized MeshAsset LOD contract is invalid; inspect err.detail.reason and repair coverage, hysteresis, references, bounds, or material slots',
  'mesh-lod-topology-change':
    'the source LOD topology changed in the middle of an ordered chain; preserve sourceKey identity and append or remove only at the end before reimporting',
  'mesh-lod-authority-conflict':
    'the format-owned LOD relation disagrees with the authored sidecar; repair the source or sidecar explicitly before publishing',
  'import-internal-error':
    'the importer failed at runtime; branch on err.detail: a conversion THROW carries err.detail.reason (the loaded importer threw while converting the source — an importer bug, not a meta / source problem), while a build-time module-LOAD failure carries err.detail.loadError (the host importer module / native addon could not be imported)',
  'source-validation-failed':
    'the source violates an import authoring rule; inspect err.detail.diagnostics fields (code, sourcePath, sourceRange, rule, expected, actual, hint, and relatedLocations) and fix the referenced source',
  'unknown-source-key':
    'sourceOverrides contains a key absent from meta.subAssets[]; refresh the producer topology and use one of err.detail.declaredSourceKeys',
  'duplicate-source-key':
    'the producer declared the same sourceKey more than once; repair the Meta topology before importing',
  'invalid-source-overrides':
    'sourceOverrides must be an object keyed by producer-owned sourceKey values',
  'invalid-source-override-payload':
    'each sourceOverrides value must be a producer-owned object validated by the importer',
};

/**
 * One asset produced by an {@link Importer}: the meta-declared `guid`, the
 * in-memory `Asset` POD, and its outbound GUID cross-references (`refs`). The
 * import runner folds these into the DDC `.pack.json` `assets[]` rows (one
 * `ImportedAsset` -> one `{ guid, kind, payload, refs }` row).
 *
 * The `guid` always comes from `meta.subAssets[].guid` (GUID import-stable
 * iron law) — the importer never mints it; it reads the declared GUID off the
 * meta and stamps it here. `kind` mirrors the `Asset.kind` discriminant so the
 * DDC row and the runtime loader dispatch on the same string.
 */
export interface ImportedAsset<P = Asset> {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly payload: P;
  readonly refs: readonly AssetRef[];
  readonly artifacts: Readonly<Record<string, ImportedArtifactBody>>;
}

/**
 * One declared sub-asset entry the import runner hands to an
 * {@link Importer.import} call — the meta-declared `guid` + its `sourceIndex`
 * + `kind`. Mirrors the `meta.subAssets[]` rows so the importer can map a
 * source object index to the GUID it must stamp (GUID import-stable iron law).
 */
export interface ImportSubAsset {
  readonly guid: string;
  readonly sourceIndex: number;
  /** Producer-owned semantic identity used to look up sourceOverrides. */
  readonly sourceKey?: string;
  readonly kind: string;
}

/**
 * Six finite values describing producer-authored animated local bounds:
 * `[minX, minY, minZ, maxX, maxY, maxZ]`.
 *
 * The source producer (or its external-asset sidecar) owns these facts. A
 * missing or malformed row is deliberately rejected by the reader so a
 * renderer can keep the skin on its CPU deformation lane; it must never
 * synthesize bounds from a bind-pose mesh AABB.
 */
export type ConservativeAnimatedBounds = readonly [number, number, number, number, number, number];

/** Accepted `*.meta.json#importSettings` producer contract for animated skin bounds. */
export interface AnimatedSkinImportSettings {
  readonly conservativeAnimatedBounds?: readonly (readonly number[])[];
}

/**
 * Validate one producer-authored bounds row and copy it into the runtime POD.
 * The copy prevents an importer from retaining a mutable JSON array and keeps
 * malformed author facts out of the GPU culling contract.
 */
export function parseConservativeAnimatedBounds(value: unknown): Float32Array | undefined {
  if (!Array.isArray(value) || value.length !== 6) return undefined;
  const bounds = value.map((entry) => (typeof entry === 'number' ? entry : Number.NaN));
  const [minX, minY, minZ, maxX, maxY, maxZ] = bounds;
  if (
    minX === undefined ||
    minY === undefined ||
    minZ === undefined ||
    maxX === undefined ||
    maxY === undefined ||
    maxZ === undefined ||
    ![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite) ||
    minX > maxX ||
    minY > maxY ||
    minZ > maxZ
  ) {
    return undefined;
  }
  return new Float32Array(bounds);
}

/** Read the source-indexed bounds row from the shared importSettings schema. */
export function readConservativeAnimatedBounds(
  importSettings: Readonly<Record<string, unknown>>,
  sourceIndex: number,
): Float32Array | undefined {
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0) return undefined;
  const rows = importSettings.conservativeAnimatedBounds;
  if (!Array.isArray(rows)) return undefined;
  return parseConservativeAnimatedBounds(rows[sourceIndex]);
}

/**
 * Capabilities + declarations the import runner wires into an
 * {@link Importer.import} call. The importer reads the source bytes via
 * `readSource`, the GUID declarations via `subAssets`, and the free-form
 * importer settings via `importSettings`. It stays pure of disk write +
 * registry bookkeeping (pipeline isolation, architecture-principles #4).
 *
 *   - `source` — the `meta.source` path (relative to the sidecar), for
 *     diagnostics + the importer's own external-resource resolution base.
 *   - `readSource()` — fetch the raw source bytes (the runner has already
 *     resolved the path); a structured failure here surfaces as
 *     `source-read-failed`.
 *   - `subAssets` — the `meta.subAssets[]` GUID declarations the importer must
 *     honour (GUID import-stable iron law).
 *   - `importSettings` — free-form importer settings copied verbatim from the
 *     sidecar.
 *   - `readSibling(uri)` — fetch raw bytes of a file co-located with the
 *     primary source (e.g. an `.gltf` referencing an external `.bin` /
 *     `.png` via relative URI). Failures surface as `source-read-failed`
 *     (C-6 — no specialised error code; the URI is forensic detail). Used
 *     by gltfImporter to resolve `images[].uri` external references at
 *     import time.
 *   - `decodeImage(bytes, mimeType, importSettings)` — decode raw image
 *     bytes (PNG / JPEG) into a `TextureAsset` POD plus a `bytes` copy
 *     suitable for `<guid>.bin` emission. When the host applies an offline
 *     delivery codec, it also returns the artifact media type and codec so
 *     gltfImporter can preserve those facts in the Pack v2 envelope. The seam
 *     keeps gltfImporter
 *     out of `@forgeax/engine-image` (D-1: zero static `from
 *     '@forgeax/engine-image'` edge in `packages/gltf/src`). The
 *     concrete implementation (parseImage + format derivation) lives
 *     behind `@forgeax/engine-image/image-importer`; the build-time
 *     orchestrator (vite-plugin-pack / cli-gltf / tests) binds the
 *     callback when constructing the runner's `ImportRunnerFs`.
 */
export interface ImportContext {
  readonly source: string;
  readSource(): Promise<
    | { readonly ok: true; readonly value: Uint8Array }
    | { readonly ok: false; readonly error: unknown }
  >;
  readSibling(
    uri: string,
  ): Promise<
    | { readonly ok: true; readonly value: Uint8Array }
    | { readonly ok: false; readonly error: ImportError }
  >;
  decodeImage(
    bytes: Uint8Array,
    mimeType: 'image/png' | 'image/jpeg' | 'image/x-tga',
    importSettings: Readonly<Record<string, unknown>>,
  ): Promise<
    | {
        readonly ok: true;
        readonly value: {
          readonly texture: TextureAsset;
          readonly bytes: Uint8Array;
          readonly mediaType?: string;
          readonly assetCodec?: AssetCodec;
        };
      }
    | { readonly ok: false; readonly error: ImageError }
  >;
  readonly subAssets: readonly ImportSubAsset[];
  readonly importSettings: Readonly<Record<string, unknown>>;
  /** Optional Meta author facts passed through without importer-kind branching. */
  readonly sourceOverrides?: SourceOverrideMap;
}

/**
 * Build-time importer injected into the `ImporterRegistry`. One importer per
 * `meta.importer` key; the import runner dispatches on the key.
 *
 * `import` is pure of disk write + GUID minting: it reads the source via
 * `ctx.readSource()`, honours the `ctx.subAssets[]` GUID declarations, and
 * returns the produced `ImportedAsset[]`. The runner validates the produced
 * GUID set against the declared set (GUID import-stable iron law) and writes
 * the DDC. A thrown error is wrapped by the runner into
 * `import-internal-error` (charter P3) — importers may throw, but should
 * prefer returning a partial / empty result so the runner can attribute the
 * failure precisely.
 */
export interface ImportProductFinalizeArtifact {
  readonly path: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface ImportProductFinalizeOptions {
  readonly artifactUrl: (artifact: ImportProductFinalizeArtifact) => string;
}

export type ImportProductFinalizeResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly asset: unknown;
        readonly artifacts: readonly { readonly path: string; readonly mimeType: string }[];
      };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly expected: string;
        readonly hint: string;
        readonly detail: unknown;
      };
    };

/** Optional producer capability exposed to the generic import runner. */
export interface ImporterCapabilities {
  readonly decodeImage?: ImportContext['decodeImage'];
  /** Producer-owned Catalog visibility for declarations before materialization. */
  readonly catalog?: {
    readonly publish?: (input: {
      readonly importSettings: Readonly<Record<string, unknown>>;
      readonly subAssets: readonly ImportSubAsset[];
    }) => boolean | Promise<boolean>;
  };
}

export interface Importer {
  readonly key: string;
  // biome-ignore lint/suspicious/noExplicitAny: pending downstream importer migration keeps old consumers source-compatible
  import(ctx: ImportContext): Promise<any> | any;
  readonly capabilities?: ImporterCapabilities;
  /** Optional owner projection for transport artifacts produced by this importer. */
  finalize?: (
    product: ImportProduct<unknown>,
    options: ImportProductFinalizeOptions,
  ) => ImportProductFinalizeResult | Promise<ImportProductFinalizeResult>;
}
/**
 * Interface slot for the M4 lazy-import transport (OOS-2). A runtime
 * `ImportTransport` fetches a missing DDC artefact on demand (the shipped form
 * never falls back to a runtime import; see `AssetErrorCode 'asset-not-imported'`).
 * Declared here as a contract seam only — the HTTP adapter lands in M4 w31;
 * M2 does not implement it (plan-strategy D-6 / research Finding 8).
 */
export interface ImportTransport {
  /**
   * Trigger an on-demand DDC import for a GUID at runtime. On success the
   * transport returns the freshly imported catalog rows for the GUID (and any
   * sub-asset siblings produced by the same import) so the caller patches just
   * those rows into its catalog cache -- per-asset incremental, never a
   * whole-catalog re-fetch (the four-verb redesign, 2026-06-06). `entries` may
   * be empty when the transport imported the artefact but does not surface the
   * rows; the caller then re-resolves the GUID from its (possibly stale) cache.
   * `ok: false` means the import did not produce an artefact and the caller
   * surfaces `asset-not-imported`.
   */
  fetchPack(
    guid: string,
    scope?: Pick<
      import('./runtime-scope.js').RuntimeAssetBinding,
      'scopeId' | 'generation' | 'status'
    >,
  ): Promise<
    { readonly ok: true; readonly entries?: readonly PackIndexEntry[] } | { readonly ok: false }
  >;
}

/** A normalized filesystem path observed by an importer read attempt. */
export type SourceDependency = string;

/** Logical artifact content emitted by one imported asset. */
export interface ImportedArtifactBody {
  readonly delivery?: 'stream';
  readonly mediaType: string;
  readonly assetCodec?: AssetCodec;
  readonly bytes: Uint8Array;
}

/** Generic import output shared by every importer and transport. */
export interface ImportProduct<P = Asset> {
  readonly assets: readonly ImportedAsset<P>[];
  readonly sourceDependencies: readonly SourceDependency[];
}

/** Structured result returned by an importer. */
export type ImportResult<P = Asset> =
  | { readonly ok: true; readonly value: ImportProduct<P> }
  | { readonly ok: false; readonly error: ImportError };

/* ImportTransport is intentionally kept with the build-time contract. */
