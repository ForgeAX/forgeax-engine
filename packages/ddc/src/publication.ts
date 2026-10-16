import { createHash } from 'node:crypto';
import type {
  AssetPublicationEnvelope,
  AssetPublicationExternalEvidence,
  AssetPublicationFailure,
  AssetPublicationLocator,
  AssetPublicationOutput,
  AssetPublicationRecovery,
  Result,
} from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';

export interface ScriptablePackPublicationSnapshot {
  readonly current?: AssetPublicationEnvelope;
  readonly lastKnownGood?: AssetPublicationEnvelope;
  readonly failure?: AssetPublicationFailure;
}

export interface ScriptablePackPublicationError extends AssetPublicationFailure {
  readonly recovery: AssetPublicationRecovery;
  readonly current?: AssetPublicationLocator;
  readonly lastKnownGood?: AssetPublicationLocator;
}

export interface AcceptedPublicationCandidate {
  readonly envelope: AssetPublicationEnvelope;
  readonly cancelled?: boolean;
}

export interface ScriptablePackPublicationBuildInput {
  readonly sourcePath: string;
  readonly sourceRevision: string;
  /** Optional caller generation; the DDC owner derives one when omitted. */
  readonly generation?: number;
  readonly digest: string;
  readonly packageUrl: string;
  readonly inputFingerprint: string;
  readonly outputs: readonly AssetPublicationOutput[];
  readonly externalEvidence: readonly AssetPublicationExternalEvidence[];
}

/**
 * DDC-owned publication authority for source keyed producers.  Transport
 * adapters may stage bytes, but they do not retain current/LKG or generation
 * state themselves.
 */
export interface AcceptedPublicationStore {
  observe(sourcePath: string): ScriptablePackPublicationSnapshot;
  stage(
    sourcePath: string,
    candidate: AcceptedPublicationCandidate,
  ): Result<void, ScriptablePackPublicationError>;
  commit(
    sourcePath: string,
    candidate: AcceptedPublicationCandidate,
    commitRoute: () => Promise<void> | void,
  ): Promise<Result<ScriptablePackPublicationSnapshot, ScriptablePackPublicationError>>;
  discard(sourcePath: string, candidate: AssetPublicationEnvelope): void;
  restore(sourcePath: string, snapshot: ScriptablePackPublicationSnapshot): void;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;
}

export function scriptablePackOutputSetDigest(outputs: readonly AssetPublicationOutput[]): string {
  return digest(
    outputs.map((output) => ({
      guid: output.guid.toLowerCase(),
      sourceKey: output.sourceKey,
      kind: output.kind,
      digest: output.digest,
      refs: [...output.refs].map((guid) => guid.toLowerCase()),
    })),
  );
}

/** Derive a stable positive generation from the accepted publication tuple. */
export function scriptablePackPublicationGeneration(input: {
  readonly sourceRevision: string;
  readonly digest: string;
  readonly outputSetDigest: string;
}): number {
  const hash = createHash('sha256')
    .update(input.sourceRevision)
    .update('\n')
    .update(input.digest)
    .update('\n')
    .update(input.outputSetDigest)
    .digest('hex');
  const generation = Number.parseInt(hash.slice(0, 8), 16);
  return generation > 0 ? generation : 1;
}

/** Build the complete producer-owned tuple after the package route is finalized. */
export function createAcceptedPublication(
  input: ScriptablePackPublicationBuildInput,
): AssetPublicationEnvelope {
  const outputSetDigest = scriptablePackOutputSetDigest(input.outputs);
  const publicationGeneration =
    input.generation ??
    scriptablePackPublicationGeneration({
      sourceRevision: input.sourceRevision,
      digest: input.digest,
      outputSetDigest,
    });
  return {
    schemaVersion: 'asset-publication/1',
    sourcePath: input.sourcePath,
    sourceRevision: input.sourceRevision,
    generation: publicationGeneration,
    digest: input.digest,
    outputSetDigest,
    outputs: input.outputs,
    receipt: {
      schemaVersion: 'asset-publication-receipt/1',
      sourcePath: input.sourcePath,
      sourceRevision: input.sourceRevision,
      inputFingerprint: input.inputFingerprint,
      outputDigest: input.digest,
      outputSetDigest,
      externalEvidence: input.externalEvidence,
    },
    externalEvidence: input.externalEvidence,
    current: {
      generation: publicationGeneration,
      digest: input.digest,
      outputSetDigest,
      packageUrl: input.packageUrl,
      receiptKey: input.inputFingerprint,
    },
  };
}

function locatorFor(envelope: AssetPublicationEnvelope): AssetPublicationLocator {
  return {
    generation: envelope.generation,
    digest: envelope.digest,
    outputSetDigest: envelope.outputSetDigest,
    packageUrl: envelope.current?.packageUrl ?? '',
    receiptKey: envelope.receipt.inputFingerprint,
  };
}

function recoveryFor(retryable: boolean, useLastKnownGood: boolean): AssetPublicationRecovery {
  return {
    retryable,
    preserveCurrent: true,
    useLastKnownGood,
    actions: retryable
      ? ['inspect-publication-failure', 'retry-rebuild', 'continue-last-known-good']
      : ['inspect-publication-failure', 'edit-source', 'continue-last-known-good'],
  };
}

function failure(
  envelope: AssetPublicationEnvelope,
  code: string,
  stage: AssetPublicationFailure['stage'],
  reason: string,
  retryable: boolean,
  current: AssetPublicationEnvelope | undefined,
  lastKnownGood: AssetPublicationEnvelope | undefined,
): ScriptablePackPublicationError {
  return {
    code,
    stage,
    sourcePath: envelope.sourcePath,
    sourceRevision: envelope.sourceRevision,
    generation: envelope.generation,
    reason,
    recovery: recoveryFor(retryable, lastKnownGood !== undefined),
    ...(current === undefined ? {} : { current: locatorFor(current) }),
    ...(lastKnownGood === undefined ? {} : { lastKnownGood: locatorFor(lastKnownGood) }),
  };
}

function validateOutputs(
  envelope: AssetPublicationEnvelope,
  current: AssetPublicationEnvelope | undefined,
  lastKnownGood: AssetPublicationEnvelope | undefined,
): ScriptablePackPublicationError | undefined {
  const guids = new Set<string>();
  const sourceKeys = new Set<string>();
  for (const output of envelope.outputs) {
    const guid = output.guid.toLowerCase();
    if (guids.has(guid) || sourceKeys.has(output.sourceKey)) {
      return failure(
        envelope,
        'asset-publication-output-duplicate',
        'output',
        'publication output GUIDs and sourceKeys must be unique',
        false,
        current,
        lastKnownGood,
      );
    }
    guids.add(guid);
    sourceKeys.add(output.sourceKey);
  }
  if (
    envelope.outputs.length === 0 ||
    scriptablePackOutputSetDigest(envelope.outputs) !== envelope.outputSetDigest
  ) {
    return failure(
      envelope,
      'asset-publication-output-set-mismatch',
      'receipt',
      'receipt outputSetDigest does not match the complete output tuple',
      false,
      current,
      lastKnownGood,
    );
  }
  return undefined;
}

function validateReceipt(
  envelope: AssetPublicationEnvelope,
  current: AssetPublicationEnvelope | undefined,
  lastKnownGood: AssetPublicationEnvelope | undefined,
): ScriptablePackPublicationError | undefined {
  const receipt = envelope.receipt;
  if (
    receipt.schemaVersion !== 'asset-publication-receipt/1' ||
    receipt.sourcePath !== envelope.sourcePath ||
    receipt.sourceRevision !== envelope.sourceRevision ||
    receipt.outputSetDigest !== envelope.outputSetDigest ||
    receipt.outputDigest !== envelope.digest ||
    stable(receipt.externalEvidence) !== stable(envelope.externalEvidence)
  ) {
    return failure(
      envelope,
      'asset-publication-receipt-mismatch',
      'receipt',
      'publication receipt does not match the candidate output tuple',
      false,
      current,
      lastKnownGood,
    );
  }
  return undefined;
}

function validateEnvelope(
  envelope: AssetPublicationEnvelope,
  current: AssetPublicationEnvelope | undefined,
  lastKnownGood: AssetPublicationEnvelope | undefined,
): ScriptablePackPublicationError | undefined {
  if (envelope.schemaVersion !== 'asset-publication/1') {
    return failure(
      envelope,
      'asset-publication-schema-invalid',
      'receipt',
      'publication envelope schemaVersion is not supported',
      false,
      current,
      lastKnownGood,
    );
  }
  if (!Number.isSafeInteger(envelope.generation) || envelope.generation < 1) {
    return failure(
      envelope,
      'asset-publication-generation-invalid',
      'receipt',
      'publication generation must be a positive integer',
      false,
      current,
      lastKnownGood,
    );
  }
  const outputError = validateOutputs(envelope, current, lastKnownGood);
  if (outputError !== undefined) return outputError;
  const receiptError = validateReceipt(envelope, current, lastKnownGood);
  if (receiptError !== undefined) return receiptError;
  // Re-running a deterministic producer (for example a cold cook after a
  // rebuild) can yield the exact same publication tuple.  That is an
  // idempotent request, not a late result: rejecting it here makes the
  // editor's retry/cold-cook operation fail even though the published asset is
  // already the requested content.  A same-generation tuple with any changed
  // source/digest/output-set fact remains stale and is rejected below.
  const sameTuple =
    current !== undefined &&
    envelope.generation === current.generation &&
    envelope.sourcePath === current.sourcePath &&
    envelope.sourceRevision === current.sourceRevision &&
    envelope.digest === current.digest &&
    envelope.outputSetDigest === current.outputSetDigest;
  if (sameTuple) return undefined;
  if (current !== undefined && envelope.generation <= current.generation) {
    return failure(
      envelope,
      'asset-publication-stale',
      'cancelled',
      `candidate generation ${envelope.generation} is not newer than current ${current.generation}`,
      true,
      current,
      lastKnownGood,
    );
  }
  return undefined;
}

interface PublicationState {
  snapshot: ScriptablePackPublicationSnapshot;
  /**
   * Staged candidates are owned by their envelope object, not by the
   * publication tuple. Two overlapping generations can legitimately produce
   * the same deterministic tuple; a stale owner's discard must not remove the
   * current owner's candidate before commit.
   */
  readonly staged: Set<AssetPublicationEnvelope>;
}

function validateCandidate(
  state: PublicationState,
  candidate: AcceptedPublicationCandidate,
  cancelledReason: string,
): ScriptablePackPublicationError | undefined {
  const current = state.snapshot.current;
  const lastKnownGood = state.snapshot.lastKnownGood ?? current;
  if (candidate.cancelled === true) {
    return failure(
      candidate.envelope,
      'asset-publication-cancelled',
      'cancelled',
      cancelledReason,
      true,
      current,
      lastKnownGood,
    );
  }
  return validateEnvelope(candidate.envelope, current, lastKnownGood);
}

async function publishCandidate(
  state: PublicationState,
  candidate: AcceptedPublicationCandidate,
  commitRoute: () => Promise<void> | void,
): Promise<Result<ScriptablePackPublicationSnapshot, ScriptablePackPublicationError>> {
  const current = state.snapshot.current;
  const lastKnownGood = state.snapshot.lastKnownGood ?? current;
  const invalid = validateCandidate(
    state,
    candidate,
    'publication request was cancelled before route commit',
  );
  if (invalid !== undefined) {
    state.snapshot = { ...state.snapshot, failure: invalid };
    return err(invalid);
  }
  try {
    await commitRoute();
  } catch (error) {
    const failed = failure(
      candidate.envelope,
      'asset-publication-route-failed',
      'route',
      error instanceof Error ? error.message : String(error),
      true,
      current,
      lastKnownGood,
    );
    state.snapshot = { ...state.snapshot, failure: failed };
    return err(failed);
  }
  const published = {
    ...candidate.envelope,
    current: locatorFor(candidate.envelope),
    ...(current === undefined ? {} : { lastKnownGood: locatorFor(current) }),
    recovery: recoveryFor(false, current !== undefined),
  };
  state.snapshot = {
    current: published,
    ...(current === undefined ? {} : { lastKnownGood: current }),
  };
  return ok(state.snapshot);
}

/** Create the one DDC publication authority shared by dev attempts. */
export function createAcceptedPublicationStore(): AcceptedPublicationStore {
  const states = new Map<string, PublicationState>();
  function stateFor(sourcePath: string): PublicationState {
    const existing = states.get(sourcePath);
    if (existing !== undefined) return existing;
    const created: PublicationState = { snapshot: {}, staged: new Set() };
    states.set(sourcePath, created);
    return created;
  }
  return {
    observe(sourcePath) {
      return stateFor(sourcePath).snapshot;
    },
    stage(sourcePath, candidate) {
      const invalid = validateCandidate(
        stateFor(sourcePath),
        candidate,
        'publication request was cancelled before DDC commit',
      );
      if (invalid !== undefined) return err(invalid);
      stateFor(sourcePath).staged.add(candidate.envelope);
      return ok(undefined);
    },
    async commit(sourcePath, candidate, commitRoute) {
      const state = stateFor(sourcePath);
      if (!state.staged.has(candidate.envelope)) {
        const current = state.snapshot.current;
        const lastKnownGood = state.snapshot.lastKnownGood ?? current;
        return err(
          failure(
            candidate.envelope,
            'asset-publication-cancelled',
            'cancelled',
            'publication candidate was discarded before DDC commit',
            true,
            current,
            lastKnownGood,
          ),
        );
      }
      const result = await publishCandidate(state, candidate, commitRoute);
      state.staged.delete(candidate.envelope);
      return result;
    },
    discard(sourcePath, candidate) {
      stateFor(sourcePath).staged.delete(candidate);
    },
    restore(sourcePath, snapshot) {
      const state = stateFor(sourcePath);
      state.staged.clear();
      state.snapshot = snapshot;
    },
  };
}
