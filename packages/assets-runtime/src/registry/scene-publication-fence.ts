import { err, ok, type Result } from '@forgeax/engine-rhi';
import type {
  AssetPublicationEnvelope,
  CatalogEntry,
  ScenePublicationFence as EngineScenePublicationFence,
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

export interface ScenePublicationObservation {
  readonly fence: ScenePublicationFence;
  readonly outputs: readonly string[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
  if (
    receipt.schemaVersion !== 'asset-publication-receipt/1' ||
    receipt.sourcePath !== publication.sourcePath ||
    receipt.sourceRevision !== publication.sourceRevision ||
    receipt.outputDigest !== publication.digest ||
    receipt.outputSetDigest !== publication.outputSetDigest
  ) {
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

/** Parse the persisted fence without guessing legacy generation or identity. */
export function parseScenePublicationFence(
  value: unknown,
): Result<ScenePublicationFence, ScenePublicationFenceError> {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCENE_PUBLICATION_FENCE_SCHEMA ||
    typeof value.sourcePath !== 'string' ||
    typeof value.sourceRevision !== 'string' ||
    !Number.isSafeInteger(value.publicationGeneration) ||
    (value.publicationGeneration as number) < 1 ||
    typeof value.outputDigest !== 'string' ||
    typeof value.outputSetDigest !== 'string' ||
    typeof value.receiptIdentity !== 'string'
  ) {
    return err(errorFor('publication', 'publication fence shape is incomplete or invalid'));
  }
  const generation = value.publicationGeneration as number;
  return ok(
    Object.freeze({
      schemaVersion: SCENE_PUBLICATION_FENCE_SCHEMA,
      sourcePath: value.sourcePath,
      sourceRevision: value.sourceRevision,
      publicationGeneration: generation,
      outputDigest: value.outputDigest,
      outputSetDigest: value.outputSetDigest,
      receiptIdentity: value.receiptIdentity,
    }),
  );
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

/** Derive a fence only when every Catalog row for the source publication is present and aligned. */
export function scenePublicationFenceFromCatalog(
  entries: readonly CatalogEntry[],
  outputGuid: string,
): Result<ScenePublicationFence, ScenePublicationFenceError> {
  const row = entries.find((entry) => entry.guid.toLowerCase() === outputGuid.toLowerCase());
  const publication = row?.publication;
  if (publication === undefined) {
    return err(errorFor('catalog', 'Catalog row has no complete publication tuple'));
  }
  const expected = new Set(publication.outputs.map((output) => output.guid.toLowerCase()));
  const observed = entries.filter((entry) => expected.has(entry.guid.toLowerCase()));
  if (
    observed.length !== expected.size ||
    observed.some(
      (entry) =>
        entry.publication?.sourcePath !== publication.sourcePath ||
        entry.publication?.generation !== publication.generation ||
        entry.publication?.digest !== publication.digest ||
        entry.publication?.outputSetDigest !== publication.outputSetDigest,
    )
  ) {
    return err(
      errorFor('catalog', 'Catalog does not contain one complete publication tuple', {
        publication,
      }),
    );
  }
  return createScenePublicationFence(publication);
}

export async function observeScenePublication(input: {
  readonly publication: AssetPublicationEnvelope;
  readonly waitForOutput: (guid: string) => Promise<void>;
  readonly timeoutMs?: number;
  readonly lastKnownGood?: ScenePublicationFence;
}): Promise<Result<ScenePublicationObservation, ScenePublicationFenceError>> {
  const created = createScenePublicationFence(input.publication);
  if (!created.ok) return created;
  const timeoutMs = input.timeoutMs ?? 5_000;
  const wait = Promise.all(
    input.publication.outputs.map((output) => input.waitForOutput(output.guid)),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      wait,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('publication-observation-timeout')), timeoutMs);
      }),
    ]);
  } catch {
    const failureInput = {
      publication: input.publication,
      actual: created.value,
      retryable: true,
      ...(input.lastKnownGood === undefined ? {} : { lastKnownGood: input.lastKnownGood }),
    };
    return err(
      errorFor(
        'observation',
        'publication output observation did not complete before the fence deadline',
        failureInput,
      ),
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return ok({
    fence: created.value,
    outputs: input.publication.outputs.map((output) => output.guid),
  });
}
