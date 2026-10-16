import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AssetGuid as EngineAssetGuid, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import type { AssetVerificationReport } from './cli-asset.js';
import { AssetGuid, isValidAssetGuidString, isValidPackSourceKey, PackageId } from './guid.js';
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
import { declaredPackAssets, type ScanInventory, scanInventory } from './scanner.js';

export interface PackAuthoringMaterializedAsset {
  readonly packageId: string;
  readonly sourceKey: string;
  readonly guid: string;
  readonly kind: string;
  readonly sourcePath?: string;
  readonly refs?: readonly string[];
  readonly ready?: boolean;
  readonly artifactsReady?: boolean;
}

export interface FileSystemPackAuthoringOptions {
  readonly gameRoot: string;
  /** Project owner prepares the full closure, dependency lock and candidate compile. */
  readonly transfer?: (
    operation: PackAuthoringOperation,
  ) => Promise<Result<PackAuthoringOperationResult, PackAuthoringError>>;
  readonly scanRoots?: readonly string[];
  /** Current-generation rows only; this callback is never called by mutations. */
  readonly materialized?: () =>
    | readonly PackAuthoringMaterializedAsset[]
    | Promise<readonly PackAuthoringMaterializedAsset[]>;
  /**
   * GUIDs published by non-Pack producers in the same Catalog projection.
   * They are accepted as dependency identities but never exposed as Pack
   * authoring assets.
   */
  readonly additionalKnownGuids?: () => readonly string[] | Promise<readonly string[]>;
  /** Build owner callback; the gateway itself does not own DDC or Catalog state. */
  readonly rebuild?: (
    sourcePath: string,
    mode: 'rebuild' | 'cold-cook',
  ) => Promise<Result<unknown, PackAuthoringError>>;
  /** Injection point for hosts that already own a validated Source Index. */
  readonly inventory?: () => Promise<Result<ScanInventory, unknown>>;
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
  readonly directAssets: readonly DirectAuthorAsset[];
  readonly materialized: readonly MaterializedAsset[];
  readonly knownGuids: ReadonlySet<string>;
}

const VERIFY_PROVENANCE_LIMIT = 256;

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

function revisionOf(source: string): string {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`;
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

async function atomicWrite(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, source, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw cause;
  }
}

function packageKey(packageId: PackageId): string {
  return PackageId.format(packageId).toLowerCase();
}

function parsePackageId(value: unknown): PackageId | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = PackageId.parse(value);
  return parsed.ok ? parsed.value : undefined;
}

function projectParameters(
  parameters: readonly PackParameterDefinition[],
): readonly Readonly<Record<string, unknown>>[] {
  return parameters.map((parameter) => ({
    name: parameter.name,
    type: parameter.type,
    default: jsonValue(parameter.default),
    ...(parameter.minimum === undefined ? {} : { minimum: parameter.minimum }),
    ...(parameter.maximum === undefined ? {} : { maximum: parameter.maximum }),
    ...(parameter.values === undefined ? {} : { values: parameter.values }),
    ...(parameter.kind === undefined ? {} : { kind: parameter.kind }),
  }));
}

function serializedParameters(
  definition: AnyScriptablePackDefinition,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  return 'parameters' in definition ? projectParameters(definition.parameters) : undefined;
}

function sourceResult(
  subject: Subject,
  operation: PackAuthoringOperation,
): PackAuthoringOperationResult {
  const base = {
    operation: operation.operation,
    requestId: operation.requestId,
    sourcePath: subject.relativePath,
    packageId: PackageId.format(subject.packageId),
    format: subject.format === 'source' ? 'pack.ts' : subject.format,
  } as const;
  if (subject.format === 'source') {
    const parameters = serializedParameters(subject.definition);
    return {
      ...base,
      ...(parameters === undefined ? {} : { parameters }),
      ...(parameters === undefined
        ? {}
        : {
            capabilities: [
              'asset.source.instance.create',
              'asset.source.rebuild',
              'asset.source.cold-cook',
            ],
          }),
    };
  }
  if (subject.format === 'instance') {
    return {
      ...base,
      parentPackageId: PackageId.format(subject.parent),
      values: jsonValue(subject.values) as Readonly<Record<string, unknown>>,
    };
  }
  return {
    ...base,
    assets: subject.assets.map((asset) => ({
      sourceKey: asset.sourceKey,
      guid: asset.guid,
      kind: asset.kind,
      ...(asset.name === undefined ? {} : { name: asset.name }),
      refs: asset.refs,
    })),
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
    reason === 'pack-parent-has-no-parameters'
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
    { requestId: operation.requestId, cause: value.detail ?? String(cause) },
  );
}

function scanRoots(options: FileSystemPackAuthoringOptions): readonly string[] {
  return options.scanRoots === undefined || options.scanRoots.length === 0
    ? [resolve(options.gameRoot)]
    : options.scanRoots.map((root) => resolve(options.gameRoot, root));
}

async function readMaterialized(
  options: FileSystemPackAuthoringOptions,
  operation: PackAuthoringOperation,
): Promise<Result<readonly MaterializedAsset[], PackAuthoringError>> {
  let rawRows: unknown;
  try {
    rawRows = (await options.materialized?.()) ?? [];
  } catch (cause) {
    return err(
      makeError(
        'pack-parameter-invalid',
        'the materialized projection callback to return current-generation rows',
        'repair the build-owner projection callback, then retry the Pack operation',
        {
          requestId: operation.requestId,
          cause: cause instanceof Error ? cause.message : String(cause),
        },
      ),
    );
  }
  if (!Array.isArray(rawRows)) {
    return err(
      makeError(
        'pack-parameter-invalid',
        'the materialized projection callback to return an array',
        'repair the build-owner projection callback, then retry the Pack operation',
        { requestId: operation.requestId, actual: typeof rawRows },
      ),
    );
  }
  const materialized: MaterializedAsset[] = [];
  const pairOwners = new Map<string, string>();
  const guidOwners = new Map<string, string>();
  for (const rawRow of rawRows) {
    if (!isRecord(rawRow)) {
      return err(
        makeError(
          'pack-parameter-invalid',
          'materialized rows to be objects',
          'repair the current generation projection before querying Pack authoring',
          { requestId: operation.requestId, actual: typeof rawRow },
        ),
      );
    }
    const row = rawRow as unknown as PackAuthoringMaterializedAsset;
    const parsedPackageId = parsePackageId(row.packageId);
    if (parsedPackageId === undefined) {
      return err(
        makeError(
          'pack-package-id-invalid',
          'materialized rows to contain a valid UUID packageId',
          'repair the current generation projection before querying Pack authoring',
          { requestId: operation.requestId, packageId: row.packageId, sourceKey: row.sourceKey },
        ),
      );
    }
    if (!isValidPackSourceKey(row.sourceKey)) {
      return err(
        makeError(
          'pack-source-key-invalid',
          'materialized rows to contain a valid sourceKey',
          'repair the current generation projection before querying Pack authoring',
          { requestId: operation.requestId, packageId: row.packageId, sourceKey: row.sourceKey },
        ),
      );
    }
    if (
      typeof row.guid !== 'string' ||
      !isValidAssetGuidString(row.guid) ||
      typeof row.kind !== 'string' ||
      row.kind.length === 0
    ) {
      return err(
        makeError(
          'pack-parameter-invalid',
          'materialized rows to contain a valid GUID and non-empty kind',
          'repair the current generation projection before querying Pack authoring',
          { requestId: operation.requestId, packageId: row.packageId, sourceKey: row.sourceKey },
        ),
      );
    }
    if (
      row.refs !== undefined &&
      (!Array.isArray(row.refs) ||
        row.refs.some((ref) => typeof ref !== 'string' || !isValidAssetGuidString(ref)))
    ) {
      return err(
        makeError(
          'pack-parameter-invalid',
          'materialized refs to contain UUID AssetGuid strings when present',
          'repair the current generation projection before querying Pack authoring',
          { requestId: operation.requestId, packageId: row.packageId, sourceKey: row.sourceKey },
        ),
      );
    }
    if (row.sourcePath !== undefined && typeof row.sourcePath !== 'string') {
      return err(
        makeError(
          'pack-parameter-invalid',
          'materialized sourcePath to be a string when present',
          'repair the current generation projection before querying Pack authoring',
          { requestId: operation.requestId, sourcePath: row.sourcePath },
        ),
      );
    }
    const packageId = PackageId.format(parsedPackageId).toLowerCase();
    const expectedGuid = AssetGuid.format(
      AssetGuid.derive(parsedPackageId, row.sourceKey),
    ).toLowerCase();
    const guid = row.guid.toLowerCase();
    if (guid !== expectedGuid) {
      return err(
        makeError(
          'pack-guid-collision',
          'materialized GUID to equal UUIDv5(packageId, sourceKey)',
          'rebuild the current generation from the stable packageId and sourceKey pair',
          {
            requestId: operation.requestId,
            packageId,
            sourceKey: row.sourceKey,
            expectedGuid,
            observedGuid: row.guid,
          },
        ),
      );
    }
    const pair = `${packageId}/${row.sourceKey}`;
    const pairOwner = pairOwners.get(pair);
    if (pairOwner !== undefined) {
      return err(
        makeError(
          'pack-guid-collision',
          'one materialized row per packageId/sourceKey pair',
          'remove the stale duplicate row from the current generation projection',
          { requestId: operation.requestId, pair, paths: [pairOwner, row.sourcePath] },
        ),
      );
    }
    pairOwners.set(pair, row.sourcePath ?? pair);
    const guidOwner = guidOwners.get(guid);
    if (guidOwner !== undefined) {
      return err(
        makeError(
          'pack-guid-collision',
          'one materialized owner per derived AssetGuid',
          'repair the current generation projection so each derived GUID has one owner',
          { requestId: operation.requestId, guid, paths: [guidOwner, row.sourcePath] },
        ),
      );
    }
    guidOwners.set(guid, row.sourcePath ?? pair);
    materialized.push({
      packageId,
      sourceKey: row.sourceKey,
      guid,
      kind: row.kind,
      ...(row.sourcePath === undefined ? {} : { sourcePath: row.sourcePath }),
      ...(row.refs === undefined ? {} : { refs: Object.freeze([...row.refs]) }),
      ready: row.ready === true && row.artifactsReady !== false,
    });
  }
  materialized.sort((left, right) =>
    `${left.packageId}/${left.sourceKey}`.localeCompare(`${right.packageId}/${right.sourceKey}`),
  );
  return ok(materialized);
}

async function readAdditionalKnownGuids(
  options: FileSystemPackAuthoringOptions,
  operation: PackAuthoringOperation,
): Promise<Result<readonly string[], PackAuthoringError>> {
  let rawGuids: unknown;
  try {
    rawGuids = (await options.additionalKnownGuids?.()) ?? [];
  } catch (cause) {
    return err(
      makeError(
        'pack-parameter-invalid',
        'the additionalKnownGuids callback to return current Catalog GUIDs',
        'repair the build-owner Catalog projection callback, then retry the Pack operation',
        {
          requestId: operation.requestId,
          cause: cause instanceof Error ? cause.message : String(cause),
        },
      ),
    );
  }
  if (!Array.isArray(rawGuids)) {
    return err(
      makeError(
        'pack-parameter-invalid',
        'additionalKnownGuids to be an array of AssetGuid strings',
        'repair the build-owner Catalog projection before querying Pack authoring',
        { requestId: operation.requestId, actual: typeof rawGuids },
      ),
    );
  }
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of rawGuids) {
    if (typeof candidate !== 'string' || !isValidAssetGuidString(candidate)) {
      return err(
        makeError(
          'pack-parameter-invalid',
          'additionalKnownGuids to contain valid AssetGuid strings',
          'repair the build-owner Catalog projection before querying Pack authoring',
          { requestId: operation.requestId, guid: candidate },
        ),
      );
    }
    const guid = candidate.toLowerCase();
    if (!seen.has(guid)) {
      seen.add(guid);
      guids.push(guid);
    }
  }
  return ok(guids);
}

async function createSnapshot(
  options: FileSystemPackAuthoringOptions,
  operation: PackAuthoringOperation,
): Promise<Result<GatewaySnapshot, PackAuthoringError>> {
  const sourceFailures = new Map<string, PackAuthoringError>();
  const partialRead = ['asset.list', 'asset.inspect', 'asset.resolve'].includes(
    operation.operation,
  );
  const scanned =
    options.inventory === undefined
      ? await scanInventory(
          scanRoots(options),
          partialRead
            ? {
                onSourceFailure: (sourcePath, error) =>
                  sourceFailures.set(sourcePath, scanFailure(operation, error)),
              }
            : {},
        )
      : await options.inventory();
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
    if (declaration.format !== 'pack.json' || declaration.value.schemaVersion !== '3.0.0') continue;
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
      subjects.set(packageKey(parsed.packageId), {
        format: 'instance',
        packageId: parsed.packageId,
        parent: parsed.parent,
        values: parsed.values,
        sourcePath,
        relativePath,
      });
    }
  }
  const materializedResult = await readMaterialized(options, operation);
  if (!materializedResult.ok) return materializedResult;
  const additionalKnownGuidsResult = await readAdditionalKnownGuids(options, operation);
  if (!additionalKnownGuidsResult.ok) return additionalKnownGuidsResult;
  const materialized = materializedResult.value;
  const guidOwners = new Map<string, string>();
  const directPairs = new Set<string>();
  for (const entry of scanned.value.inventory) {
    const declaration = scanned.value.declarations.get(entry.sourcePath);
    // scanInventory already projects v3 direct entries below; keep that
    // source-local projection from colliding with its gateway subject copy.
    if (declaration?.format === 'pack.json' && declaration.value.schemaVersion === '3.0.0') {
      continue;
    }
    guidOwners.set(entry.guid.toLowerCase(), entry.sourcePath);
  }
  for (const asset of directAssets) {
    directPairs.add(`${asset.packageId}/${asset.sourceKey}`);
    const existing = guidOwners.get(asset.guid);
    if (existing !== undefined) {
      return err(
        makeError(
          'pack-guid-collision',
          'one current-generation owner per AssetGuid',
          'repair the direct Pack or external source projection before querying Pack authoring',
          {
            requestId: operation.requestId,
            guid: asset.guid,
            paths: [existing, asset.sourcePath],
          },
        ),
      );
    }
    guidOwners.set(asset.guid, asset.sourcePath ?? asset.packageId);
  }
  for (const asset of materialized) {
    const existing = guidOwners.get(asset.guid);
    const pair = `${asset.packageId}/${asset.sourceKey}`;
    // A published row for a direct author asset is the expected current
    // generation. It shares the source identity; only a different owner is a
    // collision.
    if (existing !== undefined && !directPairs.has(pair)) {
      return err(
        makeError(
          'pack-guid-collision',
          'one current-generation owner per AssetGuid',
          'remove the stale materialized row or repair the direct/source owner before querying Pack authoring',
          {
            requestId: operation.requestId,
            guid: asset.guid,
            paths: [existing, asset.sourcePath],
          },
        ),
      );
    }
    guidOwners.set(asset.guid, asset.sourcePath ?? asset.packageId);
  }
  const knownGuids = new Set<string>([
    ...scanned.value.inventory.map((entry) => entry.guid.toLowerCase()),
    ...directAssets.map((asset) => asset.guid),
    ...materialized.map((asset) => asset.guid),
    ...additionalKnownGuidsResult.value,
  ]);
  return ok({
    inventory: scanned.value,
    sourceFailures,
    subjects,
    directAssets,
    materialized,
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
  if (subject.format === 'instance') {
    return {
      format: 'instance',
      packageId: subject.packageId,
      parent: subject.parent,
      values: subject.values,
    };
  }
  return { format: 'direct', packageId: subject.packageId };
}

async function resolveInstance(
  snapshot: GatewaySnapshot,
  subject: InstanceSubject,
): Promise<Result<ResolvedPackParameterInheritance, PackAuthoringError>> {
  return resolvePackParameterInheritance(
    {
      format: 'instance',
      packageId: subject.packageId,
      parent: subject.parent,
      values: subject.values,
    },
    async (packageId) => parentSubject(snapshot, packageId),
  );
}

function subjectFor(
  gameRoot: string,
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): Result<Subject, PackAuthoringError> {
  if (operation.sourcePath !== undefined) {
    const confined = confinedPath(gameRoot, operation.sourcePath, operation);
    if (!confined.ok) return confined;
    const expected = confined.value.relative;
    const source = [...snapshot.subjects.values()].find(
      (candidate) => candidate.relativePath === expected,
    );
    if (source !== undefined) {
      const requestedPackageId =
        operation.packageId === undefined ? undefined : PackageId.parse(operation.packageId);
      if (requestedPackageId?.ok === false) {
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
      if (
        requestedPackageId?.ok === true &&
        packageKey(requestedPackageId.value) !== packageKey(source.packageId)
      ) {
        return err(
          makeError(
            'pack-parameter-invalid',
            'sourcePath and packageId to identify the same Pack subject',
            'remove the conflicting locator or use the packageId returned by asset.list',
            {
              requestId: operation.requestId,
              sourcePath: expected,
              packageId: operation.packageId,
              observedPackageId: PackageId.format(source.packageId),
            },
          ),
        );
      }
      return ok(source);
    }
    return err(
      pathError(
        'pack-source-not-found',
        operation,
        'sourcePath to identify a current Pack subject',
        'inspect the current Source Index and choose an existing source path',
        { sourcePath: expected },
        expected,
      ),
    );
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
    const asset = [...snapshot.directAssets, ...snapshot.materialized].find(
      (candidate) => candidate.guid === guid,
    );
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
      const materialized = snapshot.materialized.find(
        (candidate) =>
          candidate.packageId === packageKey(subject.packageId) &&
          candidate.sourceKey === operation.sourceKey,
      );
      return ok({
        ...inspectedSource,
        sourceKey: asset.sourceKey,
        guid: asset.guid,
        kind: asset.kind,
        payload: jsonValue(asset.payload) as Readonly<Record<string, unknown>>,
        status:
          materialized === undefined
            ? ('identity' as const)
            : materialized.ready
              ? 'ready'
              : 'present',
      });
    }
    try {
      const guid = AssetGuid.format(AssetGuid.derive(subject.packageId, operation.sourceKey));
      const materialized = [...snapshot.materialized].find(
        (candidate) =>
          candidate.packageId === packageKey(subject.packageId) &&
          candidate.sourceKey === operation.sourceKey,
      );
      const resolvedInstance =
        subject.format === 'instance' ? await resolveInstance(snapshot, subject) : undefined;
      if (resolvedInstance !== undefined && !resolvedInstance.ok) return resolvedInstance;
      return ok({
        ...inspectedSource,
        sourceKey: operation.sourceKey,
        guid,
        ...(resolvedInstance?.ok
          ? {
              parameters: projectParameters(resolvedInstance.value.parameters),
              effectiveValues: jsonValue(resolvedInstance.value.values) as Readonly<
                Record<string, unknown>
              >,
              parentChain: resolvedInstance.value.parentChain,
            }
          : {}),
        ...(materialized === undefined
          ? { status: 'identity' as const }
          : {
              status: materialized.ready ? ('ready' as const) : ('present' as const),
              kind: materialized.kind,
            }),
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
    const resolved = await resolveInstance(snapshot, subject);
    if (!resolved.ok) return resolved;
    return ok({
      ...inspectedSource,
      parameters: projectParameters(resolved.value.parameters),
      effectiveValues: jsonValue(resolved.value.values) as Readonly<Record<string, unknown>>,
      parentChain: resolved.value.parentChain,
    });
  }
  return ok(inspectedSource);
}

function listAssets(
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): PackAuthoringOperationResult {
  const assets = snapshotAssets(snapshot)
    .map((asset) => ({
      packageId: asset.packageId,
      sourceKey: asset.sourceKey,
      guid: asset.guid,
      kind: asset.kind,
      ...(asset.name === undefined ? {} : { name: asset.name }),
      ...(asset.sourcePath === undefined ? {} : { sourcePath: asset.sourcePath }),
      status: !('ready' in asset)
        ? ('identity' as const)
        : asset.ready
          ? ('ready' as const)
          : ('present' as const),
    }))
    .sort((left, right) =>
      `${left.packageId}/${left.sourceKey}`.localeCompare(`${right.packageId}/${right.sourceKey}`),
    );
  const sources = [...snapshot.subjects.values()]
    .map((subject) => {
      if (subject.format === 'source') {
        const parameters = serializedParameters(subject.definition);
        return {
          packageId: PackageId.format(subject.packageId),
          sourcePath: subject.relativePath,
          format: 'pack.ts' as const,
          ...(parameters === undefined ? {} : { parameters }),
        };
      }
      if (subject.format === 'instance') {
        return {
          packageId: PackageId.format(subject.packageId),
          sourcePath: subject.relativePath,
          format: 'instance' as const,
          parentPackageId: PackageId.format(subject.parent),
          values: jsonValue(subject.values) as Readonly<Record<string, unknown>>,
        };
      }
      return {
        packageId: PackageId.format(subject.packageId),
        sourcePath: subject.relativePath,
        format: 'direct' as const,
      };
    })
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

function snapshotAssets(
  snapshot: GatewaySnapshot,
): readonly (DirectAuthorAsset | MaterializedAsset)[] {
  const assets = new Map<string, DirectAuthorAsset | MaterializedAsset>();
  for (const asset of snapshot.directAssets) {
    assets.set(`${asset.packageId}/${asset.sourceKey}`, asset);
  }
  for (const asset of snapshot.materialized) {
    assets.set(`${asset.packageId}/${asset.sourceKey}`, asset);
  }
  return [...assets.values()];
}

function assetForPair(
  snapshot: GatewaySnapshot,
  packageId: PackageId,
  sourceKey: string,
): DirectAuthorAsset | MaterializedAsset | undefined {
  const key = `${packageKey(packageId)}/${sourceKey}`;
  return snapshotAssets(snapshot).find((asset) => `${asset.packageId}/${asset.sourceKey}` === key);
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
    const found = [...snapshot.directAssets, ...snapshot.materialized].find(
      (asset) => asset.guid === operation.subject?.toLowerCase(),
    );
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
  let sourceLocator: string | undefined;
  if (sourceLocatorCandidate !== undefined) {
    const confined = confinedPath(gameRoot, sourceLocatorCandidate, operation);
    if (!confined.ok) return confined;
    sourceLocator = confined.value.relative;
  }
  if (sourceLocator !== undefined) {
    const source = [...snapshot.subjects.values()].find(
      (candidate) => candidate.relativePath === sourceLocator,
    );
    if (source === undefined) {
      return err(
        pathError(
          'pack-source-not-found',
          operation,
          'sourcePath to identify a current Pack subject',
          'inspect the current Source Index and choose an existing source path',
          { sourcePath: sourceLocator },
          sourceLocator,
        ),
      );
    }
    if (packageId !== undefined && packageKey(packageId) !== packageKey(source.packageId)) {
      return err(
        makeError(
          'pack-parameter-invalid',
          'sourcePath and packageId to identify the same Pack subject',
          'remove the conflicting locator or use the packageId returned by asset.list',
          {
            requestId: operation.requestId,
            sourcePath: sourceLocator,
            packageId: PackageId.format(packageId),
            observedPackageId: PackageId.format(source.packageId),
          },
        ),
      );
    }
    packageId ??= source.packageId;
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
  const asset = assetForPair(snapshot, packageId, sourceKey);
  const materialized = snapshot.materialized.find(
    (candidate) =>
      candidate.packageId === packageKey(packageId) && candidate.sourceKey === sourceKey,
  );
  const requirement: PackAuthoringResolutionStatus = operation.require ?? 'identity';
  if (requirement === 'present' && materialized === undefined) {
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
  if (requirement === 'ready' && (materialized === undefined || !materialized.ready)) {
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
    status: materialized === undefined ? 'identity' : materialized.ready ? 'ready' : 'present',
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

function verificationAuthorFacts(
  snapshot: GatewaySnapshot,
  entry: GatewaySnapshot['inventory']['inventory'][number],
): { readonly name?: string; readonly dependencies: readonly string[] } {
  const declaration = snapshot.inventory.declarations.get(entry.sourcePath);
  if (declaration?.format === 'meta.json') {
    const asset = declaration.value.subAssets.find(
      (candidate) => candidate.guid.toLowerCase() === entry.guid.toLowerCase(),
    );
    return {
      ...(asset?.name === undefined && asset?.sourceKey === undefined
        ? {}
        : { name: asset.name ?? asset.sourceKey }),
      dependencies: [],
    };
  }
  if (declaration?.format === 'pack.json') {
    const asset = declaredPackAssets(declaration.value).find(
      (candidate) => candidate.guid.toLowerCase() === entry.guid.toLowerCase(),
    );
    return {
      ...(asset?.name === undefined ? {} : { name: asset.name }),
      dependencies: asset?.refs ?? [],
    };
  }
  return { dependencies: [] };
}

function verificationOutput(
  materialized: MaterializedAsset | undefined,
  legacyPublished = false,
): VerificationAsset['output'] {
  if (materialized !== undefined) {
    return {
      status: materialized.ready ? 'produced' : 'unknown',
      availability: materialized.ready ? 'available' : 'unknown',
      freshness: 'unknown',
    };
  }
  if (legacyPublished) {
    return {
      status: 'produced',
      availability: 'unknown',
      freshness: 'unknown',
      // A legacy Pack row is a validated published declaration. The bytes
      // remain outside this read-only gateway, so availability is unknown.
    };
  }
  return { status: 'unproduced', availability: 'unknown', freshness: 'unknown' };
}

function createGatewayVerificationReport(
  gameRoot: string,
  snapshot: GatewaySnapshot,
): AssetVerificationReport & Pick<PackAuthoringOperationResult, 'operation' | 'requestId'> {
  const materializedByGuid = new Map(
    snapshot.materialized.map((asset) => [asset.guid.toLowerCase(), asset] as const),
  );
  const rows = new Map<string, VerificationAsset>();
  for (const entry of snapshot.inventory.inventory) {
    const declaration = snapshot.inventory.declarations.get(entry.sourcePath);
    const format = declaration?.format ?? verificationSourceFormat(gameRoot, entry.sourcePath);
    const facts = verificationAuthorFacts(snapshot, entry);
    const materialized = materializedByGuid.get(entry.guid.toLowerCase());
    const legacyPublished =
      declaration?.format === 'pack.json' && declaration.value.schemaVersion !== '3.0.0';
    rows.set(entry.guid.toLowerCase(), {
      guid: entry.guid,
      type: entry.kind,
      source: {
        path: entry.sourcePath,
        format,
        role: 'author',
        ...(entry.sourceRevision === undefined ? {} : { revision: entry.sourceRevision }),
      },
      output: verificationOutput(materialized, legacyPublished),
      dependencies: facts.dependencies,
      producer: {
        state: materialized !== undefined ? 'published' : legacyPublished ? 'published' : 'not-run',
      },
      ...(facts.name === undefined ? {} : { name: facts.name }),
      ...(entry.sourceKey === undefined ? {} : { sourceKey: entry.sourceKey }),
      ...(entry.sourceIndex === undefined ? {} : { sourceIndex: entry.sourceIndex }),
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
  const emitted = assets.slice(0, VERIFY_PROVENANCE_LIMIT);
  const sourcePaths = [...snapshot.inventory.declarations.keys()].sort();
  const scriptablePackSources = [...snapshot.inventory.declarations.values()]
    .filter((declaration) => declaration.format === 'pack.ts')
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const unmaterializedScriptable = scriptablePackSources.filter(
    (source) =>
      !snapshot.materialized.some(
        (asset) =>
          asset.packageId === source.value.packageId.toLowerCase() ||
          (asset.sourcePath !== undefined &&
            resolve(gameRoot, asset.sourcePath) === source.sourcePath),
      ),
  );
  return {
    schemaVersion: 'asset-verification-v1',
    root: resolve(gameRoot),
    operation: 'asset.verify',
    requestId: 'gateway',
    scope: {
      sourceCount: sourcePaths.length,
      assetCount: assets.length,
      sourcePaths: sourcePaths.slice(0, VERIFY_PROVENANCE_LIMIT),
      omittedSourceCount: Math.max(0, sourcePaths.length - VERIFY_PROVENANCE_LIMIT),
      assetLimit: VERIFY_PROVENANCE_LIMIT,
      truncated: assets.length > VERIFY_PROVENANCE_LIMIT,
      scriptablePackSourceCount: scriptablePackSources.length,
      scriptablePackSources: unmaterializedScriptable
        .slice(0, VERIFY_PROVENANCE_LIMIT)
        .map((source) => ({
          sourcePath: source.sourcePath,
          packageId: source.value.packageId,
          output: 'unproduced' as const,
          reason: 'producer-not-run' as const,
        })),
      omittedScriptablePackSourceCount: Math.max(
        0,
        unmaterializedScriptable.length - VERIFY_PROVENANCE_LIMIT,
      ),
    },
    assets: emitted,
    summary: {
      assetCount: assets.length,
      emittedAssetCount: emitted.length,
      materialCount: assets.filter((asset) => asset.type === 'material').length,
      unproducedAssetCount: assets.filter((asset) => asset.output.status === 'unproduced').length,
      unknownAssetCount: assets.filter((asset) => asset.output.status === 'unknown').length,
      unmaterializedScriptablePackCount: unmaterializedScriptable.length,
    },
  };
}

async function verify(
  gameRoot: string,
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): Promise<Result<PackAuthoringOperationResult, PackAuthoringError>> {
  for (const subject of snapshot.subjects.values()) {
    if (subject.format === 'instance') {
      const resolved = await resolveInstance(snapshot, subject);
      if (!resolved.ok) return err(resolved.error);
    }
    if (subject.format === 'direct') {
      for (const asset of subject.assets) {
        const missing = asset.refs.find((ref) => !snapshot.knownGuids.has(ref.toLowerCase()));
        if (missing !== undefined) {
          return err(
            makeError(
              'pack-output-reference-missing',
              'every direct Pack ref to resolve to a known AssetGuid',
              'repair the payload ref or add the owning external asset before verifying',
              {
                requestId: operation.requestId,
                packageId: PackageId.format(subject.packageId),
                sourceKey: asset.sourceKey,
                guid: missing,
              },
            ),
          );
        }
      }
    }
  }
  for (const asset of snapshotAssets(snapshot)) {
    const missing = asset.refs?.find((ref) => !snapshot.knownGuids.has(ref.toLowerCase()));
    if (missing !== undefined) {
      return err(
        makeError(
          'pack-output-reference-missing',
          'every materialized Pack ref to resolve to a known AssetGuid',
          'repair the published output reference or publish its owning asset before verifying',
          {
            requestId: operation.requestId,
            packageId: asset.packageId,
            sourceKey: asset.sourceKey,
            guid: missing,
          },
        ),
      );
    }
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
    return ok({ ...path.value, source, revision: revisionOf(source) });
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
    revision: revisionOf(source),
    ...extra,
  });
}

async function executeRaw(
  options: FileSystemPackAuthoringOptions,
  operation: PackAuthoringOperation,
): Promise<Result<PackAuthoringOperationResult, PackAuthoringError>> {
  if (
    operation.operation === 'asset.list' ||
    operation.operation === 'asset.inspect' ||
    operation.operation === 'asset.resolve'
  ) {
    const snapshot = await createSnapshot(options, operation);
    if (!snapshot.ok) return snapshot;
    const selected = operation.sourcePath ?? operation.subject;
    const sourceFailure =
      typeof selected === 'string'
        ? snapshot.value.sourceFailures.get(resolve(options.gameRoot, selected))
        : undefined;
    if (sourceFailure) return err(sourceFailure);
    if (operation.operation === 'asset.resolve')
      return resolveAsset(options.gameRoot, snapshot.value, operation);
    return operation.operation === 'asset.list'
      ? ok(listAssets(snapshot.value, operation))
      : await inspectAsset(options.gameRoot, snapshot.value, operation);
  }
  const snapshot = await createSnapshot(options, operation);
  if (!snapshot.ok) return snapshot;
  if (operation.operation === 'asset.verify')
    return verify(options.gameRoot, snapshot.value, operation);

  if (operation.operation === 'asset.source.create') {
    const path = confinedPath(
      options.gameRoot,
      operation.targetPath ?? operation.sourcePath,
      operation,
    );
    if (!path.ok) return path;
    try {
      await stat(path.value.absolute);
      return err(
        pathError(
          'pack-source-revision-conflict',
          operation,
          'an unused target source path',
          'inspect the existing source or choose another target path',
          { targetPath: path.value.relative },
          path.value.relative,
        ),
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        return err(
          pathError(
            'pack-source-write-failed',
            operation,
            'the target path to be available for atomic creation',
            'repair the filesystem and retry',
            { targetPath: path.value.relative, cause: String(cause) },
          ),
        );
      }
    }
    const identity = packageIdFromOperation(snapshot.value, operation);
    if (!identity.ok) return identity;
    const format =
      operation.format ?? (path.value.relative.endsWith('.pack.json') ? 'pack.json' : 'pack.ts');
    if (
      (format === 'pack.json' && !path.value.relative.endsWith('.pack.json')) ||
      (format === 'pack.ts' && !path.value.relative.endsWith('.pack.ts'))
    ) {
      return err(
        makeError(
          'pack-source-path-invalid',
          'format and target extension to agree',
          'use a .pack.ts target for source creation or a .pack.json target for direct data',
          { requestId: operation.requestId, format, targetPath: path.value.relative },
        ),
      );
    }
    let source: string;
    let extra: Partial<PackAuthoringOperationResult> = { format };
    if (format === 'pack.json') {
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
      const parsed = parsePackSourceJson(directJson(identity.value, assets));
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
      source = `${JSON.stringify(directJson(identity.value, parsed.value.assets), null, 2)}\n`;
    } else {
      if (
        operation.initialAssets !== undefined &&
        Object.keys(operation.initialAssets).length > 0
      ) {
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
      let parameters: readonly PackParameterDefinition[] | undefined;
      if (operation.parameters !== undefined) {
        const validated = validatePackDefinition({
          schemaVersion: '2.0.0',
          packageId: identity.value,
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
        parameters = validated.value.parameters;
      }
      source = packSourceScaffold(identity.value, parameters);
      const serialized =
        parameters === undefined
          ? undefined
          : serializedParameters({
              schemaVersion: '2.0.0',
              packageId: identity.value,
              parameters,
              build: () => ok({}),
            } as AnyScriptablePackDefinition);
      extra = {
        format,
        ...(serialized === undefined ? {} : { parameters: serialized }),
      };
    }
    try {
      await atomicWrite(path.value.absolute, source);
    } catch (cause) {
      return err(
        pathError(
          'pack-source-write-failed',
          operation,
          'the new Pack source to be written atomically',
          'repair filesystem permissions or disk capacity, then retry with a new requestId',
          {
            targetPath: path.value.relative,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        ),
      );
    }
    return inspectAfterWrite(operation, path.value, source, identity.value, extra);
  }

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

  if (operation.operation === 'asset.source.instance.create') {
    const target = confinedPath(
      options.gameRoot,
      operation.targetPath ?? operation.sourcePath,
      operation,
    );
    if (!target.ok) return target;
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
    const parent = snapshot.value.subjects.get(packageKey(parentId.value));
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
    try {
      await stat(target.value.absolute);
      return err(
        pathError(
          'pack-source-revision-conflict',
          operation,
          'an unused instance target path',
          'inspect the existing instance or choose another path',
          { targetPath: target.value.relative },
          target.value.relative,
        ),
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        return err(
          pathError(
            'pack-source-write-failed',
            operation,
            'the instance target to be writable',
            'repair filesystem permissions and retry',
            { targetPath: target.value.relative, cause: String(cause) },
          ),
        );
      }
    }
    const identity = packageIdFromOperation(snapshot.value, operation);
    if (!identity.ok) return identity;
    const values = operation.values ?? {};
    const serializedValues = jsonValue(values) as Readonly<Record<string, unknown>>;
    const candidate: InstanceSubject = {
      format: 'instance',
      packageId: identity.value,
      parent: parentId.value,
      values,
      sourcePath: target.value.absolute,
      relativePath: target.value.relative,
    };
    const withCandidate: GatewaySnapshot = {
      ...snapshot.value,
      subjects: new Map([...snapshot.value.subjects, [packageKey(identity.value), candidate]]),
    };
    const resolved = await resolveInstance(withCandidate, candidate);
    if (!resolved.ok) return err(resolved.error);
    const source = `${JSON.stringify(
      {
        schemaVersion: '3.0.0',
        packageId: PackageId.format(identity.value),
        parent: PackageId.format(parentId.value),
        values: serializedValues,
      },
      null,
      2,
    )}\n`;
    try {
      await atomicWrite(target.value.absolute, source);
    } catch (cause) {
      return err(
        pathError(
          'pack-source-write-failed',
          operation,
          'the new instance to be written atomically',
          'repair filesystem permissions or disk capacity, then retry',
          {
            targetPath: target.value.relative,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        ),
      );
    }
    return inspectAfterWrite(operation, target.value, source, identity.value, {
      format: 'instance',
      parentPackageId: PackageId.format(parentId.value),
      values: serializedValues,
      effectiveValues: jsonValue(resolved.value.values) as Readonly<Record<string, unknown>>,
      parentChain: resolved.value.parentChain,
    });
  }

  if (operation.operation === 'asset.source.values.apply') {
    const read = await readConfined(options, operation, operation.sourcePath);
    if (!read.ok) return read;
    if (
      operation.expectedRevision === undefined ||
      operation.expectedRevision !== read.value.revision
    ) {
      return err(revisionConflict(operation, read.value.relative, read.value.revision));
    }
    let json: unknown;
    try {
      json = JSON.parse(read.value.source);
    } catch {
      return err(
        makeError(
          'pack-parameter-invalid',
          'a valid v3 instance JSON document',
          'repair the source before applying values',
          { requestId: operation.requestId, sourcePath: read.value.relative },
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
          { requestId: operation.requestId, sourcePath: read.value.relative },
        ),
      );
    }
    const values = operation.values ?? {};
    const serializedValues = jsonValue(values) as Readonly<Record<string, unknown>>;
    const candidate: InstanceSubject = {
      format: 'instance',
      packageId: parsed.value.packageId,
      parent: parsed.value.parent,
      values,
      sourcePath: read.value.absolute,
      relativePath: read.value.relative,
    };
    const withCandidate: GatewaySnapshot = {
      ...snapshot.value,
      subjects: new Map([...snapshot.value.subjects, [packageKey(candidate.packageId), candidate]]),
    };
    const resolved = await resolveInstance(withCandidate, candidate);
    if (!resolved.ok) return err(resolved.error);
    const source = `${JSON.stringify(
      {
        schemaVersion: '3.0.0',
        packageId: PackageId.format(parsed.value.packageId),
        parent: PackageId.format(parsed.value.parent),
        values: serializedValues,
      },
      null,
      2,
    )}\n`;
    try {
      await atomicWrite(read.value.absolute, source);
    } catch (cause) {
      return err(
        pathError(
          'pack-source-write-failed',
          operation,
          'the updated instance to be written atomically',
          'repair filesystem permissions or disk capacity, then retry with a new requestId',
          {
            sourcePath: read.value.relative,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        ),
      );
    }
    return inspectAfterWrite(operation, read.value, source, parsed.value.packageId, {
      format: 'instance',
      parentPackageId: PackageId.format(parsed.value.parent),
      values: serializedValues,
      effectiveValues: jsonValue(resolved.value.values) as Readonly<Record<string, unknown>>,
      parentChain: resolved.value.parentChain,
    });
  }

  if (
    operation.operation === 'asset.source.rebuild' ||
    operation.operation === 'asset.source.cold-cook'
  ) {
    const read = await readConfined(options, operation, operation.sourcePath);
    if (!read.ok) return read;
    if (
      operation.expectedRevision === undefined ||
      operation.expectedRevision !== read.value.revision
    ) {
      return err(revisionConflict(operation, read.value.relative, read.value.revision));
    }
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
  return { execute: (operation) => executeRaw(options, operation) };
}

export function createFileSystemPackAuthoringGateway(
  options: FileSystemPackAuthoringOptions,
): PackAuthoringGatewayPort<PackAuthoringOperationResult> {
  return createPackAuthoringGateway(createFileSystemPackAuthoringPort(options));
}
