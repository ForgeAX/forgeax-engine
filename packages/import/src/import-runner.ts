// @forgeax/engine-import - import runner (feat-20260603-asset-import-loader-injection M2 / w15).
//
// The build-time orchestration that turns one parsed `*.meta.json` sidecar
// into the logical Pack v2 package. It is the consumer side of
// the ImporterRegistry: it reads `meta.importer`, looks up the registered
// Importer, calls `importer.import(ctx)`, enforces the GUID import-stable iron
// law against the produced asset source values apply, then folds the produced PODs into
// logical `assets[]` rows. Artifact bytes stay with their owning asset;
// final paths and integrity belong to M3.
//
// Error model (charter P3, ImportErrorCode 5 closed members):
//   - importer-not-registered  : registry.get(meta.importer) === undefined
//   - source-read-failed       : ctx.readSource() failed
//   - import-internal-error    : importer conversion or CookProduct finalization threw (never bare-throws out)
//   - guid-mismatch            : produced a GUID not declared in subAssets[]
//   - import-produced-no-assets: produced [], or omitted a declared GUID
//
// The reserved key `importer: 'shader'` is skipped (plan-strategy D-4 /
// research Finding 10): shader sidecars are consumed by the orthogonal
// `@forgeax/engine-vite-plugin-shader` transform pipeline, never by asset
// import. `runImport` returns `{ ok: true, value: { skipped: 'shader' } }`
// for them so the caller can account for the sidecar without writing a DDC.

import type { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import type {
  AssetRelation,
  CatalogDiagnostic,
  CookProduct,
  ImportContext,
  ImportDiagnostic,
  ImportError as ImportErrorType,
  ImportedArtifactBody,
  ImportProduct,
  ProviderProvenance,
  ResourceRevision,
  SourceOverrideMap,
} from '@forgeax/engine-types';
import {
  canonicalizeSourceOverrides,
  IMPORT_ERROR_HINTS,
  ImportError,
  validateSourceOverrideMap,
} from '@forgeax/engine-types';
import {
  createImportProduct,
  finalizeImportProducts,
  type TerminalImportProduct,
} from './import-product.js';
import { cookImportedMaterials } from './imported-material-cook.js';
import type { ImporterRegistry } from './importer-registry.js';
import { validateMeshLodContract } from './mesh-lod.js';
import { normaliseForPack } from './pack-value.js';

export { normaliseForPack } from './pack-value.js';

/** Reserved `meta.importer` key consumed by vite-plugin-shader, not the import runner. */
export const SHADER_RESERVED_IMPORTER_KEY = 'shader';

/**
 * Classify an importer throw as a build-time module-LOAD failure (the importer
 * module / native addon could not be imported) vs a conversion THROW (the
 * loaded importer ran and threw). feat-20260629 D-5: both keep the
 * `import-internal-error` code, but a load failure surfaces `.detail.loadError`
 * so AI users distinguish "my importer is not loadable / not built" from "my
 * importer ran and crashed" without parsing `.message`.
 *
 * Node signals a module-load failure via `err.code` (`MODULE_NOT_FOUND` for
 * CJS `require`, `ERR_MODULE_NOT_FOUND` for ESM `import()`, `ERR_DLOPEN_FAILED`
 * for a broken native `.node` addon) or a recognizable message. Native FBX-style
 * bindings throw a plain Error whose message names the missing addon.
 */
function isModuleLoadFailure(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  if (
    code === 'MODULE_NOT_FOUND' ||
    code === 'ERR_MODULE_NOT_FOUND' ||
    code === 'ERR_DLOPEN_FAILED'
  ) {
    return true;
  }
  const msg = e.message;
  return (
    msg.includes('Cannot find module') || msg.includes('native addon') || msg.includes('.node')
  );
}

function declarationsSourceKey(
  declarations: readonly { readonly guid: string; readonly sourceKey?: string }[],
  guid: string,
): string | undefined {
  return declarations.find((declaration) => declaration.guid === guid)?.sourceKey;
}

/** Result envelope returned by {@link runImport} (mirrors the engine `Result<T,E>` shape). */
export type RunImportResult =
  | { readonly ok: true; readonly value: RunImportOk }
  | { readonly ok: false; readonly error: ImportErrorType };

export type RunImportProductResult =
  | {
      readonly ok: true;
      readonly value:
        | { readonly skipped: 'shader' }
        | {
            readonly product: TerminalImportProduct;
            readonly cookProducts: readonly CookProduct[];
          };
    }
  | { readonly ok: false; readonly error: ImportErrorType };

/**
 * Success payload. `skipped: 'shader'` marks a reserved shader sidecar the
 * runner intentionally did not import (no DDC written); otherwise `pack` is the
 * logical Pack v2 document. Artifact bytes remain owned by each asset.
 */
export type RunImportOk =
  | { readonly skipped: 'shader' }
  | {
      readonly product: TerminalImportProduct;
      readonly cookProducts: readonly CookProduct[];
      readonly pack: DdcPack;
    };

/** The logical Pack v2 document consumed by the shared finalizer. */
export interface DdcPack {
  readonly schemaVersion: '2.0.0';
  readonly kind: 'internal-text-package';
  readonly packageId?: string;
  readonly provenance?: ProviderProvenance;
  readonly revision?: ResourceRevision;
  readonly diagnostics?: readonly CatalogDiagnostic[];
  readonly assets: ReadonlyArray<{
    readonly guid: string;
    readonly kind: string;
    readonly name?: string;
    readonly sourceKey?: string;
    readonly sourceIndex?: number;
    readonly relations?: readonly AssetRelation[];
    readonly payload: Record<string, unknown>;
    readonly refs: readonly string[];
    readonly artifacts: Readonly<Record<string, ImportedArtifactBody>>;
  }>;
}

/** Minimal parsed-meta shape the runner reads (a superset of the sidecar). */
export interface RunImportMeta {
  readonly importer: string;
  readonly source: string;
  /** Scanner-owned source declaration revision; avoids reopening validated Meta. */
  readonly sourceRevision?: string;
  readonly packageId?: string;
  readonly provenance?: ProviderProvenance;
  readonly revision?: ResourceRevision;
  readonly diagnostics?: readonly CatalogDiagnostic[];
  readonly importSettings?: Readonly<Record<string, unknown>>;
  readonly sourceOverrides?: SourceOverrideMap;
  /** Skip the normalized DDC pack when a downstream finalizer owns publication. */
  readonly buildPack?: boolean;
  readonly subAssets: ReadonlyArray<{
    readonly guid: string;
    readonly sourceIndex: number;
    readonly kind: string;
    readonly sourceKey?: string;
    readonly relations?: readonly AssetRelation[];
  }>;
}

function declarationFields(
  declaration: RunImportMeta['subAssets'][number] | undefined,
): Pick<DdcPack['assets'][number], 'sourceKey' | 'sourceIndex' | 'relations'> {
  if (declaration === undefined) return {};
  return {
    sourceIndex: declaration.sourceIndex,
    ...(declaration.sourceKey !== undefined ? { sourceKey: declaration.sourceKey } : {}),
    ...(declaration.relations !== undefined ? { relations: declaration.relations } : {}),
  };
}

/** Filesystem + decode capabilities the runner needs to drive an importer.
 *
 * `readSource` reads the primary source bytes addressed by `meta.source`.
 * `readSibling` reads a co-located file (e.g. an external `.bin` / `.png`
 * referenced from a `.gltf` via relative URI). Optional today so existing
 * callers stay green; importers that depend on it (gltfImporter texture
 * external-uri path) gate on its presence and surface a structured
 * `'source-read-failed'` ImportError when the host did not wire it.
 *
 * `decodeImage` is the M3 D-1 seam: gltfImporter funnels all three image
 * sources (bufferView / data-uri / external-uri) through one callback so
 * `@forgeax/engine-gltf` carries no `from '@forgeax/engine-image'` edge
 * (the grep gate `packages/gltf/scripts/check-no-image-import.mjs` enforces
 * this). The concrete decode lives in `@forgeax/engine-image/image-importer`;
 * the build-time orchestrator binds the callback when constructing this
 * `ImportRunnerFs`.
 */
export interface ImportRunnerFs {
  /**
   * Map a physical read path to the host's stable logical source identity.
   *
   * Hosts may expose the same source through different filesystem coordinates
   * (for example a symlink farm in a browser Vite root).  The identity is used
   * only for dependency/revision facts; `readSource` and `readSibling` still
   * receive the physical path supplied by the importer.
   */
  sourceIdentityFor?(sourcePath: string): string;
  readSource(
    sourcePath: string,
  ): Promise<
    | { readonly ok: true; readonly value: Uint8Array }
    | { readonly ok: false; readonly error: unknown }
  >;
  readSibling?(
    sourcePath: string,
    uri: string,
  ): Promise<
    | { readonly ok: true; readonly value: Uint8Array }
    | { readonly ok: false; readonly error: unknown }
  >;
  decodeImage?: ImportContext['decodeImage'];
}

/**
 * Resolve an `images[].uri` (or any sibling reference) against the directory
 * of `meta.source`. Pure path arithmetic — no I/O. Used as the default
 * `readSibling` fallback when the host did not wire one explicitly.
 */
function joinSiblingPath(sourcePath: string, uri: string): string {
  const slash = Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\'));
  const dir = slash >= 0 ? sourcePath.slice(0, slash + 1) : '';
  return `${dir}${uri}`;
}

function normalizeDependencyPath(path: string): string {
  const slash = path.replaceAll('\\', '/');
  const parts: string[] = [];
  for (const part of slash.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function dependencyIdentity(fs: ImportRunnerFs, sourcePath: string): string {
  return normalizeDependencyPath(fs.sourceIdentityFor?.(sourcePath) ?? sourcePath);
}

function errResult(error: ImportErrorType): {
  readonly ok: false;
  readonly error: ImportErrorType;
} {
  return { ok: false, error };
}

function sourceKeyActual(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'missing';
  return typeof value;
}

type SourceReaderErrorMetadata = {
  readonly code?: unknown;
  readonly name?: unknown;
  readonly message?: unknown;
  readonly detail?: unknown;
};

function sourceReadFailureReason(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return typeof error === 'string' ? error : 'unknown';
  }
  const metadata = error as SourceReaderErrorMetadata;
  const token =
    typeof metadata.code === 'string'
      ? metadata.code
      : typeof metadata.name === 'string'
        ? metadata.name
        : undefined;
  switch (token) {
    case 'ENOENT':
    case 'NotFoundError':
      return 'not-found';
    case 'EACCES':
    case 'EPERM':
    case 'PermissionDeniedError':
    case 'NotAllowedError':
    case 'SecurityError':
      return 'permission-denied';
    case 'EAGAIN':
    case 'EBUSY':
    case 'EINTR':
    case 'ECONNABORTED':
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'EHOSTUNREACH':
    case 'ENETDOWN':
    case 'ENETUNREACH':
    case 'ETIMEDOUT':
    case 'EPIPE':
    case 'ABORT_ERR':
    case 'AbortError':
    case 'TimeoutError':
      return 'transient';
    default:
      if (typeof metadata.detail === 'object' && metadata.detail !== null) {
        const reason = (metadata.detail as { readonly reason?: unknown }).reason;
        if (typeof reason === 'string' && reason.length > 0) return reason;
      }
      if (typeof metadata.message === 'string' && metadata.message.length > 0) {
        return metadata.message;
      }
      return 'unknown';
  }
}

/**
 * Validate producer identity before source work or DDC product finalization.
 * Multi-output declarations cannot recover identity from sourceIndex, array
 * order, or a path, so every row must carry one unique semantic sourceKey.
 * Single-output declarations may omit the key for legacy source compatibility;
 * producers that expose a semantic output should still declare it so Catalog
 * evidence remains stable when the output later gains siblings.
 */
function validateOutputSourceKeys(meta: RunImportMeta): ImportErrorType | undefined {
  if (meta.subAssets.length <= 1) return undefined;

  const diagnostics: ImportDiagnostic[] = [];
  const seen = new Map<string, number>();
  for (const [index, declaration] of meta.subAssets.entries()) {
    const sourcePath = `${meta.source}#subAssets[${index}]`;
    const sourceRange = { start: 0, end: 0, line: 1, column: 1 };
    const sourceKey = declaration.sourceKey;
    if (typeof sourceKey !== 'string' || sourceKey.trim().length === 0) {
      diagnostics.push({
        code: 'source-key-required',
        severity: 'error',
        sourcePath,
        sourceRange,
        rule: 'import-output-source-key',
        expected: 'a non-empty producer-owned sourceKey',
        actual: sourceKeyActual(sourceKey),
        hint: 'publish a stable semantic sourceKey; sourceIndex is only a locator',
      });
      continue;
    }
    const prior = seen.get(sourceKey);
    if (prior !== undefined) {
      diagnostics.push({
        code: 'duplicate-source-key',
        severity: 'error',
        sourcePath,
        sourceRange,
        rule: 'import-output-source-key-unique',
        expected: 'sourceKey to be unique within one imported package',
        actual: `${JSON.stringify(sourceKey)} duplicates subAssets[${prior}]`,
        hint: 'rename the duplicate semantic output before writing Meta',
      });
      continue;
    }
    seen.set(sourceKey, index);
  }
  if (diagnostics.length === 0) return undefined;
  return new ImportError({
    code: 'source-validation-failed',
    expected: 'every writable imported output to declare a unique non-empty sourceKey',
    hint: IMPORT_ERROR_HINTS['source-validation-failed'],
    detail: { diagnostics },
  });
}

/**
 * Run the importer for one parsed meta sidecar and produce its DDC.
 *
 * @param meta the parsed `*.meta.json` (importer + source + subAssets[]).
 * @param registry the wired {@link ImporterRegistry}.
 * @param fs the source-read capability (injected so the runner stays
 *   testable without touching real disk).
 */
export function runImport(
  meta: RunImportMeta & { readonly buildPack: false },
  registry: ImporterRegistry,
  fs: ImportRunnerFs,
  cookers?: Pick<NativeCookerRegistry, 'get' | 'runDraft'>,
): Promise<RunImportProductResult>;
export function runImport(
  meta: RunImportMeta,
  registry: ImporterRegistry,
  fs: ImportRunnerFs,
  cookers?: Pick<NativeCookerRegistry, 'get' | 'runDraft'>,
): Promise<RunImportResult>;
export async function runImport(
  meta: RunImportMeta,
  registry: ImporterRegistry,
  fs: ImportRunnerFs,
  cookers?: Pick<NativeCookerRegistry, 'get' | 'runDraft'>,
): Promise<RunImportResult | RunImportProductResult> {
  // Reserved shader key: orthogonal vite-plugin-shader pipeline owns these.
  if (meta.importer === SHADER_RESERVED_IMPORTER_KEY) {
    return { ok: true, value: { skipped: 'shader' } };
  }

  const sourceKeyError = validateOutputSourceKeys(meta);
  if (sourceKeyError !== undefined) return errResult(sourceKeyError);

  const declaredSourceKeys = meta.subAssets.flatMap((subAsset) =>
    subAsset.sourceKey === undefined ? [] : [subAsset.sourceKey],
  );
  const sourceOverridesResult = validateSourceOverrideMap(meta.sourceOverrides, declaredSourceKeys);
  if (!sourceOverridesResult.ok) {
    const error = new ImportError({
      code: sourceOverridesResult.error.code,
      expected: sourceOverridesResult.error.expected,
      hint: IMPORT_ERROR_HINTS[sourceOverridesResult.error.code],
      detail: {
        sourceKey: sourceOverridesResult.error.actual,
        declaredSourceKeys,
        reason: sourceOverridesResult.error.hint,
      },
    });
    if (sourceOverridesResult.error.actual !== undefined) {
      Object.assign(error, { actual: sourceOverridesResult.error.actual });
    }
    return errResult(error);
  }

  const importer = registry.get(meta.importer);
  if (importer === undefined) {
    return errResult(
      new ImportError({
        code: 'importer-not-registered',
        expected: `an importer registered for meta.importer "${meta.importer}"`,
        hint: IMPORT_ERROR_HINTS['importer-not-registered'],
        detail: {
          importer: meta.importer,
          registeredImporters: registry.registeredImporters(),
        },
      }),
    );
  }

  const dependencies = new Set<string>();
  const readSource = async (sourcePath: string) => {
    dependencies.add(dependencyIdentity(fs, sourcePath));
    try {
      return await fs.readSource(sourcePath);
    } catch (error) {
      return { ok: false as const, error };
    }
  };

  const readSibling = async (
    uri: string,
  ): Promise<
    | { readonly ok: true; readonly value: Uint8Array }
    | { readonly ok: false; readonly error: ImportErrorType }
  > => {
    let inner:
      | { readonly ok: true; readonly value: Uint8Array }
      | { readonly ok: false; readonly error: unknown }
      | { readonly ok: false; readonly error: ImportErrorType };
    try {
      if (fs.readSibling) {
        dependencies.add(dependencyIdentity(fs, joinSiblingPath(meta.source, uri)));
        inner = await fs.readSibling(meta.source, uri);
      } else {
        inner = await readSource(joinSiblingPath(meta.source, uri));
      }
    } catch (error) {
      inner = { ok: false, error };
    }
    if (inner.ok) {
      return { ok: true, value: inner.value };
    }
    return {
      ok: false,
      error: new ImportError({
        code: 'source-read-failed',
        expected: `readable sibling file "${uri}" co-located with meta.source "${meta.source}"`,
        hint: IMPORT_ERROR_HINTS['source-read-failed'],
        detail: {
          source: uri,
          reason: sourceReadFailureReason(inner.error),
        },
      }),
    };
  };

  const decodeImage: ImportContext['decodeImage'] =
    fs.decodeImage ??
    (async () => {
      throw new Error(
        'ImportRunnerFs.decodeImage was not provided; gltfImporter texture extraction requires the host (vite-plugin-pack / cli-gltf / test) to bind decodeImage when constructing the ImportRunnerFs',
      );
    });

  const canonicalSourceOverrides = canonicalizeSourceOverrides(sourceOverridesResult.value);
  const ctx: ImportContext = {
    source: meta.source,
    readSource: () => readSource(meta.source),
    readSibling,
    decodeImage,
    subAssets: meta.subAssets.map(({ guid, sourceIndex, sourceKey, kind }) => ({
      guid,
      sourceIndex,
      ...(sourceKey === undefined ? {} : { sourceKey }),
      kind,
    })),
    importSettings: meta.importSettings ?? {},
    ...(canonicalSourceOverrides === undefined
      ? {}
      : { sourceOverrides: canonicalSourceOverrides }),
  };

  // Probe the source once up-front so a missing/unreadable source surfaces as
  // source-read-failed rather than as an opaque import-internal-error inside
  // the importer (charter P3 precise attribution).
  const sourceProbe = await readSource(meta.source);
  if (!sourceProbe.ok) {
    return errResult(
      new ImportError({
        code: 'source-read-failed',
        expected: `readable source file at meta.source "${meta.source}"`,
        hint: IMPORT_ERROR_HINTS['source-read-failed'],
        detail: {
          source: meta.source,
          reason: sourceReadFailureReason(sourceProbe.error),
        },
      }),
    );
  }

  let product: ImportProduct;
  try {
    const imported = (await importer.import(ctx)) as
      | { readonly ok: boolean; readonly value?: ImportProduct; readonly error?: ImportErrorType }
      | undefined;
    if (
      imported === undefined ||
      imported === null ||
      typeof imported !== 'object' ||
      !('ok' in imported)
    ) {
      throw new Error(
        'importer returned a legacy or malformed result; expected ImportResult<ImportProduct>',
      );
    } else {
      if (!imported.ok) {
        if (imported.error === undefined)
          throw new Error('importer returned an invalid failure result');
        if (imported.error instanceof ImportError) return errResult(imported.error);
        return errResult(
          new ImportError({
            code: 'import-internal-error',
            expected: `importer "${meta.importer}" to return a structured ImportError`,
            hint: IMPORT_ERROR_HINTS['import-internal-error'],
            detail: { reason: String(imported.error) },
          }),
        );
      }
      if (imported.value === undefined)
        throw new Error('importer returned an invalid success result');
      const value = imported.value;
      if (
        value === undefined ||
        !Array.isArray(value.assets) ||
        !Array.isArray(value.sourceDependencies) ||
        'artifacts' in value
      ) {
        throw new Error('importer returned an invalid ImportProduct');
      }
      for (const asset of value.assets) {
        if (
          asset === null ||
          typeof asset !== 'object' ||
          !('artifacts' in asset) ||
          asset.artifacts === null ||
          typeof asset.artifacts !== 'object' ||
          Array.isArray(asset.artifacts)
        ) {
          throw new Error('importer returned an asset without local artifacts');
        }
      }
      product = value;
    }
  } catch (e) {
    if (e instanceof ImportError) return errResult(e);
    const message = e instanceof Error ? e.message : String(e);
    // D-5: a module-LOAD failure rides `.detail.loadError`; a conversion THROW
    // rides `.detail.reason`. Same `import-internal-error` code (no new closed
    // union member); AI users branch on the `.detail` shape.
    if (isModuleLoadFailure(e)) {
      return errResult(
        new ImportError({
          code: 'import-internal-error',
          expected: `importer module "${meta.importer}" to load (module + native addon present)`,
          hint: IMPORT_ERROR_HINTS['import-internal-error'],
          detail: { loadError: message },
        }),
      );
    }
    return errResult(
      new ImportError({
        code: 'import-internal-error',
        expected: `importer "${meta.importer}" to convert the source without throwing`,
        hint: IMPORT_ERROR_HINTS['import-internal-error'],
        detail: { reason: message },
      }),
    );
  }

  const produced = product.assets;

  // LOD is a producer-authored MeshAsset fact. Validate it once at the
  // import boundary so malformed coverage never reaches DDC or runtime.
  for (const asset of produced) {
    if (asset.kind !== 'mesh' || asset.payload === null || typeof asset.payload !== 'object')
      continue;
    const payload = asset.payload as {
      readonly lods?: readonly {
        readonly mesh?: unknown;
        readonly meshGuid?: unknown;
        readonly screenCoverage?: unknown;
      }[];
      readonly lodHysteresis?: unknown;
    };
    if (payload.lods === undefined) continue;
    const lods = payload.lods.map((level) => ({
      meshGuid:
        typeof level.meshGuid === 'string'
          ? level.meshGuid
          : typeof level.mesh === 'string'
            ? level.mesh
            : JSON.stringify(level.mesh),
      screenCoverage: level.screenCoverage,
    }));
    const validated = validateMeshLodContract({
      lods: lods as readonly { meshGuid: string; screenCoverage: number }[],
      ...(payload.lodHysteresis === undefined
        ? {}
        : { lodHysteresis: payload.lodHysteresis as number }),
    });
    if (!validated.ok) {
      return errResult(
        new ImportError({
          code: validated.error.code,
          expected: 'MeshAsset LOD facts to satisfy the shared contract',
          hint: IMPORT_ERROR_HINTS[validated.error.code],
          detail: {
            meshLodSourceKey: declarationsSourceKey(meta.subAssets, asset.guid),
            reason: validated.error.reason,
            ...(validated.error.code === 'mesh-lod-topology-change'
              ? {
                  previousIndices: validated.error.previousIndices,
                  nextIndices: validated.error.nextIndices,
                }
              : {}),
          },
        }),
      );
    }
  }

  // GUID import-stable iron law: the produced GUID set must be a superset of
  // the declared set, and must not contain any GUID the meta never declared.
  const declared = new Set(meta.subAssets.map((s) => s.guid));
  const producedGuids = new Set(produced.map((a) => a.guid));

  const unexpectedGuids = [...producedGuids].filter((g) => !declared.has(g));
  if (unexpectedGuids.length > 0) {
    return errResult(
      new ImportError({
        code: 'guid-mismatch',
        expected: 'every produced GUID to be declared in meta.subAssets[]',
        hint: IMPORT_ERROR_HINTS['guid-mismatch'],
        detail: { unexpectedGuids },
      }),
    );
  }

  const missingGuids = [...declared].filter((g) => !producedGuids.has(g));
  if (produced.length === 0 || missingGuids.length > 0) {
    return errResult(
      new ImportError({
        code: 'import-produced-no-assets',
        expected:
          produced.length === 0
            ? 'the importer to produce at least one ImportedAsset'
            : 'the produced GUID set to be a superset of meta.subAssets[]',
        hint: IMPORT_ERROR_HINTS['import-produced-no-assets'],
        detail: { missingGuids },
      }),
    );
  }

  let materialCookFingerprints: readonly string[];
  try {
    const cooked = await cookImportedMaterials(product, meta, cookers);
    product = cooked.product;
    materialCookFingerprints = cooked.fingerprints;
    if (materialCookFingerprints.length > 0)
      for (const path of product.sourceDependencies) dependencies.add(dependencyIdentity(fs, path));
  } catch (error) {
    if (error instanceof ImportError) return errResult(error);
    return errResult(
      new ImportError({
        code: 'import-internal-error',
        expected: 'the registered material cooker to finish before source publication',
        hint: 'repair the imported material or its cooker and rebuild the source package',
        detail: { reason: error instanceof Error ? error.message : String(error) },
      }),
    );
  }

  const declarations = new Map(
    meta.subAssets.map((declaration) => [declaration.guid, declaration]),
  );
  const productWithDependencies = {
    ...product,
    sourceDependencies: [...dependencies],
  };
  const inputFingerprint = `source:${[...dependencies].sort().join('|')}${materialCookFingerprints.length === 0 ? '' : `|native:${materialCookFingerprints.join('|')}`}`;
  let cookProducts: readonly CookProduct[];
  try {
    cookProducts = await finalizeImportProducts(productWithDependencies, inputFingerprint);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return errResult(
      new ImportError({
        code: 'import-internal-error',
        expected: `importer "${meta.importer}" finalization to produce complete CookProduct digests`,
        hint: IMPORT_ERROR_HINTS['import-internal-error'],
        detail: { reason: `finalization/digest: ${reason}` },
      }),
    );
  }
  const terminalProduct = createImportProduct({
    ...productWithDependencies,
    refs: productWithDependencies.assets.flatMap((asset) => asset.refs),
    artifacts: Object.fromEntries(
      productWithDependencies.assets.flatMap((asset) =>
        Object.entries(asset.artifacts).map(([key, artifact]) => [
          `${asset.guid}/${key}`,
          artifact,
        ]),
      ),
    ),
    receipts: cookProducts.map((product) => product.receipt),
    diagnostics: meta.diagnostics ?? [],
    sourceRevision: inputFingerprint,
  });
  if (!terminalProduct.ok) {
    return errResult(
      new ImportError({
        code: 'import-internal-error',
        expected: 'the import product to retain complete terminal producer facts',
        hint: 'preserve source identity and producer evidence when returning the import product',
        detail: { reason: terminalProduct.error.detail.field },
      }),
    );
  }
  if (meta.buildPack === false) {
    return {
      ok: true,
      value: { product: terminalProduct.value, cookProducts },
    };
  }

  const assets = productWithDependencies.assets.map((a) => {
    const outputFields = declarationFields(declarations.get(a.guid));
    return {
      guid: a.guid,
      kind: a.kind,
      ...outputFields,
      ...(a.name !== undefined ? { name: a.name } : {}),
      // bug-20260610: mesh / scene / animation-clip payloads carry Float32Array
      // / Uint16Array / Uint32Array fields. JSON.stringify on a typed array
      // serialises to `{ "0": v0, "1": v1, ... }` (a plain object), which the
      // runtime mesh / animation loaders reject (`vertexData instanceof
      // Float32Array` and `Array.isArray(vertexData)` both fail). Convert
      // every typed-array field to a plain Array here so the pack is JSON-
      // roundtrip safe end-to-end.  This matches the convention every
      // existing pack-fixture test uses (`vertices: Array.from(...)`).
      payload: normaliseForPack(a.payload as unknown) as Record<string, unknown>,
      refs: a.refs.map((r) => r.guid),
      artifacts: a.artifacts,
    };
  });

  const pack: DdcPack = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    ...(meta.packageId !== undefined ? { packageId: meta.packageId } : {}),
    ...(meta.provenance !== undefined ? { provenance: meta.provenance } : {}),
    ...(meta.revision !== undefined ? { revision: meta.revision } : {}),
    ...(meta.diagnostics !== undefined ? { diagnostics: meta.diagnostics } : {}),
    assets,
  };

  return {
    ok: true,
    value: {
      product: terminalProduct.value,
      cookProducts,
      pack,
    },
  };
}
