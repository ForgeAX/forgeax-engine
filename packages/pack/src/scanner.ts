import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  CatalogDiagnostic,
  ImportSubAsset,
  PackErrorCode,
  ProviderProvenance,
  ResourceRevision,
  SourceOverrideDescriptor,
} from '@forgeax/engine-types';
import { isValidAssetGuidString, PACK_ERROR_HINTS } from '@forgeax/engine-types';
import { PackError } from './errors.js';
import { PackageId } from './guid.js';
import {
  type AnyScriptablePackDefinition,
  type PackAuthoringError,
  type PackParameterInheritanceSubject,
  type PackParameterValue,
  type ParsedPackInstanceJson,
  type ParsedPackJson,
  parsePackSourceJson,
  projectDirectPackJson,
  projectScriptablePackMeta,
  resolvePackParameterInheritance,
  type ScriptablePackSourceMeta,
} from './pack-authoring.js';
import { validateProducerContract, validateProducerOutputs } from './producer-contract.js';
import { resolveAssetSource } from './resolve-asset-source.js';
import { validateMeta, validatePack } from './schema-compiled.js';
import type { ScriptablePackSourceClosureEntry } from './scriptable-pack.js';
import {
  inventoryScriptablePackSource,
  loadScriptablePack,
  type ScriptablePackModuleExecutor,
} from './scriptable-pack-node.js';
import {
  createScriptablePackSourceSnapshot,
  type ScriptablePackSourceSnapshot,
} from './scriptable-pack-source-snapshot.js';

// Minimal Result<T, E> — structurally compatible with @forgeax/engine-rhi Result
// but defined locally to avoid a heavy runtime dep in this build-time package.
export type ScanResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

function ok<T>(value: T): ScanResult<T, never> {
  return { ok: true, value };
}

function packErr<E>(error: E): ScanResult<never, E> {
  return { ok: false, error };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Host-owned source paths that should not enter the Pack catalog. */
export interface ScanOptions {
  readonly ignorePath?: (path: string) => boolean;
  readonly scriptablePack?: ScriptablePackScanOptions;
  /** Explicit editor admission: omit malformed source declarations and report their original failure. */
  readonly onSourceFailure?: (sourcePath: string, error: PackError) => void;
}

/** One bounded executor policy shared by ScriptablePack inventory and production. */
export interface ScriptablePackScanOptions {
  readonly sourceSnapshot?: ScriptablePackSourceSnapshot;
  readonly timeoutMs?: number;
  readonly buildTimeoutMs?: number;
  readonly executor?: ScriptablePackModuleExecutor;
  /** Path-only scans must release the isolated loader before returning. */
  readonly metadataOnly?: boolean;
}

/** Stable default policy shared by inventory and production owners. */
export const STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS = Object.freeze({
  // Scriptable Packs execute in an isolated worker. A cold worker must compile
  // the authored source closure before it can return metadata. Keep the bound
  // finite while allowing a heavy character/scene closure to complete on a
  // busy host.
  timeoutMs: 120_000,
}) satisfies ScriptablePackScanOptions;

export interface InventoryDeclaration {
  readonly guid: string;
  readonly kind: string;
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly sourceKey?: string;
  readonly sourceIndex?: number;
}

export interface ScanInventory {
  readonly paths: readonly string[];
  readonly inventory: readonly InventoryDeclaration[];
  /** Complete parsed source declarations captured by the validated scan pass. */
  readonly declarations: ReadonlyMap<string, ScanSourceDeclaration>;
  /** Validated v3 instance chains keyed by instance source path. */
  readonly instances: ReadonlyMap<string, PackInstanceResolution>;
}

export interface PackInstanceResolution {
  readonly packageId: PackageId;
  readonly sourceRevision: string;
  /** The ScriptablePack source that executes the instance. */
  readonly root: Extract<ScanSourceDeclaration, { readonly format: 'pack.ts' }>;
  /** Instance values merged child-over-parent along the parent chain. */
  readonly values: Readonly<Record<string, unknown>>;
}

export interface ScriptablePackInventoryDeclaration {
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly meta: ScriptablePackSourceMeta;
  readonly definition: Readonly<AnyScriptablePackDefinition>;
  readonly sourceClosure: readonly ScriptablePackSourceClosureEntry[];
}

export interface MetaInventoryDocument {
  readonly schemaVersion: string | number;
  readonly kind: 'external-asset-package';
  readonly packageId?: string;
  readonly name?: string;
  readonly provenance?: ProviderProvenance;
  readonly revision?: ResourceRevision;
  readonly diagnostics?: readonly CatalogDiagnostic[];
  readonly importer: string;
  readonly source?: string;
  readonly importSettings: Readonly<Record<string, unknown>>;
  readonly sourceOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly sourceOverrideDescriptors?: readonly SourceOverrideDescriptor[];
  readonly paramSchema?: readonly Readonly<Record<string, unknown>>[];
  readonly subAssets: readonly ImportSubAsset[];
}

export interface LegacyPackInventoryDocument {
  readonly schemaVersion: '1.0.0' | '2.0.0';
  readonly kind: 'internal-text-package';
  readonly packageId?: string;
  readonly provenance?: ProviderProvenance;
  readonly revision?: ResourceRevision;
  readonly diagnostics?: readonly CatalogDiagnostic[];
  readonly assets: readonly PackInventoryAsset[];
}

/** Producer-owned legacy package, or the v3 authored source already parsed by the scanner. */
export type PackInventoryDocument = LegacyPackInventoryDocument | ParsedPackJson;

export interface PackInventoryAsset {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly execution?: 'direct' | 'cooked';
  readonly sourceKey?: string;
  readonly sourceIndex?: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly refs: readonly string[];
  readonly artifacts?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/**
 * Asset rows a pack.json document declares itself. A v3 instance declares none:
 * its ScriptablePack parent builds those outputs.
 */
export function declaredPackAssets(document: PackInventoryDocument): readonly PackInventoryAsset[] {
  if (document.schemaVersion !== '3.0.0') return document.assets;
  switch (document.format) {
    case 'instance':
      return [];
    case 'direct':
      return projectDirectPackJson(document).assets;
  }
}

/**
 * Asset GUIDs a source declaration declares before any build. A ScriptablePack
 * source declares none: its outputs exist only after a build generation.
 */
export function declaredSourceGuids(declaration: ScanSourceDeclaration): readonly string[] {
  switch (declaration.format) {
    case 'meta.json':
      return declaration.value.subAssets.map((asset) => asset.guid);
    case 'pack.json':
      return declaredPackAssets(declaration.value).map((asset) => asset.guid);
    case 'pack.ts':
      return [];
  }
}

export type ScanSourceDeclaration =
  | {
      readonly format: 'meta.json';
      readonly sourcePath: string;
      readonly sourceRevision: string;
      readonly value: MetaInventoryDocument;
    }
  | {
      readonly format: 'pack.json';
      readonly sourcePath: string;
      readonly sourceRevision: string;
      readonly sourceText: string;
      readonly value: PackInventoryDocument;
    }
  | {
      readonly format: 'pack.ts';
      readonly sourcePath: string;
      readonly sourceRevision: string;
      readonly value: ScriptablePackSourceMeta;
      readonly definition: AnyScriptablePackDefinition;
      readonly sourceClosure: readonly ScriptablePackSourceClosureEntry[];
    };

/** Canonical package-id text of any declaration; parsed v3 sources carry `PackageId` bytes. */
export function declarationPackageId(
  declaration: ScanSourceDeclaration | undefined,
): string | undefined {
  const packageId = declaration?.value.packageId;
  return packageId === undefined || typeof packageId === 'string'
    ? packageId
    : PackageId.format(packageId);
}

export type ScriptablePackSourceDeclaration = Extract<
  ScanSourceDeclaration,
  { readonly format: 'pack.ts' }
>;

/** One v3 Pack JSON instance resolved through its parent chain to the executing source. */
export interface ResolvedPackSourceInstance {
  readonly sourcePath: string;
  readonly packageId: PackageId;
  readonly root: ScriptablePackSourceDeclaration;
  readonly values: Readonly<Record<string, PackParameterValue>>;
}

/** Executable Pack subjects of one declaration snapshot, each ordered by source path. */
export interface PackSourceSubjects {
  readonly sources: readonly ScriptablePackSourceDeclaration[];
  readonly instances: readonly ResolvedPackSourceInstance[];
}

/**
 * Resolve every ScriptablePack source and v3 instance in a declaration snapshot.
 * Parameter inheritance is validated by `resolvePackParameterInheritance`; the
 * first failing instance fails the snapshot.
 */
export async function resolvePackSourceSubjects(
  declarations: ReadonlyMap<string, ScanSourceDeclaration>,
): Promise<ScanResult<PackSourceSubjects, PackAuthoringError>> {
  const subjects = new Map<
    string,
    {
      readonly subject: PackParameterInheritanceSubject;
      readonly declaration: ScanSourceDeclaration;
    }
  >();
  for (const declaration of declarations.values()) {
    if (declaration.format === 'pack.ts') {
      const { packageId } = declaration.definition;
      const parameters =
        'parameters' in declaration.definition ? declaration.definition.parameters : [];
      subjects.set(PackageId.format(packageId).toLowerCase(), {
        subject: { format: 'source', packageId, parameters },
        declaration,
      });
    } else if (declaration.format === 'pack.json' && declaration.value.schemaVersion === '3.0.0') {
      const parsed = declaration.value;
      subjects.set(PackageId.format(parsed.packageId).toLowerCase(), {
        subject:
          parsed.format === 'direct'
            ? { format: 'direct', packageId: parsed.packageId }
            : {
                format: 'instance',
                packageId: parsed.packageId,
                parent: parsed.parent,
                values: parsed.values,
              },
        declaration,
      });
    }
  }
  const ordered = [...subjects.values()].sort((left, right) =>
    left.declaration.sourcePath.localeCompare(right.declaration.sourcePath),
  );
  const readSubject = (packageId: PackageId) =>
    subjects.get(PackageId.format(packageId).toLowerCase())?.subject;
  const sources: ScriptablePackSourceDeclaration[] = [];
  const instances: ResolvedPackSourceInstance[] = [];
  for (const { subject, declaration } of ordered) {
    if (declaration.format === 'pack.ts') sources.push(declaration);
    if (subject.format !== 'instance') continue;
    const resolved = await resolvePackParameterInheritance(subject, readSubject);
    if (!resolved.ok) return resolved;
    const root = subjects.get(PackageId.format(resolved.value.rootPackageId).toLowerCase());
    if (root?.declaration.format !== 'pack.ts')
      throw new TypeError('resolved Pack inheritance root must be a ScriptablePack source');
    instances.push({
      sourcePath: declaration.sourcePath,
      packageId: subject.packageId,
      root: root.declaration,
      values: resolved.value.values,
    });
  }
  return ok({ sources, instances });
}

interface ScanCapture {
  readonly declarations: Map<string, ScanSourceDeclaration>;
  readonly instances: Map<string, PackInstanceResolution>;
}

/**
 * Directory names that are skipped during recursive traversal unless
 * explicitly provided as a root in the `roots` parameter (whitelist override).
 * Requirements §3.4 + §5 blacklist.
 *
 * Re-exported as `SCANNER_BLACKLIST` for cross-package reuse: the
 * `forgeax asset import --check` traversal (M4 / w21 +
 * plan-strategy section 2.8 path b) walks the same set of source-orphan
 * candidates as the scanner, so we share the single SSOT here.
 */
const BLACKLIST = new Set([
  'node_modules',
  '__tests__',
  '.forgeax-harness',
  '.forgeax',
  '.git',
  'dist',
  '.forgeax-asset-cache',
  'forgeax-engine-assets',
  'coverage',
]);

export const SCANNER_BLACKLIST: ReadonlySet<string> = BLACKLIST;

type MalformedFileCode = Extract<PackErrorCode, 'pack-malformed-pack' | 'pack-malformed-meta'>;

type JsonValidator = {
  (value: unknown): boolean;
  errors?: readonly { readonly instancePath?: string; readonly message?: string }[] | null;
};

async function readValidatedJson(
  path: string,
  code: MalformedFileCode,
  validate: JsonValidator,
  snapshot: ScriptablePackSourceSnapshot,
): Promise<ScanResult<{ readonly raw: string; readonly parsed: unknown }, PackError>> {
  let raw: string;
  let parsed: unknown;
  try {
    raw = await snapshot.readText(path);
    parsed = JSON.parse(raw);
  } catch {
    return packErr(
      makePackError(code, {
        path,
        ajvErrors: [{ instancePath: '', message: 'JSON parse failed' }],
      }),
    );
  }
  if (!validate(parsed)) {
    return packErr(
      makePackError(code, {
        path,
        ajvErrors: (validate.errors ?? []).map((error) => ({
          instancePath: error.instancePath ?? '',
          message: error.message ?? 'unknown ajv error',
        })),
      }),
    );
  }
  return ok({ raw, parsed });
}

function makePackError(
  code: PackErrorCode,
  detail: ConstructorParameters<typeof PackError>[0]['detail'],
  cause?: ConstructorParameters<typeof PackError>[0]['cause'],
): PackError {
  return new PackError({
    code,
    expected: `pack error: ${code}`,
    hint: PACK_ERROR_HINTS[code],
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * For keyed scene assets, return the lowercased GUID each nested instance
 * source resolves to via `asset.refs[]` (or directly carries). The yielded GUIDs feed
 * scanner step-6's scene dependency cycle DFS.
 */
function* extractInstanceSourceGuids(asset: {
  kind?: unknown;
  payload?: unknown;
  refs: readonly string[];
}): Generator<string> {
  if (asset.kind !== 'scene') return;
  const payload = asset.payload as { entities?: unknown } | undefined;
  if (
    !payload ||
    payload.entities === null ||
    typeof payload.entities !== 'object' ||
    Array.isArray(payload.entities)
  )
    return;
  for (const rawEntity of Object.values(payload.entities as Record<string, unknown>)) {
    if (rawEntity === null || typeof rawEntity !== 'object' || Array.isArray(rawEntity)) continue;
    const instance = (rawEntity as { instance?: unknown }).instance;
    if (instance === null || typeof instance !== 'object' || Array.isArray(instance)) continue;
    const source = (instance as { source?: unknown }).source;
    const resolved =
      typeof source === 'number' && Number.isInteger(source)
        ? asset.refs[source]
        : typeof source === 'string'
          ? source
          : undefined;
    if (typeof resolved !== 'string') continue;
    yield resolved.toLowerCase();
  }
}

/** Enumerate declaration membership without loading or evaluating authored modules. */
export async function listPackSourcePaths(
  roots: readonly string[],
  opts: Pick<ScanOptions, 'ignorePath'> = {},
): Promise<readonly string[]> {
  const rawPaths: string[] = [];
  const explicitRootSet = new Set(roots);

  async function traverse(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as import('node:fs').Dirent[];
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw cause;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (opts.ignorePath?.(fullPath) === true) continue;

      if (entry.isDirectory()) {
        // Skip blacklisted subdirectories unless the subdir is itself an explicit root
        if (BLACKLIST.has(basename(fullPath)) && !explicitRootSet.has(fullPath)) {
          continue;
        }
        await traverse(fullPath);
      } else if (entry.isFile()) {
        const name = entry.name;
        if (
          name.endsWith('.meta.json') ||
          name.endsWith('.pack.json') ||
          name.endsWith('.pack.ts')
        ) {
          rawPaths.push(fullPath);
        }
      }
    }
  }

  for (const root of roots) {
    // Explicit file roots are useful when a host wants one source package
    // from a larger asset tree without also scanning sibling packages. Keep
    // directory-root behaviour unchanged; this is only an opt-in whitelist.
    try {
      const rootStat = await stat(root);
      if (rootStat.isFile()) {
        if (opts.ignorePath?.(root) === true) continue;
        if (
          root.endsWith('.meta.json') ||
          root.endsWith('.pack.json') ||
          root.endsWith('.pack.ts')
        ) {
          rawPaths.push(root);
        }
        continue;
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    await traverse(root);
  }

  return rawPaths.sort();
}

/**
 * Scan one or more root directories for `.meta.json`, `.pack.json`, and `.pack.ts` files.
 * Runs a 7-step fail-fast validation chain (w17 + M7-T01):
 *   Step 1 - collect all .meta.json + .pack.json paths (blacklist skipped)
 *   Step 2 - schema validation (ajv strict)
 *   Step 3 - GUID string format validation
 *   Step 4 - GUID collision detection
 *   Step 5 - orphan .meta.json detection
 *   Step 6 - cyclic reference detection (hand-written DFS)
 *   Step 7 - complete pack and source closure validation
 *
 * Returns `Ok(paths)` or `Err(PackError)` on the first violation.
 *
 * NOTE: source files without a .meta.json are logged but not fatal (requirements §5).
 */
async function scanValidated(
  roots: readonly string[],
  opts: ScanOptions = {},
  capture?: ScanCapture,
): Promise<ScanResult<string[], PackError>> {
  // Step 1: collect all authored package declarations. ScriptablePack runtime
  // validation belongs to its trusted module loader; scanner only inventories
  // the source path so CLI/Vite share one discovery set.
  const sourceSnapshot =
    opts.scriptablePack?.sourceSnapshot ?? createScriptablePackSourceSnapshot();
  const rawPaths = await listPackSourcePaths(roots, opts);
  const failedPaths = new Set<string>();
  const omitFailedSource = (path: string, error: PackError): boolean => {
    if (!opts.onSourceFailure) return false;
    opts.onSourceFailure(path, error);
    failedPaths.add(path);
    return true;
  };
  // Separate meta and pack paths
  const metaPaths = rawPaths.filter((p) => p.endsWith('.meta.json'));
  const packPaths = rawPaths.filter((p) => p.endsWith('.pack.json'));
  const scriptablePaths = rawPaths.filter((p) => p.endsWith('.pack.ts'));

  // Step 2 + 3: parse + schema validate + GUID format validate each pack file
  // One normalized GUID map covers pack assets and meta subAssets. The source
  // kind stays in the path/detail evidence; identity is the normalized GUID.
  const assets = new Map<string, { path: string; refs: readonly string[] }>();
  const packages = new Map<
    string,
    { path: string; kind: 'legacy' | 'direct' | 'instance' | 'scriptable' }
  >();
  const instanceParents: {
    readonly path: string;
    readonly source: ParsedPackInstanceJson;
  }[] = [];

  function registerPackage(
    packageId: string | undefined,
    path: string,
    kind: 'legacy' | 'direct' | 'instance' | 'scriptable',
  ): PackError | undefined {
    if (packageId === undefined) return undefined;
    const normalized = packageId.toLowerCase();
    const existing = packages.get(normalized);
    if (existing !== undefined) {
      return makePackError('pack-guid-collision', {
        paths: [existing.path, path],
        guid: normalized,
      });
    }
    packages.set(normalized, { path, kind });
    return undefined;
  }

  function registerAsset(
    guid: string,
    path: string,
    refs: readonly string[] = [],
  ): PackError | undefined {
    const normalized = guid.toLowerCase();
    const existing = assets.get(normalized);
    if (existing !== undefined)
      return makePackError('pack-guid-collision', {
        paths: [existing.path, path],
        guid: normalized,
      });
    assets.set(normalized, { path, refs });
    return undefined;
  }

  for (const packPath of packPaths) {
    const loaded = await readValidatedJson(
      packPath,
      'pack-malformed-pack',
      validatePack,
      sourceSnapshot,
    );
    if (!loaded.ok) {
      if (omitFailedSource(packPath, loaded.error)) continue;
      return loaded;
    }
    const { raw, parsed } = loaded.value;

    if (record(parsed) && parsed.schemaVersion === '3.0.0') {
      const authoring = parsePackSourceJson(parsed);
      if (!authoring.ok) {
        const error = makePackError('pack-malformed-pack', {
          path: packPath,
          ajvErrors: [{ instancePath: '', message: authoring.error.code }],
        });
        if (omitFailedSource(packPath, error)) continue;
        return packErr(error);
      }
      const packageId = authoring.value.packageId;
      const packageCollision = registerPackage(
        PackageId.format(packageId),
        packPath,
        authoring.value.format,
      );
      if (packageCollision !== undefined) return packErr(packageCollision);
      if (authoring.value.format === 'instance') {
        instanceParents.push({
          path: packPath,
          source: authoring.value,
        });
      } else {
        for (const asset of projectDirectPackJson(authoring.value).assets) {
          const collision = registerAsset(asset.guid, packPath, [
            ...asset.refs.map((ref) => ref.toLowerCase()),
            ...extractInstanceSourceGuids(asset),
          ]);
          if (collision !== undefined) return packErr(collision);
        }
      }
      capture?.declarations.set(packPath, {
        format: 'pack.json',
        sourcePath: packPath,
        sourceRevision: await sourceSnapshot.digest(packPath),
        sourceText: raw,
        value: authoring.value,
      });
      continue;
    }

    const packageContract = validateProducerContract(parsed);
    if (!packageContract.ok) {
      const error = makePackError('pack-malformed-pack', {
        path: packPath,
        ajvErrors: [{ instancePath: '', message: packageContract.error.code }],
      });
      if (omitFailedSource(packPath, error)) continue;
      return packErr(error);
    }

    // Step 3: validate GUIDs in pack
    const packObj = parsed as unknown as LegacyPackInventoryDocument;
    const packageCollision = registerPackage(packObj.packageId, packPath, 'legacy');
    if (packageCollision !== undefined) return packErr(packageCollision);
    for (const asset of packObj.assets) {
      if (
        asset.kind === 'particle-effect' &&
        asset.execution === 'direct' &&
        (asset.refs.length > 0 || Object.keys(asset.artifacts ?? {}).length > 0)
      ) {
        return packErr(
          makePackError('pack-malformed-pack', {
            path: packPath,
            ajvErrors: [
              {
                instancePath: '/assets',
                message:
                  'authored particle-effect assets are source-only; refs and artifacts must be empty',
              },
            ],
          }),
        );
      }
    }
    const producerAssets = packObj.assets.filter(
      (asset) => asset.sourceKey !== undefined || asset.sourceIndex !== undefined,
    );
    if (producerAssets.length > 0) {
      for (const asset of producerAssets) {
        const assetContract = validateProducerContract(asset);
        if (!assetContract.ok) {
          return packErr(
            makePackError('pack-malformed-pack', {
              path: packPath,
              ajvErrors: [{ instancePath: '/assets', message: assetContract.error.code }],
            }),
          );
        }
      }
      const topologyContract = validateProducerOutputs(
        producerAssets.map((asset, sourceIndex) => ({
          guid: asset.guid,
          kind: asset.kind,
          sourceIndex: asset.sourceIndex ?? sourceIndex,
          ...(asset.sourceKey === undefined ? {} : { sourceKey: asset.sourceKey }),
        })),
      );
      if (!topologyContract.ok) {
        return packErr(
          makePackError('pack-malformed-pack', {
            path: packPath,
            ajvErrors: [{ instancePath: '/assets', message: topologyContract.error.code }],
          }),
        );
      }
    }
    for (const asset of packObj.assets) {
      if (!isValidAssetGuidString(asset.guid)) {
        return packErr(
          makePackError('pack-guid-malformed', {
            raw: asset.guid,
            reason: 'expected 36-char RFC 4122 dash-form UUID',
          }),
        );
      }
      for (const ref of asset.refs) {
        if (!isValidAssetGuidString(ref)) {
          return packErr(
            makePackError('pack-guid-malformed', {
              raw: ref,
              reason: 'expected 36-char RFC 4122 dash-form UUID in refs[]',
            }),
          );
        }
      }

      // Keyed scene instances are dependency edges in the same identity row.
      const collision = registerAsset(asset.guid, packPath, [
        ...asset.refs.map((ref) => ref.toLowerCase()),
        ...extractInstanceSourceGuids(asset),
      ]);
      if (collision !== undefined) return packErr(collision);
    }
    capture?.declarations.set(packPath, {
      format: 'pack.json',
      sourcePath: packPath,
      sourceRevision: await sourceSnapshot.digest(packPath),
      sourceText: raw,
      value: packObj,
    });
  }

  // Step 2 + 3 + 5: parse + schema validate + GUID format validate + orphan check for meta files.
  // Meta source paths are local to their sidecar: an omitted source names the
  // companion file and an explicit source is resolved relative to the sidecar.
  for (const metaPath of metaPaths) {
    const loaded = await readValidatedJson(
      metaPath,
      'pack-malformed-meta',
      validateMeta,
      sourceSnapshot,
    );
    if (!loaded.ok) {
      if (omitFailedSource(metaPath, loaded.error)) continue;
      return loaded;
    }
    const { parsed } = loaded.value;

    const metaContract = validateProducerContract(parsed);
    if (!metaContract.ok) {
      const error = makePackError('pack-malformed-meta', {
        path: metaPath,
        ajvErrors: [{ instancePath: '', message: metaContract.error.code }],
      });
      if (omitFailedSource(metaPath, error)) continue;
      return packErr(error);
    }

    // Step 3: validate GUIDs in meta subAssets
    const metaObj = parsed as unknown as MetaInventoryDocument;
    const packageCollision = registerPackage(metaObj.packageId, metaPath, 'legacy');
    if (packageCollision !== undefined) return packErr(packageCollision);
    capture?.declarations.set(metaPath, {
      format: 'meta.json',
      sourcePath: metaPath,
      sourceRevision: await sourceSnapshot.digest(metaPath),
      value: metaObj,
    });
    for (const sub of metaObj.subAssets) {
      if (!isValidAssetGuidString(sub.guid)) {
        return packErr(
          makePackError('pack-guid-malformed', {
            raw: sub.guid,
            reason: 'expected 36-char RFC 4122 dash-form UUID in subAssets[].guid',
          }),
        );
      }
      const collision = registerAsset(sub.guid, metaPath);
      if (collision !== undefined) return packErr(collision);
    }
    const producerSubAssets = metaObj.subAssets.length > 1 ? metaObj.subAssets : [];
    if (producerSubAssets.length > 0) {
      const topologyContract = validateProducerOutputs(producerSubAssets);
      if (!topologyContract.ok) {
        return packErr(
          makePackError('pack-malformed-meta', {
            path: metaPath,
            ajvErrors: [{ instancePath: '/subAssets', message: topologyContract.error.code }],
          }),
        );
      }
    }

    // Step 5: orphan .meta.json check — the source file declared in meta.source must exist.
    const expectedSourcePath = resolveAssetSource(metaPath, metaObj.source);
    try {
      await stat(expectedSourcePath);
    } catch {
      return packErr(
        makePackError('pack-orphan-meta', {
          metaPath,
          expectedFile: expectedSourcePath,
        }),
      );
    }
  }

  // Metadata reads release their isolated workers before returning. Parallelize
  // only those reads; inventories retaining build leases and caller executors
  // remain serial. Commit declarations in source order, not completion order.
  const loaderOptions = {
    ...(opts.scriptablePack ?? {}),
    sourceSnapshot,
    ...(capture === undefined ? { metadataOnly: true } : {}),
  };
  const loadSource = async (sourcePath: string) => {
    let source: string;
    try {
      source = await sourceSnapshot.readText(sourcePath);
    } catch {
      return packErr(
        makePackError('pack-malformed-meta', {
          path: sourcePath,
          ajvErrors: [{ instancePath: '', message: 'Pack source read failed' }],
        }),
      );
    }
    const loaded = await loadScriptablePack(sourcePath, loaderOptions);
    if (!loaded.ok) {
      if (loaded.error.code === 'pack-module-not-found') {
        return packErr(
          new PackError({
            code: loaded.error.code,
            expected: loaded.error.expected,
            hint: loaded.error.hint,
            detail: {
              code: loaded.error.code,
              sourcePath: String(loaded.error.detail.sourcePath),
              specifier: String(loaded.error.detail.specifier),
            },
            cause: loaded.error,
          }),
        );
      }
      const diagnostic = loaded.error.detail.diagnostic;
      return packErr(
        makePackError(
          'pack-malformed-meta',
          {
            path: sourcePath,
            ajvErrors: [
              {
                instancePath: '',
                message:
                  typeof diagnostic === 'string'
                    ? `${loaded.error.code}: ${diagnostic}`
                    : loaded.error.code,
              },
            ],
          },
          loaded.error,
        ),
      );
    }
    let sourceClosure: readonly ScriptablePackSourceClosureEntry[];
    try {
      sourceClosure = await inventoryScriptablePackSource(
        sourcePath,
        source,
        undefined,
        sourceSnapshot,
      );
    } catch {
      return packErr(
        makePackError('pack-malformed-meta', {
          path: sourcePath,
          ajvErrors: [{ instancePath: '', message: 'Pack source closure read failed' }],
        }),
      );
    }
    return ok({
      format: 'pack.ts' as const,
      sourcePath,
      sourceRevision: await sourceSnapshot.digest(sourcePath),
      value: projectScriptablePackMeta(loaded.value, sourcePath),
      definition: loaded.value,
      sourceClosure,
    });
  };
  const batchSize =
    loaderOptions.metadataOnly === true && loaderOptions.executor === undefined ? 4 : 1;
  for (let start = 0; start < scriptablePaths.length; start += batchSize) {
    // Even a failed read must settle every started sibling before returning.
    const completed = await Promise.allSettled(
      scriptablePaths.slice(start, start + batchSize).map(loadSource),
    );
    for (const [index, item] of completed.entries()) {
      if (item.status === 'rejected') throw item.reason;
      if (!item.value.ok) {
        const sourcePath = scriptablePaths[start + index];
        if (sourcePath !== undefined && omitFailedSource(sourcePath, item.value.error)) continue;
        return item.value;
      }
      const declaration = item.value.value;
      const packageCollision = registerPackage(
        PackageId.format(declaration.definition.packageId),
        declaration.sourcePath,
        'scriptable',
      );
      if (packageCollision !== undefined) return packErr(packageCollision);
      capture?.declarations.set(declaration.sourcePath, declaration);
    }
  }

  // v3 instance parent validation happens after all declarations have been
  // registered, so scan order cannot change missing-parent or cycle results.
  const parentByPackageId = new Map(
    instanceParents.map((instance) => [
      PackageId.format(instance.source.packageId).toLowerCase(),
      instance,
    ]),
  );
  for (const instance of instanceParents) {
    const parentId = PackageId.format(instance.source.parent).toLowerCase();
    const parent = packages.get(parentId);
    if (parent === undefined) {
      return packErr(
        makePackError('pack-malformed-pack', {
          path: instance.path,
          reason: 'pack-parent-not-found',
          ajvErrors: [
            {
              instancePath: '/parent',
              message: `parent packageId ${PackageId.format(instance.source.parent)} was not found`,
            },
          ],
        }),
      );
    }
    const kind = parent.kind;
    if (kind !== 'scriptable' && kind !== 'instance') {
      return packErr(
        makePackError('pack-malformed-pack', {
          path: instance.path,
          reason: 'pack-parent-has-no-parameters',
          ajvErrors: [
            {
              instancePath: '/parent',
              message: `parent ${PackageId.format(instance.source.parent)} is not a ScriptablePack source with parameters`,
            },
          ],
        }),
      );
    }
  }
  for (const instance of instanceParents) {
    const chain = new Set<string>();
    let current = PackageId.format(instance.source.packageId).toLowerCase();
    let values: Readonly<Record<string, unknown>> = {};
    while (true) {
      if (chain.has(current)) {
        return packErr(
          makePackError('pack-malformed-pack', {
            path: instance.path,
            reason: 'pack-parent-cycle',
            ajvErrors: [
              { instancePath: '/parent', message: `parent chain repeats packageId ${current}` },
            ],
          }),
        );
      }
      chain.add(current);
      const next = parentByPackageId.get(current);
      if (next === undefined) break;
      values = { ...next.source.values, ...values };
      current = PackageId.format(next.source.parent).toLowerCase();
    }
    const declaration = capture?.declarations.get(instance.path);
    const root = capture?.declarations.get(packages.get(current)?.path ?? '');
    if (declaration !== undefined && root?.format === 'pack.ts')
      capture?.instances.set(instance.path, {
        packageId: instance.source.packageId,
        sourceRevision: declaration.sourceRevision,
        root,
        values,
      });
  }

  // Step 6: cyclic reference detection via hand-written DFS (no graphlib dep)
  const visitState = new Map<string, 'visiting' | 'visited'>();

  function dfs(guid: string, path: string[]): string[] | null {
    visitState.set(guid, 'visiting');

    for (const ref of assets.get(guid)?.refs ?? []) {
      if (!visitState.has(ref)) {
        const cycle = dfs(ref, [...path, ref]);
        if (cycle !== null) return cycle;
      } else if (visitState.get(ref) === 'visiting') {
        // Found a back-edge: reconstruct cycle from the repeated node
        const cycleStart = path.indexOf(ref);
        return cycleStart >= 0 ? [...path.slice(cycleStart), ref] : [...path, ref];
      }
    }

    visitState.set(guid, 'visited');
    return null;
  }

  for (const guid of assets.keys()) {
    if (!visitState.has(guid)) {
      const cycle = dfs(guid, [guid]);
      if (cycle !== null) {
        return packErr(
          makePackError('pack-cyclic-reference', {
            code: 'pack-cyclic-reference',
            kind: 'mount-asset',
            cycle,
          }),
        );
      }
    }
  }

  const current = await sourceSnapshot.verify();
  if (!current.ok)
    return packErr(
      makePackError(
        'pack-malformed-meta',
        {
          path: String(current.error.detail.sourcePath),
          ajvErrors: [{ instancePath: '', message: current.error.code }],
        },
        current.error,
      ),
    );
  return ok(rawPaths.filter((path) => !failedPaths.has(path)));
}

/** Scan one complete Pack inventory while preserving the public path-only API. */
export async function scan(
  roots: readonly string[],
  opts: ScanOptions = {},
): Promise<ScanResult<string[], PackError>> {
  return scanValidated(roots, opts);
}

/** Return the validated source inventory without interpreting producer output kinds. */
export async function scanInventory(
  roots: readonly string[],
  opts: ScanOptions = {},
): Promise<ScanResult<ScanInventory, PackError>> {
  const declarations = new Map<string, ScanSourceDeclaration>();
  const instances = new Map<string, PackInstanceResolution>();
  const scanned = await scanValidated(roots, opts, { declarations, instances });
  if (!scanned.ok) return scanned;
  const inventory: InventoryDeclaration[] = [];
  for (const sourcePath of scanned.value) {
    const declaration = declarations.get(sourcePath);
    if (declaration?.format !== 'pack.json') continue;
    for (const [index, asset] of declaredPackAssets(declaration.value).entries()) {
      inventory.push({
        guid: asset.guid,
        kind: asset.kind,
        sourcePath,
        sourceRevision: declaration.sourceRevision,
        ...(asset.sourceKey === undefined ? {} : { sourceKey: asset.sourceKey }),
        sourceIndex: asset.sourceIndex ?? index,
      });
    }
  }
  return ok({ paths: scanned.value, inventory, declarations, instances });
}
