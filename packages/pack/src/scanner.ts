import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CatalogDiagnostic,
  ImportSubAsset,
  PackErrorCode,
  PackIndexEntry,
  ProviderProvenance,
  ResourceRevision,
  SourceOverrideDescriptor,
} from '@forgeax/engine-types';
import { isValidAssetGuidString, PACK_ERROR_HINTS } from '@forgeax/engine-types';
import { PackError } from './errors.js';
import { isTextureContentDeclaration, PackageId } from './guid.js';
import {
  type AnyScriptablePackDefinition,
  type DirectPackAssetProjection,
  type PackAuthoringError,
  type PackParameterInheritanceSubject,
  type ParsedPackJson,
  parsePackSourceJson,
  projectDirectPackJson,
  projectScriptablePackMeta,
  projectScriptablePackRuntimeOutputs,
  type ResolvedPackParameterInheritance,
  resolvePackParameterInheritance,
  type ScriptablePackSourceMeta,
} from './pack-authoring.js';
import { validateProducerContract, validateProducerOutputs } from './producer-contract.js';
import { resolveAssetSource } from './resolve-asset-source.js';
import { validateMeta } from './schema-compiled.js';
import type { ScriptablePackSourceClosureEntry } from './scriptable-pack.js';
import {
  inventoryScriptablePackSource,
  type LoadScriptablePackOptions,
  loadScriptablePack,
  SCRIPTABLE_PACK_MODULE_TIMEOUT_MS,
  scriptablePackBuildTimeoutMs,
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

/** Host-owned source paths that should not enter the Pack catalog. */
export interface ScanOptions {
  readonly ignorePath?: (path: string) => boolean;
  readonly scriptablePack?: ScriptablePackScanOptions;
  /** Explicit editor admission: omit malformed source declarations and report their original failure. */
  readonly onSourceFailure?: (sourcePath: string, error: PackError) => void;
}

/** One bounded executor policy shared by ScriptablePack inventory and production. */
export interface ScriptablePackScanOptions extends LoadScriptablePackOptions {}

/** Stable default policy shared by inventory and production owners. */
export const STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS = Object.freeze({
  // Scriptable Packs execute in an isolated worker. A cold worker must compile
  // the authored source closure before it can return metadata. Keep the bound
  // finite while allowing a heavy character/scene closure to complete on a
  // busy host.
  timeoutMs: SCRIPTABLE_PACK_MODULE_TIMEOUT_MS,
  get buildTimeoutMs() {
    return scriptablePackBuildTimeoutMs();
  },
}) satisfies ScriptablePackScanOptions;

export interface InventoryDeclaration
  extends Pick<
    PackIndexEntry,
    'guid' | 'kind' | 'sourcePath' | 'sourceKey' | 'sourceIndex' | 'name'
  > {
  readonly sourceRevision: string;
}

export interface ScanInventory {
  readonly paths: readonly string[];
  readonly inventory: readonly InventoryDeclaration[];
  /** Complete parsed source declarations captured by the validated scan pass. */
  readonly declarations: ReadonlyMap<string, ScanSourceDeclaration>;
  /** Validated v3 instance chains keyed by instance source path. */
  readonly instances: ReadonlyMap<string, PackInstanceResolution>;
}

export interface PackInstanceResolution extends ResolvedPackParameterInheritance {
  readonly sourceRevision: string;
  /** The ScriptablePack source that executes the instance. */
  readonly root: ScriptablePackSourceDeclaration;
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

/**
 * Asset rows a pack.json document declares itself. A v3 instance declares none:
 * its ScriptablePack parent builds those outputs.
 */
export function declaredPackAssets(document: ParsedPackJson): readonly DirectPackAssetProjection[] {
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
      readonly value: ParsedPackJson;
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

export function declaredRuntimePackGuids(
  declarations: Iterable<ScanSourceDeclaration>,
): readonly string[] {
  return [...declarations].flatMap((declaration) =>
    declaration.format === 'pack.ts'
      ? projectScriptablePackRuntimeOutputs(declaration.definition).map(({ guid }) => guid)
      : [],
  );
}

export type ScriptablePackSourceDeclaration = Extract<
  ScanSourceDeclaration,
  { readonly format: 'pack.ts' }
>;

async function resolvePackInstances(
  declarations: ReadonlyMap<string, ScanSourceDeclaration>,
  scan: PackScan,
): Promise<ScanResult<ReadonlyMap<string, PackInstanceResolution>, PackError>> {
  const subjects = new Map<string, PackParameterInheritanceSubject>();
  const roots = new Map<string, ScriptablePackSourceDeclaration>();
  for (const declaration of declarations.values()) {
    if (declaration.format === 'pack.ts') {
      const { packageId } = declaration.definition;
      const key = PackageId.format(packageId);
      subjects.set(key, {
        format: 'source',
        packageId,
        parameters: 'parameters' in declaration.definition ? declaration.definition.parameters : [],
      });
      roots.set(key, declaration);
    } else if (declaration.format === 'pack.json') {
      subjects.set(PackageId.format(declaration.value.packageId), declaration.value);
    }
  }
  const instances = new Map<string, PackInstanceResolution>();
  for (const declaration of declarations.values()) {
    if (declaration.format !== 'pack.json' || declaration.value.format !== 'instance') continue;
    const resolved = await resolvePackParameterInheritance(declaration.value, (packageId) =>
      subjects.get(PackageId.format(packageId)),
    );
    if (!resolved.ok) {
      const error = makePackError('pack-malformed-pack', {
        path: declaration.sourcePath,
        reason: resolved.error.code,
        ajvErrors: [{ instancePath: '/parent', message: resolved.error.hint }],
      });
      if (scan.omitFailedSource(declaration.sourcePath, error)) continue;
      return packErr(error);
    }
    const root = roots.get(PackageId.format(resolved.value.rootPackageId));
    if (root === undefined) throw new TypeError('resolved instance root is missing');
    instances.set(declaration.sourcePath, {
      ...resolved.value,
      sourceRevision: declaration.sourceRevision,
      root,
    });
  }
  return ok(instances);
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

/** @internal Decode authored JSON with the Scanner diagnostic vocabulary. */
export async function readAuthorJson(
  path: string,
  code: MalformedFileCode,
  snapshot?: Pick<ScriptablePackSourceSnapshot, 'readText'>,
): Promise<ScanResult<{ readonly raw: string; readonly parsed: unknown }, PackError>> {
  let raw: string;
  let parsed: unknown;
  try {
    raw = await (snapshot === undefined ? readFile(path, 'utf8') : snapshot.readText(path));
    parsed = JSON.parse(raw);
  } catch {
    return packErr(
      makePackError(code, {
        path,
        ajvErrors: [{ instancePath: '', message: 'JSON parse failed' }],
      }),
    );
  }
  if (code === 'pack-malformed-meta' && !validateMeta(parsed)) {
    return packErr(
      makePackError(code, {
        path,
        ajvErrors: (validateMeta.errors ?? []).map((error) => ({
          instancePath: error.instancePath ?? '',
          message: error.message ?? 'unknown ajv error',
          ...(error.keyword === undefined ? {} : { keyword: error.keyword }),
          ...(error.schemaPath === undefined ? {} : { schemaPath: error.schemaPath }),
          ...(error.params === undefined ? {} : { params: error.params }),
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

function isPackSourcePath(path: string): boolean {
  return path.endsWith('.pack.json') || path.endsWith('.pack.ts');
}

/** Enumerate declaration membership without loading or evaluating authored modules. */
export async function listPackSourcePaths(
  roots: readonly string[],
  opts: Pick<ScanOptions, 'ignorePath'> = {},
): Promise<readonly string[]> {
  return (await enumeratePackSourcePaths(roots, opts)).paths.sort();
}

export async function enumeratePackSourcePaths(
  roots: readonly string[],
  options: Pick<ScanOptions, 'ignorePath'> & {
    /** The source-only listing scans validated directory roots in page order. */
    readonly sourceLimit?: number;
    /** Evidence lookup may still report healthy sources from a partial tree. */
    readonly skipUnreadable?: boolean;
  } = {},
): Promise<{ paths: string[]; hasMore: boolean }> {
  const paths: string[] = [];
  const explicitRoots = new Set(roots);
  const limit = options.sourceLimit;
  const visitedDirectories = new Set<string>();
  let visited = 0;
  let hasMore = false;
  const includesSource = (path: string): boolean =>
    isPackSourcePath(path) || (limit === undefined && path.endsWith('.meta.json'));

  async function visit(directory: string): Promise<void> {
    if (limit !== undefined) {
      if (hasMore || visitedDirectories.has(directory)) return;
      visitedDirectories.add(directory);
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT' || options.skipUnreadable) return [];
        throw cause;
      },
    );
    if (limit !== undefined) entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (limit !== undefined && (++visited > 10_000 || paths.length > limit)) {
        hasMore = true;
        return;
      }
      const path = join(directory, entry.name);
      if (options.ignorePath?.(path)) continue;
      if (entry.isDirectory()) {
        if (!BLACKLIST.has(entry.name) || (limit === undefined && explicitRoots.has(path)))
          await visit(path);
      } else if (entry.isFile() && includesSource(entry.name)) {
        paths.push(path);
      }
    }
  }

  for (const root of roots) {
    if (limit === undefined && !options.skipUnreadable) {
      const info = await stat(root).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return undefined;
        throw cause;
      });
      if (info?.isFile()) {
        if (!options.ignorePath?.(root) && includesSource(root)) paths.push(root);
        continue;
      }
    }
    await visit(root);
  }
  return { paths, hasMore: hasMore || (limit !== undefined && paths.length > limit) };
}

type PackageKind = 'meta' | 'direct' | 'instance' | 'scriptable';

function packErrorAt(
  code: MalformedFileCode,
  path: string,
  instancePath: string,
  message: string,
): PackError {
  return makePackError(code, { path, ajvErrors: [{ instancePath, message }] });
}

function scriptableLoadError(sourcePath: string, error: PackAuthoringError): PackError {
  if (error.code === 'pack-module-not-found') {
    return new PackError({
      code: error.code,
      expected: error.expected,
      hint: error.hint,
      detail: {
        code: error.code,
        sourcePath: String(error.detail.sourcePath),
        specifier: String(error.detail.specifier),
      },
      cause: error,
    });
  }
  const diagnostic = error.detail.diagnostic;
  return makePackError(
    'pack-malformed-meta',
    {
      path: sourcePath,
      ajvErrors: [
        {
          instancePath: '',
          message: typeof diagnostic === 'string' ? `${error.code}: ${diagnostic}` : error.code,
        },
      ],
    },
    error,
  );
}

async function loadScriptableSource(
  sourcePath: string,
  sourceSnapshot: ScriptablePackSourceSnapshot,
  loaderOptions: LoadScriptablePackOptions,
): Promise<ScanResult<ScriptablePackSourceDeclaration, PackError>> {
  let source: string;
  try {
    source = await sourceSnapshot.readText(sourcePath);
  } catch {
    return packErr(packErrorAt('pack-malformed-meta', sourcePath, '', 'Pack source read failed'));
  }
  const loaded = await loadScriptablePack(sourcePath, loaderOptions);
  if (!loaded.ok) return packErr(scriptableLoadError(sourcePath, loaded.error));
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
      packErrorAt('pack-malformed-meta', sourcePath, '', 'Pack source closure read failed'),
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
}

/** Follows a GUID's refs depth-first; returns the first reference cycle found. */
function findReferenceCycle(
  assets: ReadonlyMap<string, { readonly refs: readonly string[] }>,
): string[] | null {
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
      if (cycle !== null) return cycle;
    }
  }
  return null;
}

/**
 * One validated scan: the normalized identity rows every declaration registers into.
 * One normalized GUID map covers pack assets and meta subAssets. The source
 * kind stays in the path/detail evidence; identity is the normalized GUID.
 */
class PackScan {
  readonly assets = new Map<
    string,
    { path: string; refs: readonly string[]; contentTexture?: boolean }
  >();
  readonly packages = new Map<string, { path: string; kind: PackageKind }>();
  readonly failedPaths = new Set<string>();

  constructor(
    readonly opts: ScanOptions,
    readonly sourceSnapshot: ScriptablePackSourceSnapshot,
    readonly declarations: Map<string, ScanSourceDeclaration>,
    readonly metadataOnly: boolean,
  ) {}

  omitFailedSource(path: string, error: PackError): boolean {
    if (!this.opts.onSourceFailure) return false;
    this.opts.onSourceFailure(path, error);
    this.failedPaths.add(path);
    return true;
  }

  registerPackage(
    packageId: string | undefined,
    path: string,
    kind: PackageKind,
  ): PackError | undefined {
    if (packageId === undefined) return undefined;
    const normalized = packageId.toLowerCase();
    const existing = this.packages.get(normalized);
    if (existing !== undefined) {
      return makePackError('pack-guid-collision', {
        paths: [existing.path, path],
        guid: normalized,
      });
    }
    this.packages.set(normalized, { path, kind });
    return undefined;
  }

  registerAsset(
    guid: string,
    path: string,
    refs: readonly string[] = [],
    contentTexture = false,
  ): PackError | undefined {
    const normalized = guid.toLowerCase();
    const existing = this.assets.get(normalized);
    // A content-identified texture names the same bytes decoded the same way
    // wherever it is declared; the first declaration owns it.
    if (existing?.contentTexture === true && contentTexture) return undefined;
    if (existing !== undefined)
      return makePackError('pack-guid-collision', {
        paths: [existing.path, path],
        guid: normalized,
      });
    this.assets.set(normalized, { path, refs, ...(contentTexture ? { contentTexture } : {}) });
    return undefined;
  }

  /** Steps 2 + 3 for one .pack.json; undefined means registered or omitted. */
  async scanPackJson(packPath: string): Promise<PackError | undefined> {
    const loaded = await readAuthorJson(packPath, 'pack-malformed-pack', this.sourceSnapshot);
    if (!loaded.ok) return this.omitFailedSource(packPath, loaded.error) ? undefined : loaded.error;
    const { raw, parsed } = loaded.value;
    const authoring = parsePackSourceJson(parsed);
    if (!authoring.ok) {
      const error = packErrorAt('pack-malformed-pack', packPath, '', authoring.error.hint);
      return this.omitFailedSource(packPath, error) ? undefined : error;
    }
    const value = authoring.value;
    const failure = this.registerV3PackJson(packPath, value);
    if (failure !== undefined) return failure;
    this.declarations.set(packPath, {
      format: 'pack.json',
      sourcePath: packPath,
      sourceRevision: await this.sourceSnapshot.digest(packPath),
      sourceText: raw,
      value,
    });
    return undefined;
  }

  registerV3PackJson(packPath: string, source: ParsedPackJson): PackError | undefined {
    const packageCollision = this.registerPackage(
      PackageId.format(source.packageId),
      packPath,
      source.format,
    );
    if (packageCollision !== undefined) return packageCollision;
    if (source.format === 'direct') {
      for (const asset of projectDirectPackJson(source).assets) {
        const collision = this.registerAsset(asset.guid, packPath, [
          ...asset.refs.map((ref) => ref.toLowerCase()),
          ...extractInstanceSourceGuids(asset),
        ]);
        if (collision !== undefined) return collision;
      }
    }
    return undefined;
  }

  /**
   * Steps 2 + 3 + 5 for one .meta.json. Meta source paths are local to their
   * sidecar: an omitted source names the companion file and an explicit source
   * is resolved relative to the sidecar.
   */
  async scanMetaJson(metaPath: string): Promise<PackError | undefined> {
    const loaded = await readAuthorJson(metaPath, 'pack-malformed-meta', this.sourceSnapshot);
    if (!loaded.ok) return this.omitFailedSource(metaPath, loaded.error) ? undefined : loaded.error;
    const { parsed } = loaded.value;
    const metaContract = validateProducerContract(parsed);
    if (!metaContract.ok) {
      const error = packErrorAt('pack-malformed-meta', metaPath, '', metaContract.error.code);
      return this.omitFailedSource(metaPath, error) ? undefined : error;
    }
    // Step 3: validate GUIDs in meta subAssets
    const metaObj = parsed as unknown as MetaInventoryDocument;
    const registered = await this.registerMeta(metaPath, metaObj);
    if (registered !== undefined) return registered;
    // Step 5: orphan .meta.json check — the source file declared in meta.source must exist.
    const expectedSourcePath = resolveAssetSource(metaPath, metaObj.source);
    try {
      await stat(expectedSourcePath);
    } catch {
      return makePackError('pack-orphan-meta', { metaPath, expectedFile: expectedSourcePath });
    }
    return undefined;
  }

  async registerMeta(
    metaPath: string,
    metaObj: MetaInventoryDocument,
  ): Promise<PackError | undefined> {
    const packageCollision = this.registerPackage(metaObj.packageId, metaPath, 'meta');
    if (packageCollision !== undefined) return packageCollision;
    this.declarations.set(metaPath, {
      format: 'meta.json',
      sourcePath: metaPath,
      sourceRevision: await this.sourceSnapshot.digest(metaPath),
      value: metaObj,
    });
    for (const sub of metaObj.subAssets) {
      if (!isValidAssetGuidString(sub.guid)) {
        return makePackError('pack-guid-malformed', {
          raw: sub.guid,
          reason: 'expected 36-char RFC 4122 dash-form UUID in subAssets[].guid',
        });
      }
      const collision = this.registerAsset(
        sub.guid,
        metaPath,
        [],
        isTextureContentDeclaration(sub),
      );
      if (collision !== undefined) return collision;
    }
    if (metaObj.subAssets.length <= 1) return undefined;
    const topologyContract = validateProducerOutputs(metaObj.subAssets);
    if (!topologyContract.ok)
      return packErrorAt(
        'pack-malformed-meta',
        metaPath,
        '/subAssets',
        topologyContract.error.code,
      );
    return undefined;
  }

  /**
   * Metadata reads release their isolated workers before returning. Parallelize
   * only those reads; inventories retaining build leases and caller executors
   * remain serial. Commit declarations in source order, not completion order.
   */
  async scanScriptableSources(scriptablePaths: readonly string[]): Promise<PackError | undefined> {
    const loaderOptions = {
      ...(this.opts.scriptablePack ?? {}),
      sourceSnapshot: this.sourceSnapshot,
      ...(this.metadataOnly ? { metadataOnly: true } : {}),
    };
    const batchSize =
      loaderOptions.metadataOnly === true && loaderOptions.executor === undefined ? 4 : 1;
    for (let start = 0; start < scriptablePaths.length; start += batchSize) {
      // Even a failed read must settle every started sibling before returning.
      const completed = await Promise.allSettled(
        scriptablePaths
          .slice(start, start + batchSize)
          .map((sourcePath) =>
            loadScriptableSource(sourcePath, this.sourceSnapshot, loaderOptions),
          ),
      );
      for (const [index, item] of completed.entries()) {
        if (item.status === 'rejected') throw item.reason;
        if (!item.value.ok) {
          const sourcePath = scriptablePaths[start + index];
          if (sourcePath !== undefined && this.omitFailedSource(sourcePath, item.value.error))
            continue;
          return item.value.error;
        }
        const declaration = item.value.value;
        const packageCollision = this.registerPackage(
          PackageId.format(declaration.definition.packageId),
          declaration.sourcePath,
          'scriptable',
        );
        if (packageCollision !== undefined) return packageCollision;
        this.declarations.set(declaration.sourcePath, declaration);
      }
    }
    return undefined;
  }

  async sourceSnapshotError(): Promise<PackError | undefined> {
    const current = await this.sourceSnapshot.verify();
    if (current.ok) return undefined;
    return makePackError(
      'pack-malformed-meta',
      {
        path: String(current.error.detail.sourcePath),
        reason: current.error.code,
        ajvErrors: [{ instancePath: '', message: current.error.code }],
      },
      current.error,
    );
  }
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
  metadataOnly = false,
): Promise<ScanResult<Omit<ScanInventory, 'inventory'>, PackError>> {
  // Step 1: collect all authored package declarations. ScriptablePack runtime
  // validation belongs to its trusted module loader; scanner only inventories
  // the source path so CLI/Vite share one discovery set.
  const sourceSnapshot =
    opts.scriptablePack?.sourceSnapshot ?? createScriptablePackSourceSnapshot();
  const rawPaths = await listPackSourcePaths(roots, opts);
  const declarations = new Map<string, ScanSourceDeclaration>();
  const scan = new PackScan(opts, sourceSnapshot, declarations, metadataOnly);
  for (const packPath of rawPaths.filter((p) => p.endsWith('.pack.json'))) {
    const failure = await scan.scanPackJson(packPath);
    if (failure !== undefined) return packErr(failure);
  }
  for (const metaPath of rawPaths.filter((p) => p.endsWith('.meta.json'))) {
    const failure = await scan.scanMetaJson(metaPath);
    if (failure !== undefined) return packErr(failure);
  }
  const scriptable = await scan.scanScriptableSources(
    rawPaths.filter((p) => p.endsWith('.pack.ts')),
  );
  if (scriptable !== undefined) return packErr(scriptable);
  const instances = await resolvePackInstances(declarations, scan);
  if (!instances.ok) return instances;
  for (const failed of scan.failedPaths) declarations.delete(failed);
  // Step 6: cyclic reference detection via hand-written DFS (no graphlib dep)
  const cycle = findReferenceCycle(scan.assets);
  if (cycle !== null) {
    return packErr(
      makePackError('pack-cyclic-reference', {
        code: 'pack-cyclic-reference',
        kind: 'mount-asset',
        cycle,
      }),
    );
  }
  const stale = await scan.sourceSnapshotError();
  if (stale !== undefined) return packErr(stale);
  const paths = rawPaths.filter((path) => !scan.failedPaths.has(path));
  return ok({ paths, declarations, instances: instances.value });
}

/** Scan one complete Pack inventory while preserving the public path-only API. */
export async function scan(
  roots: readonly string[],
  opts: ScanOptions = {},
): Promise<ScanResult<string[], PackError>> {
  const scanned = await scanValidated(roots, opts, true);
  return scanned.ok ? ok([...scanned.value.paths]) : scanned;
}

/** Return the validated source inventory without interpreting producer output kinds. */
export async function scanInventory(
  roots: readonly string[],
  opts: ScanOptions = {},
): Promise<ScanResult<ScanInventory, PackError>> {
  const scanned = await scanValidated(roots, opts);
  if (!scanned.ok) return scanned;
  const { paths, declarations, instances } = scanned.value;
  const inventory: InventoryDeclaration[] = [];
  for (const sourcePath of paths) {
    const declaration = declarations.get(sourcePath);
    if (declaration?.format === 'meta.json') {
      for (const { guid, kind, sourceIndex, sourceKey, name } of declaration.value.subAssets) {
        const displayName = name ?? sourceKey;
        inventory.push({
          guid,
          kind,
          sourcePath,
          sourceIndex,
          sourceRevision: declaration.sourceRevision,
          ...(sourceKey === undefined ? {} : { sourceKey }),
          ...(displayName === undefined ? {} : { name: displayName }),
        });
      }
    } else if (declaration?.format === 'pack.json') {
      for (const [sourceIndex, asset] of declaredPackAssets(declaration.value).entries()) {
        inventory.push({
          guid: asset.guid,
          kind: asset.kind,
          sourcePath,
          sourceRevision: declaration.sourceRevision,
          sourceKey: asset.sourceKey,
          sourceIndex,
          name: asset.name ?? asset.sourceKey,
        });
      }
    }
  }
  return ok({ paths, inventory, declarations, instances });
}
