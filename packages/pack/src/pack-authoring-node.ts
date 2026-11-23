import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AssetGuid as EngineAssetGuid, Result } from '@forgeax/engine-types';
import { err, isValidAssetGuidString, ok } from '@forgeax/engine-types';
import {
  type AssetVerificationReport,
  projectAssetVerificationReport,
  verificationSourceFacts,
} from './evidence/source-inventory.js';
import { AssetGuid, isValidPackSourceKey, PackageId } from './guid.js';
import {
  type AnyScriptablePackDefinition,
  createPackAuthoringGateway,
  type DirectPackJsonAsset,
  type PackAuthoringError,
  type PackAuthoringErrorCode,
  type PackAuthoringGatewayPort,
  type PackAuthoringOperation,
  type PackAuthoringOperationResult,
  type PackAuthoringResolutionStatus,
  type PackParameterDefinition,
  type PackParameterInheritanceSubject,
  parsePackSourceJson,
  projectDirectPackJson,
  type ResolvedPackParameterInheritance,
  resolvePackParameterInheritance,
  validatePackDefinition,
} from './pack-authoring.js';
import {
  PackSourceRevisionConflict,
  writePackSourceAtomically,
} from './pack-authoring-document.js';
import {
  createFileSystemPackDrafts,
  type FileSystemPackDraftOptions,
} from './pack-authoring-drafts-node.js';
import {
  packSourceFailure,
  packSourceRevision,
  readPackAuthoringDeclaration,
} from './pack-authoring-literals.js';
import { type ScanInventory, type ScanOptions, type ScanResult, scanInventory } from './scanner.js';
import { projectPackParameters } from './scriptable-pack-wire.js';

export interface FileSystemPackAuthoringOptions {
  readonly drafts?: Omit<FileSystemPackDraftOptions<unknown>, 'gameRoot'>;
  readonly gameRoot: string;
  /** Project owner prepares the full closure, dependency lock and candidate compile. */
  readonly transfer?: (
    operation: PackAuthoringOperation,
  ) => Promise<Result<PackAuthoringOperationResult, PackAuthoringError>>;
  readonly scanRoots?: readonly string[];
  /** Include external Catalog subjects and GUID aliases in ordinary inspection. */
  readonly inspectCatalogSubjects?: boolean;
  /** Catalog rows from the host's current projection. */
  readonly catalog?: () => readonly unknown[] | Promise<readonly unknown[]>;
  /** Build owner callback; the gateway itself does not own DDC or Catalog state. */
  readonly rebuild?: (
    sourcePath: string,
    mode: 'rebuild' | 'cold-cook',
  ) => Promise<Result<unknown, PackAuthoringError>>;
  /** Injection point for hosts that already own a validated Source Index. */
  readonly inventory?: (
    onSourceFailure?: ScanOptions['onSourceFailure'],
  ) => Promise<ScanResult<ScanInventory, unknown>>;
}

interface ConfinedPath {
  readonly absolute: string;
  readonly relative: string;
}

interface ProjectedDirectAsset extends DirectPackJsonAsset {
  readonly guid: string;
  readonly sourceKey: string;
}

interface SubjectBase {
  readonly packageId: PackageId;
  readonly sourcePath: string;
  readonly relativePath: string;
}

interface SourceSubject extends SubjectBase {
  readonly format: 'source';
  readonly definition: AnyScriptablePackDefinition;
}

interface DirectSubject extends SubjectBase {
  readonly format: 'direct';
  readonly assets: readonly ProjectedDirectAsset[];
}

interface InstanceSubject extends SubjectBase {
  readonly format: 'instance';
  readonly parent: PackageId;
  readonly values: Readonly<Record<string, unknown>>;
}

type Subject = SourceSubject | DirectSubject | InstanceSubject;

interface MaterializedAsset {
  readonly packageId: string;
  readonly sourceKey: string;
  readonly guid: string;
  readonly kind: string;
  readonly sourcePath?: string;
  readonly name?: string;
  readonly refs?: readonly string[];
  readonly ready: boolean;
}

type DirectAuthorAsset = Omit<MaterializedAsset, 'ready'>;

interface GatewaySnapshot {
  readonly inventory: ScanInventory;
  readonly sourceFailures: ReadonlyMap<string, PackAuthoringError>;
  readonly subjects: ReadonlyMap<string, Subject>;
  readonly assets: ReadonlyMap<string, DirectAuthorAsset | MaterializedAsset>;
  readonly materialized: readonly MaterializedAsset[];
  readonly declaredAssets: readonly DirectAuthorAsset[];
  readonly knownGuids: ReadonlySet<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return AssetGuid.format(value as EngineAssetGuid);
  if (Array.isArray(value)) return value.map((item) => jsonValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  }
  return value;
}

function makeError(
  code: PackAuthoringErrorCode,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>> = {},
  actual?: string,
): PackAuthoringError {
  return {
    code,
    expected,
    hint,
    ...(actual === undefined ? {} : { actual }),
    detail,
  };
}

function pathError(
  code:
    | 'pack-source-path-invalid'
    | 'pack-source-not-found'
    | 'pack-source-write-failed'
    | 'pack-source-revision-conflict',
  operation: PackAuthoringOperation,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>> = {},
  actual?: string,
): PackAuthoringError {
  return makeError(code, expected, hint, { requestId: operation.requestId, ...detail }, actual);
}

function confinedPath(
  gameRoot: string,
  candidate: unknown,
  operation: PackAuthoringOperation,
): Result<ConfinedPath, PackAuthoringError> {
  if (typeof candidate !== 'string' || candidate.length === 0 || isAbsolute(candidate)) {
    return err(
      pathError(
        'pack-source-path-invalid',
        operation,
        'a non-empty game-root-relative .pack.ts or .pack.json path',
        'pass a relative source locator inside the selected game root',
        { sourcePath: candidate },
        typeof candidate === 'string' ? candidate : undefined,
      ),
    );
  }
  const root = resolve(gameRoot);
  const absolute = resolve(root, candidate);
  const relativePath = relative(root, absolute).split(sep).join('/');
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    (!relativePath.endsWith('.pack.ts') && !relativePath.endsWith('.pack.json'))
  ) {
    return err(
      pathError(
        'pack-source-path-invalid',
        operation,
        'a game-root-relative .pack.ts or .pack.json path',
        'choose a Pack source path inside the selected game root',
        { sourcePath: candidate },
        candidate,
      ),
    );
  }
  return ok({ absolute, relative: relativePath });
}

function packageKey(packageId: PackageId): string {
  return PackageId.format(packageId).toLowerCase();
}

function parsePackageId(value: unknown): PackageId | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = PackageId.parse(value);
  return parsed.ok ? parsed.value : undefined;
}

function serializedParameters(
  definition: AnyScriptablePackDefinition,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  return 'parameters' in definition ? projectPackParameters(definition.parameters) : undefined;
}

function sourceSummary(subject: Subject) {
  const base = {
    sourcePath: subject.relativePath,
    packageId: PackageId.format(subject.packageId),
    format: subject.format === 'source' ? 'pack.ts' : subject.format,
  } as const;
  if (subject.format === 'source') {
    const parameters = serializedParameters(subject.definition);
    return { ...base, ...(parameters === undefined ? {} : { parameters }) };
  }
  return subject.format === 'instance'
    ? {
        ...base,
        parentPackageId: PackageId.format(subject.parent),
        values: jsonValue(subject.values) as Readonly<Record<string, unknown>>,
      }
    : base;
}

function sourceResult(
  subject: Subject,
  operation: PackAuthoringOperation,
): PackAuthoringOperationResult {
  const summary = sourceSummary(subject);
  return {
    operation: operation.operation,
    requestId: operation.requestId,
    ...summary,
    ...(subject.format === 'source' && 'parameters' in summary
      ? {
          capabilities: [
            'asset.source.instance.create',
            'asset.source.rebuild',
            'asset.source.cold-cook',
          ],
        }
      : {}),
    ...(subject.format === 'direct'
      ? {
          assets: subject.assets.map(({ sourceKey, guid, kind, name, refs }) => ({
            sourceKey,
            guid,
            kind,
            ...(name === undefined ? {} : { name }),
            refs,
          })),
        }
      : {}),
  };
}

function scanFailure(operation: PackAuthoringOperation, cause: unknown): PackAuthoringError {
  const value =
    cause !== null && typeof cause === 'object' ? (cause as Record<string, unknown>) : {};
  const detail = value.detail !== null && typeof value.detail === 'object' ? value.detail : {};
  const reason = isRecord(detail) && typeof detail.reason === 'string' ? detail.reason : undefined;
  const code: PackAuthoringErrorCode =
    reason === 'pack-parent-not-found' ||
    reason === 'pack-parent-cycle' ||
    reason === 'pack-parent-has-no-parameters' ||
    reason === 'pack-source-revision-conflict'
      ? reason
      : value.code === 'pack-guid-collision'
        ? 'pack-guid-collision'
        : 'pack-parameter-invalid';
  return makeError(
    code,
    typeof value.expected === 'string' ? value.expected : 'a valid Pack Source Index',
    typeof value.hint === 'string'
      ? value.hint
      : 'repair the first source or package diagnostic, then retry',
    {
      requestId: operation.requestId,
      cause: {
        ...(typeof value.code === 'string' ? { code: value.code } : {}),
        ...(typeof value.expected === 'string' ? { expected: value.expected } : {}),
        ...(typeof value.hint === 'string' ? { hint: value.hint } : {}),
        detail: value.detail ?? { reason: String(cause) },
      },
    },
  );
}

function scanRoots(options: FileSystemPackAuthoringOptions): readonly string[] {
  return options.scanRoots === undefined || options.scanRoots.length === 0
    ? [resolve(options.gameRoot)]
    : options.scanRoots.map((root) => resolve(options.gameRoot, root));
}

type InvalidCatalogRow = (
  code: PackAuthoringError['code'],
  expected: string,
  detail: Record<string, unknown>,
) => Result<never, PackAuthoringError>;

function projectCatalogPackRow(
  row: Record<string, unknown>,
  ready: boolean,
  invalid: InvalidCatalogRow,
): Result<MaterializedAsset | undefined, PackAuthoringError> {
  const { guid, kind, sourcePath, sourceKey, refs, packageId, subject, provenance } = row;
  const provider = isRecord(provenance) ? provenance.provider : undefined;
  if (
    typeof packageId !== 'string' ||
    typeof sourceKey !== 'string' ||
    (subject !== 'internal-asset' && provider !== 'pack-ts' && provider !== 'pack')
  )
    return ok(undefined);
  const identity = { packageId, sourceKey };
  const parsed = parsePackageId(packageId);
  if (!parsed)
    return invalid('pack-package-id-invalid', 'a valid Catalog Pack packageId', identity);
  if (!isValidPackSourceKey(sourceKey))
    return invalid('pack-source-key-invalid', 'a valid Catalog Pack sourceKey', identity);
  if (!isValidAssetGuidString(guid) || typeof kind !== 'string' || !kind)
    return invalid('pack-parameter-invalid', 'Catalog Pack rows with a GUID and kind', identity);
  const key = guid.toLowerCase();
  const expectedGuid = AssetGuid.format(AssetGuid.derive(parsed, sourceKey)).toLowerCase();
  if (key !== expectedGuid)
    return invalid('pack-guid-collision', 'Catalog GUID to equal UUIDv5(packageId, sourceKey)', {
      ...identity,
      expectedGuid,
      observedGuid: guid,
    });
  if (Array.isArray(refs) && !refs.every(isValidAssetGuidString))
    return invalid('pack-parameter-invalid', 'Catalog refs to contain AssetGuid strings', identity);
  return ok({
    packageId: PackageId.format(parsed),
    sourceKey,
    guid: key,
    kind,
    ready,
    ...(typeof sourcePath === 'string' ? { sourcePath } : {}),
    ...(Array.isArray(refs) ? { refs: Object.freeze([...refs]) } : {}),
  });
}

async function readCatalogProjection(
  options: FileSystemPackAuthoringOptions,
  operation: PackAuthoringOperation,
) {
  const invalid = (
    code: PackAuthoringError['code'],
    expected: string,
    detail: Record<string, unknown>,
  ) =>
    err(
      makeError(code, expected, 'repair the Catalog projection before querying Pack authoring', {
        requestId: operation.requestId,
        ...detail,
      }),
    );
  let rows: unknown;
  try {
    rows = (await options.catalog?.()) ?? [];
  } catch (cause) {
    return invalid('pack-parameter-invalid', 'the host to return readable Catalog rows', {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (!Array.isArray(rows))
    return invalid('pack-parameter-invalid', 'the host to return a Catalog row array', {});

  const materialized = new Map<string, MaterializedAsset>();
  const knownGuids = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) return invalid('pack-parameter-invalid', 'Catalog rows to be objects', {});
    const current = isRecord(row.publication) ? row.publication.current : undefined;
    const ready =
      row.lifecycle === 'current' &&
      isRecord(current) &&
      typeof current.packageUrl === 'string' &&
      current.packageUrl.length > 0;
    const projected = projectCatalogPackRow(row, ready, invalid);
    if (!projected.ok) return projected;
    const asset = projected.value;
    if (asset !== undefined) {
      const previous = materialized.get(asset.guid);
      if (previous !== undefined)
        return invalid('pack-guid-collision', 'one Catalog owner per derived AssetGuid', {
          guid: asset.guid,
          packageId: asset.packageId,
          sourceKey: asset.sourceKey,
          paths: [previous.sourcePath, asset.sourcePath],
        });
      materialized.set(asset.guid, asset);
    }
    if (ready && typeof row.kind === 'string' && row.kind && isValidAssetGuidString(row.guid))
      knownGuids.add(row.guid.toLowerCase());
  }
  return ok({
    materialized: [...materialized.values()].sort((left, right) =>
      `${left.packageId}/${left.sourceKey}`.localeCompare(`${right.packageId}/${right.sourceKey}`),
    ),
    knownGuids,
  });
}

async function createSnapshot(
  options: FileSystemPackAuthoringOptions,
  operation: PackAuthoringOperation,
): Promise<Result<GatewaySnapshot, PackAuthoringError>> {
  const sourceFailures = new Map<string, PackAuthoringError>();
  const partialRead = ['asset.list', 'asset.inspect', 'asset.resolve'].includes(
    operation.operation,
  );
  const onSourceFailure: ScanOptions['onSourceFailure'] = partialRead
    ? (sourcePath, error) => sourceFailures.set(sourcePath, scanFailure(operation, error))
    : undefined;
  // Authoring consumes metadata without retaining worker leases.
  const scanned = options.inventory
    ? await options.inventory(onSourceFailure)
    : await scanInventory(scanRoots(options), {
        scriptablePack: { metadataOnly: true },
        ...(onSourceFailure === undefined ? {} : { onSourceFailure }),
      });
  if (!scanned.ok) return err(scanFailure(operation, scanned.error));
  const subjects = new Map<string, Subject>();
  const directAssets: DirectAuthorAsset[] = [];
  for (const [sourcePath, declaration] of scanned.value.declarations) {
    const relativePath = relative(resolve(options.gameRoot), sourcePath).split(sep).join('/');
    if (declaration.format === 'pack.ts') {
      subjects.set(packageKey(declaration.definition.packageId), {
        format: 'source',
        packageId: declaration.definition.packageId,
        sourcePath,
        relativePath,
        definition: declaration.definition,
      });
      continue;
    }
    if (declaration.format !== 'pack.json') continue;
    const parsed = declaration.value;
    if (parsed.format === 'direct') {
      const projected = projectDirectPackJson(parsed);
      const subject: DirectSubject = {
        format: 'direct',
        packageId: parsed.packageId,
        sourcePath,
        relativePath,
        assets: projected.assets,
      };
      subjects.set(packageKey(subject.packageId), subject);
      directAssets.push(
        ...projected.assets.map((asset) => ({
          packageId: projected.packageId.toLowerCase(),
          sourceKey: asset.sourceKey,
          guid: asset.guid.toLowerCase(),
          kind: asset.kind,
          sourcePath: relativePath,
          ...(asset.name === undefined ? {} : { name: asset.name }),
          refs: asset.refs,
        })),
      );
    } else {
      subjects.set(packageKey(parsed.packageId), { ...parsed, sourcePath, relativePath });
    }
  }
  const catalog = await readCatalogProjection(options, operation);
  if (!catalog.ok) return catalog;
  const { materialized, knownGuids } = catalog.value;
  const guidOwners = new Map<string, string>();
  const assets = new Map<string, DirectAuthorAsset | MaterializedAsset>();
  for (const entry of scanned.value.inventory) {
    const declaration = scanned.value.declarations.get(entry.sourcePath);
    if (declaration?.format === 'pack.json') continue;
    guidOwners.set(entry.guid.toLowerCase(), entry.sourcePath);
  }
  for (const asset of [...directAssets, ...materialized]) {
    const existing = guidOwners.get(asset.guid);
    const direct = assets.get(asset.guid);
    if (
      existing !== undefined &&
      (!('ready' in asset) ||
        direct?.packageId !== asset.packageId ||
        direct.sourceKey !== asset.sourceKey)
    ) {
      return err(
        makeError(
          'pack-guid-collision',
          'one current-generation owner per AssetGuid',
          'remove the conflicting projection or repair the source owner before querying Pack authoring',
          { requestId: operation.requestId, guid: asset.guid, paths: [existing, asset.sourcePath] },
        ),
      );
    }
    // A published row for a direct author asset overlays the same derived GUID.
    assets.set(asset.guid, asset);
    guidOwners.set(asset.guid, asset.sourcePath ?? asset.packageId);
  }
  for (const entry of scanned.value.inventory) knownGuids.add(entry.guid.toLowerCase());
  for (const asset of assets.keys()) knownGuids.add(asset);
  return ok({
    inventory: scanned.value,
    sourceFailures,
    subjects,
    assets,
    materialized,
    declaredAssets: directAssets,
    knownGuids,
  });
}

function parentSubject(
  snapshot: GatewaySnapshot,
  packageId: PackageId,
): PackParameterInheritanceSubject | undefined {
  const subject = snapshot.subjects.get(packageKey(packageId));
  if (subject === undefined) return undefined;
  if (subject.format === 'source') {
    return {
      format: 'source',
      packageId: subject.packageId,
      parameters: 'parameters' in subject.definition ? subject.definition.parameters : [],
    };
  }
  return subject;
}

async function resolveInstance(
  snapshot: GatewaySnapshot,
  subject: InstanceSubject,
): Promise<Result<ResolvedPackParameterInheritance, PackAuthoringError>> {
  return resolvePackParameterInheritance(subject, (packageId) =>
    packageKey(subject.packageId) === packageKey(packageId)
      ? subject
      : parentSubject(snapshot, packageId),
  );
}

function locateSourcePath(
  gameRoot: string,
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
  locator: string,
): Result<Subject, PackAuthoringError> {
  const confined = confinedPath(gameRoot, locator, operation);
  if (!confined.ok) return confined;
  const sourcePath = confined.value.relative;
  const subject = [...snapshot.subjects.values()].find(
    (entry) => entry.relativePath === sourcePath,
  );
  return subject === undefined
    ? err(
        pathError(
          'pack-source-not-found',
          operation,
          'sourcePath to identify a current Pack subject',
          'inspect the current Source Index and choose an existing source path',
          { sourcePath },
          sourcePath,
        ),
      )
    : ok(subject);
}

function conflictingSourcePackage(
  operation: PackAuthoringOperation,
  source: Subject,
  packageId: PackageId | undefined,
  requestedText = packageId === undefined ? undefined : PackageId.format(packageId),
): PackAuthoringError | undefined {
  if (packageId === undefined || packageKey(packageId) === packageKey(source.packageId)) return;
  return makeError(
    'pack-parameter-invalid',
    'sourcePath and packageId to identify the same Pack subject',
    'remove the conflicting locator or use the packageId returned by asset.list',
    {
      requestId: operation.requestId,
      sourcePath: source.relativePath,
      packageId: requestedText,
      observedPackageId: PackageId.format(source.packageId),
    },
  );
}

function subjectFor(
  gameRoot: string,
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): Result<Subject, PackAuthoringError> {
  if (operation.sourcePath !== undefined) {
    const source = locateSourcePath(gameRoot, snapshot, operation, operation.sourcePath);
    if (!source.ok || operation.packageId === undefined) return source;
    const parsed = PackageId.parse(operation.packageId);
    if (!parsed.ok) {
      return err(
        makeError(
          'pack-package-id-invalid',
          'a UUID packageId',
          'repair packageId before querying the Pack subject',
          { requestId: operation.requestId, packageId: operation.packageId },
          operation.packageId,
        ),
      );
    }
    const conflict = conflictingSourcePackage(
      operation,
      source.value,
      parsed.value,
      operation.packageId,
    );
    return conflict === undefined ? source : err(conflict);
  }
  if (operation.packageId !== undefined) {
    const parsed = PackageId.parse(operation.packageId);
    if (!parsed.ok) {
      return err(
        makeError(
          'pack-package-id-invalid',
          'a UUID packageId',
          'repair packageId before querying the Pack',
          { requestId: operation.requestId, packageId: operation.packageId },
          operation.packageId,
        ),
      );
    }
    const subject = snapshot.subjects.get(packageKey(parsed.value));
    if (subject !== undefined) return ok(subject);
    return err(
      makeError(
        'pack-source-not-found',
        'packageId to exist in the current Source Index',
        'inspect the current source index and choose an existing packageId',
        { requestId: operation.requestId, packageId: operation.packageId },
      ),
    );
  }
  if (operation.subject !== undefined && !isValidAssetGuidString(operation.subject)) {
    const confined = confinedPath(gameRoot, operation.subject, operation);
    if (!confined.ok) return confined;
    const source = [...snapshot.subjects.values()].find(
      (candidate) => candidate.relativePath === confined.value.relative,
    );
    if (source !== undefined) return ok(source);
  }
  if (operation.subject !== undefined && isValidAssetGuidString(operation.subject)) {
    const guid = operation.subject.toLowerCase();
    const packageSubject = snapshot.subjects.get(guid);
    if (packageSubject !== undefined) return ok(packageSubject);
    const asset = snapshot.assets.get(guid);
    if (asset !== undefined) {
      const subject = snapshot.subjects.get(asset.packageId);
      if (subject !== undefined) return ok(subject);
    }
  }
  return err(
    makeError(
      'pack-source-not-found',
      'a packageId, source path, or known AssetGuid subject',
      'run asset.list or asset.inspect to obtain a current subject locator',
      { requestId: operation.requestId, subject: operation.subject },
    ),
  );
}

function assetStatus(
  asset: DirectAuthorAsset | MaterializedAsset | undefined,
): PackAuthoringResolutionStatus {
  if (asset === undefined || !('ready' in asset)) return 'identity';
  return asset.ready ? 'ready' : 'present';
}

function instanceInspection(snapshot: GatewaySnapshot, subject: InstanceSubject) {
  const resolved = snapshot.inventory.instances.get(subject.sourcePath);
  const failure = snapshot.sourceFailures.get(subject.sourcePath);
  if (failure !== undefined) return err(failure);
  if (resolved === undefined)
    return err(
      makeError(
        'pack-source-not-found',
        'a resolved instance in the validated Source Index',
        'repair the parent chain and refresh the Pack inventory',
        { sourcePath: subject.relativePath },
      ),
    );
  return ok({
    parameters: projectPackParameters(resolved.parameters),
    effectiveValues: jsonValue(resolved.values) as Readonly<Record<string, unknown>>,
    parentChain: resolved.parentChain,
  });
}

async function inspectAsset(
  gameRoot: string,
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): Promise<Result<PackAuthoringOperationResult, PackAuthoringError>> {
  const selected = subjectFor(gameRoot, snapshot, operation);
  if (!selected.ok) return selected;
  const subject = selected.value;
  const source = await readConfined({ gameRoot }, operation, subject.relativePath);
  if (!source.ok) return source;
  const inspectedSource = {
    ...sourceResult(subject, operation),
    revision: source.value.revision,
    ...(subject.format === 'source'
      ? {
          assets: snapshot.materialized
            .filter((asset) => asset.packageId === packageKey(subject.packageId))
            .map((asset) => ({ ...asset })),
        }
      : {}),
  };
  if (operation.sourceKey !== undefined) {
    if (!isValidPackSourceKey(operation.sourceKey)) {
      return err(
        makeError(
          'pack-source-key-invalid',
          'a stable lower-case sourceKey',
          'repair sourceKey before inspecting the output identity',
          { requestId: operation.requestId, sourceKey: operation.sourceKey },
          operation.sourceKey,
        ),
      );
    }
    if (subject.format === 'direct') {
      const asset = subject.assets.find((candidate) => candidate.sourceKey === operation.sourceKey);
      if (asset === undefined) {
        return err(
          makeError(
            'pack-output-not-materialized',
            'sourceKey to exist in the direct Pack',
            'inspect the current source and choose an existing sourceKey',
            {
              requestId: operation.requestId,
              sourceKey: operation.sourceKey,
              packageId: PackageId.format(subject.packageId),
            },
          ),
        );
      }
      const output = snapshot.assets.get(asset.guid.toLowerCase());
      return ok({
        ...inspectedSource,
        sourceKey: asset.sourceKey,
        guid: asset.guid,
        kind: asset.kind,
        payload: jsonValue(asset.payload) as Readonly<Record<string, unknown>>,
        status: assetStatus(output),
      });
    }
    try {
      const guid = AssetGuid.format(AssetGuid.derive(subject.packageId, operation.sourceKey));
      const output = snapshot.assets.get(guid.toLowerCase());
      const materialized = output !== undefined && 'ready' in output ? output : undefined;
      const resolvedInstance =
        subject.format === 'instance' ? instanceInspection(snapshot, subject) : undefined;
      if (resolvedInstance !== undefined && !resolvedInstance.ok) return resolvedInstance;
      return ok({
        ...inspectedSource,
        sourceKey: operation.sourceKey,
        guid,
        ...resolvedInstance?.value,
        status: assetStatus(materialized),
        ...(materialized === undefined ? {} : { kind: materialized.kind }),
      });
    } catch (cause) {
      return err(
        makeError(
          'pack-source-key-invalid',
          'a valid lower-case sourceKey',
          'repair sourceKey before inspecting the output identity',
          { requestId: operation.requestId, sourceKey: operation.sourceKey, cause: String(cause) },
          operation.sourceKey,
        ),
      );
    }
  }
  if (subject.format === 'instance') {
    const instance = instanceInspection(snapshot, subject);
    return instance.ok ? ok({ ...inspectedSource, ...instance.value }) : instance;
  }
  return ok(inspectedSource);
}

function* metaAssets(snapshot: GatewaySnapshot) {
  for (const { sourceKey: _sourceKey, ...entry } of snapshot.inventory.inventory) {
    if (snapshot.inventory.declarations.get(entry.sourcePath)?.format === 'meta.json') yield entry;
  }
}

async function inspectCatalogSubject(
  gameRoot: string,
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
  sourceFailure: PackAuthoringError | undefined,
): Promise<OperationResult> {
  const subject = operation.subject ?? '';
  if (snapshot.subjects.size > 0 || operation.sourceKey !== undefined) {
    if (isValidAssetGuidString(subject)) {
      const resolved = await resolveAsset(gameRoot, snapshot, {
        operation: 'asset.resolve',
        requestId: operation.requestId,
        subject,
      });
      if (resolved.ok) return ok({ ...resolved.value, operation: 'asset.inspect' });
    }
    const inspected = sourceFailure
      ? err(sourceFailure)
      : await inspectAsset(gameRoot, snapshot, operation);
    if (
      inspected.ok ||
      operation.sourceKey !== undefined ||
      !['pack-source-not-found', 'pack-source-path-invalid'].includes(inspected.error.code)
    )
      return inspected;
  }
  const key = subject.toLowerCase();
  const matches = [...metaAssets(snapshot)].filter(
    (entry) => entry.guid.toLowerCase() === key || entry.name?.toLowerCase() === key,
  );
  const [entry] = matches;
  if (entry && matches.length === 1)
    return ok({
      operation: 'asset.inspect',
      requestId: operation.requestId,
      catalogSubject: entry,
    });
  const missing = matches.length === 0;
  return err(
    makeError(
      missing ? 'asset-not-found' : 'asset-subject-ambiguous',
      'the GUID or name to resolve to exactly one asset',
      missing ? 'Run asset list and choose a known subject.' : 'Use the stable GUID.',
      { subject, matches },
    ),
  );
}

function listAssets(
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): PackAuthoringOperationResult {
  const assets: Readonly<Record<string, unknown>>[] = [...snapshot.assets.values()]
    .map((asset) => ({
      packageId: asset.packageId,
      sourceKey: asset.sourceKey,
      guid: asset.guid,
      kind: asset.kind,
      ...(asset.name === undefined ? {} : { name: asset.name }),
      ...(asset.sourcePath === undefined ? {} : { sourcePath: asset.sourcePath }),
      status: assetStatus(asset),
    }))
    .sort((left, right) =>
      `${left.packageId}/${left.sourceKey}`.localeCompare(`${right.packageId}/${right.sourceKey}`),
    );
  assets.push(...metaAssets(snapshot));
  const sources = [...snapshot.subjects.values()]
    .map(sourceSummary)
    .sort((left, right) =>
      `${left.packageId}/${left.sourcePath}`.localeCompare(
        `${right.packageId}/${right.sourcePath}`,
      ),
    );
  return {
    operation: operation.operation,
    requestId: operation.requestId,
    assets,
    sources,
    ...(snapshot.sourceFailures.size
      ? {
          diagnostics: [...snapshot.sourceFailures].map(([sourcePath, error]) => ({
            sourcePath,
            error,
          })),
        }
      : {}),
    snapshot: { sourceCount: snapshot.subjects.size, assetCount: assets.length },
  };
}

async function resolveAsset(
  gameRoot: string,
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): Promise<Result<PackAuthoringOperationResult, PackAuthoringError>> {
  if (
    operation.require !== undefined &&
    operation.require !== 'identity' &&
    operation.require !== 'present' &&
    operation.require !== 'ready'
  ) {
    return err(
      makeError(
        'pack-parameter-invalid',
        "require to be 'identity', 'present', or 'ready'",
        'choose one of the three Pack identity proof levels',
        { requestId: operation.requestId, require: operation.require },
      ),
    );
  }
  let packageId: PackageId | undefined;
  let sourceKey = operation.sourceKey;
  let resolvedOutputGuid: string | undefined;
  if (operation.packageId !== undefined) {
    const parsed = PackageId.parse(operation.packageId);
    if (!parsed.ok) {
      return err(
        makeError(
          'pack-package-id-invalid',
          'a UUID packageId',
          'repair packageId before resolving a sourceKey',
          { requestId: operation.requestId },
          operation.packageId,
        ),
      );
    }
    packageId = parsed.value;
  }
  if (operation.subject !== undefined && isValidAssetGuidString(operation.subject)) {
    const found = snapshot.assets.get(operation.subject.toLowerCase());
    if (found !== undefined) {
      const parsed = PackageId.parse(found.packageId);
      if (parsed.ok) {
        if (packageId !== undefined && packageKey(packageId) !== packageKey(parsed.value)) {
          return err(
            makeError(
              'pack-parameter-invalid',
              'packageId and AssetGuid to identify the same Pack subject',
              'remove the conflicting locator or resolve the pair from one source',
              {
                requestId: operation.requestId,
                packageId: PackageId.format(packageId),
                observedPackageId: found.packageId,
                guid: operation.subject,
              },
            ),
          );
        }
        if (sourceKey !== undefined && sourceKey !== found.sourceKey) {
          return err(
            makeError(
              'pack-parameter-invalid',
              'sourceKey and AssetGuid to identify the same Pack output',
              'remove the conflicting locator or use the sourceKey returned by asset.list',
              {
                requestId: operation.requestId,
                sourceKey,
                observedSourceKey: found.sourceKey,
                guid: operation.subject,
              },
            ),
          );
        }
        packageId = parsed.value;
        sourceKey ??= found.sourceKey;
        resolvedOutputGuid = found.guid;
      }
    }
  }
  if (
    packageId === undefined &&
    operation.subject !== undefined &&
    isValidAssetGuidString(operation.subject)
  ) {
    const parsed = PackageId.parse(operation.subject);
    if (parsed.ok) packageId = parsed.value;
  }
  const sourceLocatorCandidate =
    operation.sourcePath ??
    (operation.subject !== undefined && !isValidAssetGuidString(operation.subject)
      ? operation.subject
      : undefined);
  if (sourceLocatorCandidate !== undefined) {
    const source = locateSourcePath(gameRoot, snapshot, operation, sourceLocatorCandidate);
    if (!source.ok) return source;
    const conflict = conflictingSourcePackage(operation, source.value, packageId);
    if (conflict !== undefined) return err(conflict);
    packageId ??= source.value.packageId;
  }
  if (packageId === undefined || sourceKey === undefined) {
    return err(
      makeError(
        'pack-parameter-invalid',
        'packageId and sourceKey (or a known output GUID)',
        'pass packageId + sourceKey, a known AssetGuid, or a source path plus sourceKey',
        { requestId: operation.requestId, packageId: operation.packageId, sourceKey },
      ),
    );
  }
  if (!isValidPackSourceKey(sourceKey)) {
    return err(
      makeError(
        'pack-source-key-invalid',
        'a stable lower-case sourceKey',
        'repair sourceKey before deriving its AssetGuid',
        { requestId: operation.requestId, sourceKey },
        sourceKey,
      ),
    );
  }
  let guid: EngineAssetGuid;
  try {
    guid = AssetGuid.derive(packageId, sourceKey);
  } catch (cause) {
    return err(
      makeError(
        'pack-source-key-invalid',
        'a valid packageId and sourceKey pair',
        'repair the identity pair before resolving',
        {
          requestId: operation.requestId,
          cause: cause instanceof Error ? cause.message : String(cause),
        },
      ),
    );
  }
  const guidString = AssetGuid.format(guid);
  if (resolvedOutputGuid !== undefined && guidString.toLowerCase() !== resolvedOutputGuid) {
    return err(
      makeError(
        'pack-guid-collision',
        'the known output GUID to equal UUIDv5(packageId, sourceKey)',
        'rebuild the current generation from the stable identity pair',
        {
          requestId: operation.requestId,
          packageId: PackageId.format(packageId),
          sourceKey,
          expectedGuid: guidString,
          observedGuid: resolvedOutputGuid,
        },
      ),
    );
  }
  const asset = snapshot.assets.get(guidString.toLowerCase());
  const status = assetStatus(asset);
  const requirement: PackAuthoringResolutionStatus = operation.require ?? 'identity';
  if (requirement === 'present' && status === 'identity') {
    return err(
      makeError(
        'pack-output-not-materialized',
        'the current build topology to contain this sourceKey',
        'run rebuild/cold-cook and retry after the current generation publishes the output',
        {
          requestId: operation.requestId,
          packageId: PackageId.format(packageId),
          sourceKey,
          guid: guidString,
        },
      ),
    );
  }
  if (requirement === 'ready' && status !== 'ready') {
    return err(
      makeError(
        'asset-not-ready',
        'current Pack evidence and artifacts for this derived GUID',
        'inspect producer evidence, then rebuild or cold-cook the same subject',
        {
          requestId: operation.requestId,
          packageId: PackageId.format(packageId),
          sourceKey,
          guid: guidString,
        },
      ),
    );
  }
  return ok({
    operation: operation.operation,
    requestId: operation.requestId,
    packageId: PackageId.format(packageId),
    sourceKey,
    guid: guidString,
    status,
    ...(asset === undefined
      ? {}
      : {
          ...(asset.sourcePath === undefined ? {} : { sourcePath: asset.sourcePath }),
          kind: asset.kind,
        }),
  });
}

type VerificationAsset = AssetVerificationReport['assets'][number];

function verificationSourceFormat(
  gameRoot: string,
  sourcePath: string | undefined,
  fallback: VerificationAsset['source']['format'] = 'pack.ts',
): VerificationAsset['source']['format'] {
  if (sourcePath === undefined) return fallback;
  const absolute = resolve(gameRoot, sourcePath);
  if (absolute.endsWith('.meta.json')) return 'meta.json';
  if (absolute.endsWith('.pack.json')) return 'pack.json';
  if (absolute.endsWith('.pack.ts')) return 'pack.ts';
  return fallback;
}

function verificationOutput(
  materialized: MaterializedAsset | undefined,
): VerificationAsset['output'] {
  if (materialized !== undefined) {
    return {
      status: materialized.ready ? 'produced' : 'unknown',
      availability: materialized.ready ? 'available' : 'unknown',
      freshness: 'unknown',
    };
  }
  return { status: 'unproduced', availability: 'unknown', freshness: 'unknown' };
}

function createGatewayVerificationReport(
  gameRoot: string,
  snapshot: GatewaySnapshot,
): AssetVerificationReport {
  const materializedByGuid = new Map(
    snapshot.materialized.map((asset) => [asset.guid.toLowerCase(), asset] as const),
  );
  const rows = new Map<string, VerificationAsset>();
  for (const entry of snapshot.inventory.inventory) {
    const declaration = snapshot.inventory.declarations.get(entry.sourcePath);
    const materialized = materializedByGuid.get(entry.guid.toLowerCase());
    rows.set(entry.guid.toLowerCase(), {
      ...verificationSourceFacts(
        entry,
        declaration,
        verificationSourceFormat(gameRoot, entry.sourcePath),
      ),
      output: verificationOutput(materialized),
      producer: { state: materialized !== undefined ? 'published' : 'not-run' },
    });
  }
  for (const asset of snapshot.materialized) {
    const key = asset.guid.toLowerCase();
    if (rows.has(key)) continue;
    const sourcePath =
      asset.sourcePath === undefined ? undefined : resolve(gameRoot, asset.sourcePath);
    const declaration =
      sourcePath === undefined ? undefined : snapshot.inventory.declarations.get(sourcePath);
    const format = declaration?.format ?? verificationSourceFormat(gameRoot, asset.sourcePath);
    rows.set(key, {
      guid: asset.guid,
      type: asset.kind,
      source: {
        path: sourcePath ?? `${asset.packageId}/${asset.sourceKey}`,
        format,
        role: 'author',
        ...(declaration === undefined ? {} : { revision: declaration.sourceRevision }),
      },
      output: verificationOutput(asset),
      dependencies: asset.refs ?? [],
      producer: { state: 'published' },
      sourceKey: asset.sourceKey,
    });
  }
  const assets = [...rows.values()].sort((left, right) =>
    `${left.source.path}:${left.guid}`.localeCompare(`${right.source.path}:${right.guid}`),
  );
  const publishedSources = new Set<string>();
  for (const asset of snapshot.materialized) {
    publishedSources.add(asset.packageId);
    if (asset.sourcePath !== undefined) publishedSources.add(resolve(gameRoot, asset.sourcePath));
  }
  return projectAssetVerificationReport(
    resolve(gameRoot),
    snapshot.inventory.declarations,
    assets,
    (asset) => asset,
    assets.filter((asset) => asset.type === 'material').length,
    publishedSources,
  );
}

async function verify(
  gameRoot: string,
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): Promise<Result<PackAuthoringOperationResult, PackAuthoringError>> {
  for (const asset of [...snapshot.declaredAssets, ...snapshot.materialized]) {
    const missing = asset.refs?.find((ref) => !snapshot.knownGuids.has(ref.toLowerCase()));
    if (missing === undefined) continue;
    const direct = !('ready' in asset);
    return err(
      makeError(
        'pack-output-reference-missing',
        direct
          ? 'every direct Pack ref to resolve to a known AssetGuid'
          : 'every materialized Pack ref to resolve to a known AssetGuid',
        direct
          ? 'repair the payload ref or add the owning external asset before verifying'
          : 'repair the published output reference or publish its owning asset before verifying',
        {
          requestId: operation.requestId,
          packageId: asset.packageId,
          sourceKey: asset.sourceKey,
          guid: missing,
        },
      ),
    );
  }
  const report = createGatewayVerificationReport(gameRoot, snapshot);
  return ok({ ...report, operation: operation.operation, requestId: operation.requestId });
}

function packageIdFromOperation(
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): Result<PackageId, PackAuthoringError> {
  const value =
    operation.packageId === undefined
      ? ok(PackageId.random())
      : PackageId.parse(operation.packageId);
  if (!value.ok) {
    return err(
      makeError(
        'pack-package-id-invalid',
        'a UUID packageId',
        'repair packageId or omit it so the gateway can mint one',
        { requestId: operation.requestId },
        operation.packageId,
      ),
    );
  }
  const normalized = packageKey(value.value);
  const alreadyMaterialized = snapshot.materialized.some((asset) => asset.packageId === normalized);
  return snapshot.subjects.has(normalized) || alreadyMaterialized
    ? err(
        makeError(
          'pack-package-id-collision',
          'a packageId unused by the current Source Index',
          'choose a new packageId or use clone without an explicit identity',
          { requestId: operation.requestId, packageId: PackageId.format(value.value) },
        ),
      )
    : ok(value.value);
}

async function readConfined(
  options: FileSystemPackAuthoringOptions,
  operation: PackAuthoringOperation,
  sourcePath: unknown,
): Promise<
  Result<ConfinedPath & { readonly source: string; readonly revision: string }, PackAuthoringError>
> {
  const path = confinedPath(options.gameRoot, sourcePath, operation);
  if (!path.ok) return path;
  try {
    const source = await readFile(path.value.absolute, 'utf8');
    return ok({ ...path.value, source, revision: packSourceRevision(source) });
  } catch (cause) {
    const code: 'pack-source-not-found' | 'pack-source-write-failed' =
      (cause as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'pack-source-not-found'
        : 'pack-source-write-failed';
    return err(
      pathError(
        code,
        operation,
        'the requested Pack source to be readable',
        'restore the source or choose a current locator',
        {
          sourcePath: path.value.relative,
          cause: cause instanceof Error ? cause.message : String(cause),
        },
        path.value.relative,
      ),
    );
  }
}

function revisionConflict(
  operation: PackAuthoringOperation,
  path: string,
  actual: string,
): PackAuthoringError {
  return makeError(
    'pack-source-revision-conflict',
    'expectedRevision to match the current source bytes',
    'inspect the current source, reconcile the edit, and retry with a new requestId',
    {
      requestId: operation.requestId,
      sourcePath: path,
      expectedRevision: operation.expectedRevision,
      actualRevision: actual,
    },
    actual,
  );
}

function directJson(
  packageId: PackageId,
  assets: Readonly<Record<string, DirectPackJsonAsset>>,
): Record<string, unknown> {
  return { schemaVersion: '3.0.0', packageId: PackageId.format(packageId), assets };
}

function packSourceScaffold(
  packageId: PackageId,
  parameters: readonly PackParameterDefinition[] | undefined,
): string {
  const parameterSource =
    parameters === undefined
      ? ''
      : '\n  parameters: ' +
        JSON.stringify(
          parameters.map((parameter) => jsonValue(parameter)),
          null,
          2,
        ).replaceAll('\n', '\n  ') +
        ',';
  return (
    "import { definePack, definePackageId } from '@forgeax/engine-pack/source';\n" +
    "import { ok } from '@forgeax/engine-types';\n\n" +
    'const packageId = definePackageId(' +
    JSON.stringify(PackageId.format(packageId)) +
    ');\n\n' +
    'export default definePack({\n' +
    "  schemaVersion: '2.0.0',\n" +
    '  packageId,' +
    parameterSource +
    '\n  build: () => ok({}),\n' +
    '});\n'
  );
}

async function writeAuthoringSource(
  operation: PackAuthoringOperation,
  path: ConfinedPath,
  packageId: PackageId,
  source: string,
  extra: Partial<PackAuthoringOperationResult>,
): Promise<OperationResult> {
  try {
    await mkdir(dirname(path.absolute), { recursive: true });
    await writePackSourceAtomically(
      path.absolute,
      source,
      operation.operation === 'asset.source.values.apply'
        ? { expectedRevision: operation.expectedRevision ?? '' }
        : {},
    );
  } catch (cause) {
    if (cause instanceof PackSourceRevisionConflict)
      return err(revisionConflict(operation, path.relative, cause.revision));
    const updating = operation.operation === 'asset.source.values.apply';
    const creatingInstance = operation.operation === 'asset.source.instance.create';
    const subject = updating
      ? 'updated instance'
      : creatingInstance
        ? 'new instance'
        : 'new Pack source';
    return err(
      pathError(
        'pack-source-write-failed',
        operation,
        `the ${subject} to be written atomically`,
        creatingInstance
          ? 'repair filesystem permissions or disk capacity, then retry'
          : 'repair filesystem permissions or disk capacity, then retry with a new requestId',
        {
          [updating ? 'sourcePath' : 'targetPath']: path.relative,
          cause: cause instanceof Error ? cause.message : String(cause),
        },
      ),
    );
  }
  return inspectAfterWrite(operation, path, source, packageId, extra);
}

async function inspectAfterWrite(
  operation: PackAuthoringOperation,
  path: ConfinedPath,
  source: string,
  packageId: PackageId,
  extra: Partial<PackAuthoringOperationResult> = {},
): Promise<Result<PackAuthoringOperationResult, PackAuthoringError>> {
  return ok({
    operation: operation.operation,
    requestId: operation.requestId,
    sourcePath: path.relative,
    targetPath: path.relative,
    packageId: PackageId.format(packageId),
    revision: packSourceRevision(source),
    ...extra,
  });
}

type OperationResult = Result<PackAuthoringOperationResult, PackAuthoringError>;
type ConfinedSource = ConfinedPath & { readonly source: string; readonly revision: string };

async function inspectParameters(
  options: FileSystemPackAuthoringOptions,
  operation: PackAuthoringOperation,
): Promise<OperationResult> {
  const source = await readConfined(options, operation, operation.sourcePath ?? operation.subject);
  if (!source.ok) return source;
  if (!source.value.relative.endsWith('.pack.ts'))
    return err(
      packSourceFailure(
        source.value.relative,
        'parametersOnly requires a .pack.ts source; use ordinary asset.inspect for JSON Packs',
      ),
    );
  const declaration = readPackAuthoringDeclaration(source.value.relative, source.value.source);
  if (!declaration.ok) return declaration;
  return ok({
    operation: operation.operation,
    requestId: operation.requestId,
    sourcePath: source.value.relative,
    revision: declaration.value.revision,
    packageId: declaration.value.packageId,
    format: 'pack.ts',
    status: 'identity',
    parameters: projectPackParameters(declaration.value.parameters).map((parameter) => ({
      ...parameter,
      mode: typeof parameter.apply === 'object' ? 'runtime' : 'generation',
      location: declaration.value.defaults.get(String(parameter.name))?.location,
    })),
  });
}

/** asset.list / asset.inspect / asset.resolve over one Source Index snapshot. */
async function readSourceIndex(
  options: FileSystemPackAuthoringOptions,
  operation: PackAuthoringOperation,
): Promise<OperationResult> {
  const snapshot = await createSnapshot(options, operation);
  if (!snapshot.ok) return snapshot;
  const selected = operation.sourcePath ?? operation.subject;
  const sourceFailure =
    typeof selected === 'string'
      ? snapshot.value.sourceFailures.get(resolve(options.gameRoot, selected))
      : undefined;
  if (operation.operation === 'asset.inspect' && options.inspectCatalogSubjects)
    return inspectCatalogSubject(options.gameRoot, snapshot.value, operation, sourceFailure);
  if (sourceFailure) return err(sourceFailure);
  if (operation.operation === 'asset.resolve')
    return resolveAsset(options.gameRoot, snapshot.value, operation);
  return operation.operation === 'asset.list'
    ? ok(listAssets(snapshot.value, operation))
    : await inspectAsset(options.gameRoot, snapshot.value, operation);
}

/** A missing path is the only valid target for source or instance creation. */
async function ensureNewSourceTarget(
  path: ConfinedPath,
  operation: PackAuthoringOperation,
): Promise<Result<void, PackAuthoringError>> {
  const instance = operation.operation === 'asset.source.instance.create';
  try {
    await stat(path.absolute);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return ok(undefined);
    return err(
      pathError(
        'pack-source-write-failed',
        operation,
        instance
          ? 'the instance target to be writable'
          : 'the target path to be available for atomic creation',
        instance ? 'repair filesystem permissions and retry' : 'repair the filesystem and retry',
        { targetPath: path.relative, cause: String(cause) },
      ),
    );
  }
  return err(
    pathError(
      'pack-source-revision-conflict',
      operation,
      instance ? 'an unused instance target path' : 'an unused target source path',
      instance
        ? 'inspect the existing instance or choose another path'
        : 'inspect the existing source or choose another target path',
      { targetPath: path.relative },
      path.relative,
    ),
  );
}

function directCreateSource(
  packageId: PackageId,
  operation: PackAuthoringOperation,
): Result<string, PackAuthoringError> {
  if (
    operation.parameters !== undefined ||
    operation.parent !== undefined ||
    operation.parentPackageId !== undefined ||
    operation.values !== undefined
  ) {
    return err(
      makeError(
        'pack-parameter-invalid',
        'direct create to contain assets only',
        'use pack.ts for a ScriptablePack source or create-instance for parent+values',
        { requestId: operation.requestId },
      ),
    );
  }
  const assets = operation.initialAssets ?? {};
  const parsed = parsePackSourceJson(directJson(packageId, assets));
  if (!parsed.ok) return err(parsed.error);
  if (parsed.value.format !== 'direct') {
    return err(
      makeError(
        'pack-parameter-invalid',
        'direct create to produce a direct v3 Pack document',
        'use create-instance for parent + values instead of direct assets',
        { requestId: operation.requestId },
      ),
    );
  }
  return ok(`${JSON.stringify(directJson(packageId, parsed.value.assets), null, 2)}\n`);
}

/** Validates requested parameters; undefined means a zero-parameter source. */
function scriptCreateParameters(
  packageId: PackageId,
  operation: PackAuthoringOperation,
): Result<readonly PackParameterDefinition[] | undefined, PackAuthoringError> {
  if (operation.initialAssets !== undefined && Object.keys(operation.initialAssets).length > 0) {
    return err(
      makeError(
        'pack-parameter-invalid',
        'a pack.ts source to define its outputs in build()',
        'use pack.json for direct assets or omit initialAssets when creating a pack.ts source',
        { requestId: operation.requestId },
      ),
    );
  }
  if (
    operation.parent !== undefined ||
    operation.parentPackageId !== undefined ||
    operation.values !== undefined
  ) {
    return err(
      makeError(
        'pack-parameter-invalid',
        'a new pack.ts source without instance-only parent/value fields',
        'use asset.source.instance.create for parent + values',
        { requestId: operation.requestId },
      ),
    );
  }
  if (operation.parameters === undefined) return ok(undefined);
  const validated = validatePackDefinition({
    schemaVersion: '2.0.0',
    packageId,
    parameters: operation.parameters,
    build: () => ok({}),
  });
  if (!validated.ok) return err(validated.error);
  if (!('parameters' in validated.value)) {
    return err(
      makeError(
        'pack-parameter-invalid',
        'parameters to be non-empty when supplied',
        'omit parameters for a zero-parameter Pack',
        { requestId: operation.requestId },
      ),
    );
  }
  return ok(validated.value.parameters);
}

function createdSourceFormat(
  path: ConfinedPath,
  operation: PackAuthoringOperation,
): Result<'pack.json' | 'pack.ts', PackAuthoringError> {
  const format =
    operation.format ?? (path.relative.endsWith('.pack.json') ? 'pack.json' : 'pack.ts');
  if (
    (format === 'pack.json' && !path.relative.endsWith('.pack.json')) ||
    (format === 'pack.ts' && !path.relative.endsWith('.pack.ts'))
  ) {
    return err(
      makeError(
        'pack-source-path-invalid',
        'format and target extension to agree',
        'use a .pack.ts target for source creation or a .pack.json target for direct data',
        { requestId: operation.requestId, format, targetPath: path.relative },
      ),
    );
  }
  return ok(format);
}

async function createSource(
  options: FileSystemPackAuthoringOptions,
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): Promise<OperationResult> {
  const path = confinedPath(
    options.gameRoot,
    operation.targetPath ?? operation.sourcePath,
    operation,
  );
  if (!path.ok) return path;
  const unused = await ensureNewSourceTarget(path.value, operation);
  if (!unused.ok) return unused;
  const identity = packageIdFromOperation(snapshot, operation);
  if (!identity.ok) return identity;
  const format = createdSourceFormat(path.value, operation);
  if (!format.ok) return format;
  let source: string;
  let extra: Partial<PackAuthoringOperationResult> = { format: format.value };
  if (format.value === 'pack.json') {
    const direct = directCreateSource(identity.value, operation);
    if (!direct.ok) return direct;
    source = direct.value;
  } else {
    const parameters = scriptCreateParameters(identity.value, operation);
    if (!parameters.ok) return parameters;
    source = packSourceScaffold(identity.value, parameters.value);
    const serialized =
      parameters.value === undefined ? undefined : projectPackParameters(parameters.value);
    extra = {
      format: format.value,
      ...(serialized === undefined ? {} : { parameters: serialized }),
    };
  }
  return writeAuthoringSource(operation, path.value, identity.value, source, extra);
}

/** The instance parent: an existing ScriptablePack source or instance with parameters. */
function instanceParent(
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): Result<PackageId, PackAuthoringError> {
  const parentText = operation.parentPackageId ?? operation.parent;
  if (parentText === undefined) {
    return err(
      makeError(
        'pack-parent-not-found',
        'a parent packageId for the new instance',
        'pass parentPackageId or parent and point it at a ScriptablePack source with parameters',
        { requestId: operation.requestId },
      ),
    );
  }
  const parentId = PackageId.parse(parentText);
  if (!parentId.ok) {
    return err(
      makeError(
        'pack-package-id-invalid',
        'a UUID parent packageId',
        'repair the parent package identity',
        { requestId: operation.requestId },
        parentText,
      ),
    );
  }
  const parent = snapshot.subjects.get(packageKey(parentId.value));
  if (parent === undefined) {
    return err(
      makeError(
        'pack-parent-not-found',
        'the parent packageId to exist in the current Source Index',
        'inspect the Source Index and choose a ScriptablePack parent with parameters',
        { requestId: operation.requestId, parent: parentText },
      ),
    );
  }
  if (parent.format === 'source' && !('parameters' in parent.definition)) {
    return err(
      makeError(
        'pack-parent-has-no-parameters',
        'a ScriptablePack source with a non-empty parameter list as the parent',
        'use asset.source.clone for a zero-parameter Pack',
        { requestId: operation.requestId, parent: parentText },
      ),
    );
  }
  if (parent.format === 'direct') {
    return err(
      makeError(
        'pack-parent-has-no-parameters',
        'a ScriptablePack source or instance with parameters as the parent',
        'direct Packs cannot be instance parents',
        { requestId: operation.requestId, parent: parentText },
      ),
    );
  }
  return ok(parentId.value);
}

/** Resolves a candidate instance against the snapshot and serializes its v3 source. */
async function instanceSource(
  snapshot: GatewaySnapshot,
  candidate: InstanceSubject,
): Promise<
  Result<
    { readonly source: string; readonly extra: Partial<PackAuthoringOperationResult> },
    PackAuthoringError
  >
> {
  const serializedValues = jsonValue(candidate.values) as Readonly<Record<string, unknown>>;
  const resolved = await resolveInstance(snapshot, candidate);
  if (!resolved.ok) return err(resolved.error);
  const source = `${JSON.stringify(
    {
      schemaVersion: '3.0.0',
      packageId: PackageId.format(candidate.packageId),
      parent: PackageId.format(candidate.parent),
      values: serializedValues,
    },
    null,
    2,
  )}\n`;
  return ok({
    source,
    extra: {
      format: 'instance',
      parentPackageId: PackageId.format(candidate.parent),
      values: serializedValues,
      effectiveValues: jsonValue(resolved.value.values) as Readonly<Record<string, unknown>>,
      parentChain: resolved.value.parentChain,
    },
  });
}

async function createInstance(
  options: FileSystemPackAuthoringOptions,
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): Promise<OperationResult> {
  const target = confinedPath(
    options.gameRoot,
    operation.targetPath ?? operation.sourcePath,
    operation,
  );
  if (!target.ok) return target;
  const parent = instanceParent(snapshot, operation);
  if (!parent.ok) return parent;
  const unused = await ensureNewSourceTarget(target.value, operation);
  if (!unused.ok) return unused;
  const identity = packageIdFromOperation(snapshot, operation);
  if (!identity.ok) return identity;
  const written = await instanceSource(snapshot, {
    format: 'instance',
    packageId: identity.value,
    parent: parent.value,
    values: operation.values ?? {},
    sourcePath: target.value.absolute,
    relativePath: target.value.relative,
  });
  if (!written.ok) return written;
  return writeAuthoringSource(
    operation,
    target.value,
    identity.value,
    written.value.source,
    written.value.extra,
  );
}

/** Reads the revision-checked source an in-place mutation edits. */
async function readExpectedRevision(
  options: FileSystemPackAuthoringOptions,
  operation: PackAuthoringOperation,
): Promise<Result<ConfinedSource, PackAuthoringError>> {
  const read = await readConfined(options, operation, operation.sourcePath);
  if (!read.ok) return read;
  if (
    operation.expectedRevision === undefined ||
    operation.expectedRevision !== read.value.revision
  ) {
    return err(revisionConflict(operation, read.value.relative, read.value.revision));
  }
  return read;
}

function readInstanceDocument(
  read: ConfinedSource,
  operation: PackAuthoringOperation,
): Result<{ readonly packageId: PackageId; readonly parent: PackageId }, PackAuthoringError> {
  let json: unknown;
  try {
    json = JSON.parse(read.source);
  } catch {
    return err(
      makeError(
        'pack-parameter-invalid',
        'a valid v3 instance JSON document',
        'repair the source before applying values',
        { requestId: operation.requestId, sourcePath: read.relative },
      ),
    );
  }
  const parsed = parsePackSourceJson(json);
  if (!parsed.ok) return err(parsed.error);
  if (parsed.value.format !== 'instance') {
    return err(
      makeError(
        'pack-parameter-invalid',
        'an instance pack.json subject',
        'apply-values only edits parent+values instances',
        { requestId: operation.requestId, sourcePath: read.relative },
      ),
    );
  }
  return ok({ packageId: parsed.value.packageId, parent: parsed.value.parent });
}

async function applyInstanceValues(
  options: FileSystemPackAuthoringOptions,
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): Promise<OperationResult> {
  const read = await readExpectedRevision(options, operation);
  if (!read.ok) return read;
  const document = readInstanceDocument(read.value, operation);
  if (!document.ok) return document;
  const written = await instanceSource(snapshot, {
    format: 'instance',
    packageId: document.value.packageId,
    parent: document.value.parent,
    values: operation.values ?? {},
    sourcePath: read.value.absolute,
    relativePath: read.value.relative,
  });
  if (!written.ok) return written;
  return writeAuthoringSource(
    operation,
    read.value,
    document.value.packageId,
    written.value.source,
    written.value.extra,
  );
}

async function rebuildSource(
  options: FileSystemPackAuthoringOptions,
  operation: PackAuthoringOperation,
): Promise<OperationResult> {
  const read = await readExpectedRevision(options, operation);
  if (!read.ok) return read;
  const rebuilt = await options.rebuild?.(
    read.value.relative,
    operation.operation === 'asset.source.rebuild' ? 'rebuild' : 'cold-cook',
  );
  if (rebuilt === undefined) {
    return err(
      makeError(
        'pack-source-mutation-unsupported',
        'a build-owner callback for rebuild or cold-cook',
        'connect the gateway to the project build owner before requesting a mutation',
        { requestId: operation.requestId, sourcePath: read.value.relative },
      ),
    );
  }
  if (!rebuilt.ok) return err(rebuilt.error);
  const refreshed = await readConfined(options, operation, operation.sourcePath);
  if (!refreshed.ok) return refreshed;
  const refreshedSnapshot = await createSnapshot(options, operation);
  if (!refreshedSnapshot.ok) return refreshedSnapshot;
  const selected = subjectFor(options.gameRoot, refreshedSnapshot.value, operation);
  if (!selected.ok) return selected;
  return inspectAfterWrite(
    operation,
    refreshed.value,
    refreshed.value.source,
    selected.value.packageId,
    {
      format: refreshed.value.relative.endsWith('.pack.json') ? 'pack.json' : 'pack.ts',
      assets: refreshedSnapshot.value.materialized
        .filter((asset) => asset.packageId === packageKey(selected.value.packageId))
        .map((asset) => ({ ...asset })),
    },
  );
}

async function executeRaw(
  options: FileSystemPackAuthoringOptions,
  operation: PackAuthoringOperation,
): Promise<OperationResult> {
  if (operation.operation === 'asset.inspect' && operation.parametersOnly)
    return inspectParameters(options, operation);
  if (
    operation.operation === 'asset.list' ||
    operation.operation === 'asset.inspect' ||
    operation.operation === 'asset.resolve'
  )
    return readSourceIndex(options, operation);
  const snapshot = await createSnapshot(options, operation);
  if (!snapshot.ok) return snapshot;
  if (operation.operation === 'asset.verify')
    return verify(options.gameRoot, snapshot.value, operation);
  if (operation.operation === 'asset.source.create')
    return createSource(options, snapshot.value, operation);
  if (
    operation.operation === 'asset.source.clone' ||
    operation.operation === 'asset.source.import'
  ) {
    if (options.transfer) return options.transfer(operation);
    return err(
      makeError(
        'pack-source-mutation-unsupported',
        'a project-owned source closure transfer adapter',
        'run this operation through DevKit so dependencies and compilation are validated',
        { requestId: operation.requestId, sourcePath: operation.sourcePath },
      ),
    );
  }
  if (operation.operation === 'asset.source.instance.create')
    return createInstance(options, snapshot.value, operation);
  if (operation.operation === 'asset.source.values.apply')
    return applyInstanceValues(options, snapshot.value, operation);
  if (
    operation.operation === 'asset.source.rebuild' ||
    operation.operation === 'asset.source.cold-cook'
  )
    return rebuildSource(options, operation);
  return err(
    makeError(
      'pack-parameter-invalid',
      'a supported Pack authoring operation',
      'use one of PACK_AUTHORING_OPERATION_IDS',
      { requestId: operation.requestId, operation: operation.operation },
    ),
  );
}

export function createFileSystemPackAuthoringPort(
  options: FileSystemPackAuthoringOptions,
): PackAuthoringGatewayPort<PackAuthoringOperationResult> {
  const drafts = createFileSystemPackDrafts({ gameRoot: options.gameRoot, ...options.drafts });
  return {
    dispose: () => drafts.dispose(),
    async execute(operation) {
      if (operation.operation !== 'asset.source.draft') return executeRaw(options, operation);
      if (!operation.draft)
        return err(
          makeError('pack-parameter-invalid', 'a draft request', 'supply a draft action', {}),
        );
      try {
        return ok({
          operation: operation.operation,
          requestId: operation.requestId,
          draft: await drafts.execute(operation.draft),
        });
      } catch (cause) {
        if (
          cause !== null &&
          typeof cause === 'object' &&
          'code' in cause &&
          'expected' in cause &&
          'hint' in cause
        )
          return err(cause as PackAuthoringError);
        return err(
          makeError(
            'pack-source-write-failed',
            'a successful draft source operation',
            'repair the source or filesystem error and retry',
            { reason: cause instanceof Error ? cause.message : String(cause) },
          ),
        );
      }
    },
  };
}

export function createFileSystemPackAuthoringGateway(
  options: FileSystemPackAuthoringOptions,
): PackAuthoringGatewayPort<PackAuthoringOperationResult> {
  return createPackAuthoringGateway(createFileSystemPackAuthoringPort(options));
}
