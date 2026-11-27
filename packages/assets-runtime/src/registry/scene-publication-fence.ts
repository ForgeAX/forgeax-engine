import { err, ok, type Result } from '@forgeax/engine-rhi';
import {
  type AssetPublicationEnvelope,
  assetPublicationReceiptMatches,
  type CatalogEntry,
  type ScenePublicationFence as EngineScenePublicationFence,
} from '@forgeax/engine-types';

export const SCENE_PUBLICATION_FENCE_SCHEMA = 'scene-publication-fence/1' as const;
export const SCENE_PUBLICATION_RECOVERY_ACTIONS = Object.freeze([
  'continue-last-known-good',
  'retry-rebuild',
  'fresh-reopen',
] as const);

export type ScenePublicationFence = EngineScenePublicationFence;

export type ScenePublicationFencePhase = 'publication' | 'catalog' | 'observation' | 'instantiate';

export interface ScenePublicationFenceError {
  readonly code: 'asset-generation-fence-mismatch';
  readonly phase: ScenePublicationFencePhase;
  readonly hint: string;
  readonly sourcePath?: string;
  readonly sourceRevision?: string;
  readonly expected?: ScenePublicationFence;
  readonly actual?: ScenePublicationFence;
  readonly currentGeneration?: number;
  readonly lastKnownGood?: ScenePublicationFence;
  readonly retryable: boolean;
  readonly recoveryActions: readonly string[];
}

/** Both synchronous spawning and fixed-content preparation validate the same producer edge. */
export function compareNestedScenePublication(
  parent: AssetPublicationEnvelope,
  child: AssetPublicationEnvelope,
  childGuid: string,
  address: string,
): Result<void, ScenePublicationFenceError> {
  const key = childGuid.toLowerCase();
  const evidence = parent.externalEvidence.find((item) => item.guid.toLowerCase() === key);
  const output = child.outputs.find((item) => item.guid.toLowerCase() === key);
  if (
    evidence !== undefined &&
    ((evidence.generation !== undefined && evidence.generation !== child.generation) ||
      (evidence.digest !== undefined && evidence.digest !== output?.digest))
  ) {
    return err({
      ...errorFor('instantiate', `nested SceneAsset publication changed at ${address}`, {
        publication: child,
        retryable: true,
      }),
      currentGeneration: child.generation,
    });
  }
  return ok(undefined);
}

function errorFor(
  phase: ScenePublicationFencePhase,
  hint: string,
  input: {
    readonly publication?: AssetPublicationEnvelope;
    readonly expected?: ScenePublicationFence;
    readonly actual?: ScenePublicationFence;
    readonly lastKnownGood?: ScenePublicationFence;
    readonly retryable?: boolean;
  } = {},
): ScenePublicationFenceError {
  return {
    code: 'asset-generation-fence-mismatch',
    phase,
    hint,
    ...(input.publication === undefined
      ? {}
      : {
          sourcePath: input.publication.sourcePath,
          sourceRevision: input.publication.sourceRevision,
        }),
    ...(input.expected === undefined ? {} : { expected: input.expected }),
    ...(input.actual === undefined ? {} : { actual: input.actual }),
    ...(input.actual === undefined
      ? {}
      : { currentGeneration: input.actual.publicationGeneration }),
    ...(input.lastKnownGood === undefined ? {} : { lastKnownGood: input.lastKnownGood }),
    retryable: input.retryable ?? false,
    recoveryActions: SCENE_PUBLICATION_RECOVERY_ACTIONS,
  };
}

function sameFence(left: ScenePublicationFence, right: ScenePublicationFence): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.sourcePath === right.sourcePath &&
    left.sourceRevision === right.sourceRevision &&
    left.publicationGeneration === right.publicationGeneration &&
    left.outputDigest === right.outputDigest &&
    left.outputSetDigest === right.outputSetDigest &&
    left.receiptIdentity === right.receiptIdentity
  );
}

/** Convert one complete Engine publication into the serializable Scene fence. */
export function createScenePublicationFence(
  publication: AssetPublicationEnvelope,
): Result<ScenePublicationFence, ScenePublicationFenceError> {
  if (publication.outputs.length === 0) {
    return err(
      errorFor('publication', 'publication must contain at least one output', { publication }),
    );
  }
  if (!Number.isSafeInteger(publication.generation) || publication.generation < 1) {
    return err(
      errorFor('publication', 'publication generation must be a positive integer', { publication }),
    );
  }
  const receipt = publication.receipt;
  if (!assetPublicationReceiptMatches(publication)) {
    return err(
      errorFor('publication', 'publication receipt does not match the complete output tuple', {
        publication,
      }),
    );
  }
  const outputGuids = new Set<string>();
  for (const output of publication.outputs) {
    const key = output.guid.toLowerCase();
    if (outputGuids.has(key)) {
      return err(
        errorFor('publication', 'publication output GUIDs must be unique', { publication }),
      );
    }
    outputGuids.add(key);
  }
  return ok({
    schemaVersion: SCENE_PUBLICATION_FENCE_SCHEMA,
    sourcePath: publication.sourcePath,
    sourceRevision: publication.sourceRevision,
    publicationGeneration: publication.generation,
    outputDigest: publication.digest,
    outputSetDigest: publication.outputSetDigest,
    receiptIdentity: receipt.inputFingerprint,
  });
}

/** Compare all fence fields; no single generation or GUID may stand in for it. */
export function compareScenePublicationFences(
  expected: ScenePublicationFence,
  actual: ScenePublicationFence,
  lastKnownGood?: ScenePublicationFence,
): Result<ScenePublicationFence, ScenePublicationFenceError> {
  if (sameFence(expected, actual)) return ok(actual);
  const input = {
    expected,
    actual,
    retryable: true,
    ...(lastKnownGood === undefined ? {} : { lastKnownGood }),
  };
  return err(
    errorFor('observation', 'publication fence does not match the expected complete tuple', input),
  );
}

function alignedPublications(
  entries: readonly CatalogEntry[],
  expected: ScenePublicationFence,
): boolean {
  // This cache lives for one synchronous check; it never accepts a later Catalog observation.
  const checked = new Map<AssetPublicationEnvelope, ScenePublicationFence>();
  for (const entry of entries) {
    if (entry.publication === undefined) return false;
    let fence = checked.get(entry.publication);
    if (fence === undefined) {
      const created = createScenePublicationFence(entry.publication);
      if (!created.ok) return false;
      fence = created.value;
      checked.set(entry.publication, fence);
    }
    if (!sameFence(expected, fence)) return false;
  }
  return true;
}

/** Check only the siblings declared by the accepted publication. */
export function scenePublicationFenceForRow(
  row: CatalogEntry | undefined,
  lookup: (guid: string) => CatalogEntry | undefined,
): Result<{ fence: ScenePublicationFence; entries: CatalogEntry[] }, ScenePublicationFenceError> {
  const publication = row?.publication;
  if (row === undefined || publication === undefined)
    return err(errorFor('catalog', 'Catalog row has no complete publication tuple'));
  const created = createScenePublicationFence(publication);
  if (!created.ok) return created;
  const entries: CatalogEntry[] = [];
  for (const output of publication.outputs) {
    const guid = output.guid.toLowerCase();
    const entry = row.guid.toLowerCase() === guid ? row : lookup(guid);
    if (entry?.guid.toLowerCase() === guid) entries.push(entry);
  }
  if (entries.length !== publication.outputs.length || !alignedPublications(entries, created.value))
    return err(
      errorFor('catalog', 'Catalog does not contain one complete publication tuple', {
        publication,
      }),
    );
  return ok({ fence: created.value, entries });
}

/** Derive a fence only when every Catalog row for the source publication is present and aligned. */
export function scenePublicationFenceFromCatalog(
  entries: readonly CatalogEntry[],
  outputGuid: string,
): Result<ScenePublicationFence, ScenePublicationFenceError> {
  const byGuid = new Map<string, CatalogEntry | undefined>();
  for (const entry of entries) {
    const key = entry.guid.toLowerCase();
    byGuid.set(key, byGuid.has(key) ? undefined : entry);
  }
  const checked = scenePublicationFenceForRow(byGuid.get(outputGuid.toLowerCase()), (guid) =>
    byGuid.get(guid),
  );
  return checked.ok ? ok(checked.value.fence) : checked;
}
