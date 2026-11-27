import { createHash } from 'node:crypto';
import {
  type DdcArtifact,
  type DdcEntry,
  type DdcEntryInput,
  DdcEntryStore,
  type DdcHead,
  DdcLifecycle,
  type DdcPublicationAttempt,
  DdcStoreError,
  ddcOutputDigest,
} from '@forgeax/engine-ddc';
import { canonicalDdcJson } from '@forgeax/engine-ddc/key';
import {
  bindRuntimePackScope,
  stripRuntimePackLifecycle,
  visitPackArtifactDescriptors,
} from '@forgeax/engine-pack/build';
import { decodeMaterialProgramWire } from '@forgeax/engine-pack/runtime';
import {
  type CatalogEntry,
  err,
  ok,
  type ResourceRevision,
  type Result,
  type RuntimeAssetBinding,
} from '@forgeax/engine-types';
import {
  type SourcePackageError,
  type SourcePackageErrorContext,
  sourcePackageError,
} from './source-package-errors.js';

interface SourcePackageDdcEntryInput {
  readonly root: string;
  readonly entry: DdcEntryInput;
  readonly context: SourcePackageErrorContext;
}

interface StagedSourcePackageDdc extends DdcPublicationAttempt {
  readonly root: string;
  readonly context: SourcePackageErrorContext;
}

interface ImmutablePackSelection {
  readonly payload: unknown;
  readonly publicationGeneration?: number;
}

export interface ImportPublicationInput {
  /** Tool-owned opt-in; publication never reads ambient environment configuration. */
  readonly traceTiming?: boolean;
  readonly root: string;
  readonly guid: string;
  readonly desiredKey: string;
  readonly pack: unknown;
  readonly previousCatalog: readonly CatalogEntry[];
  readonly nextCatalog: readonly CatalogEntry[];
  readonly publishedGuids: readonly string[];
  /** Complete package-relative artifact closure for the published Pack. */
  readonly artifacts?: readonly ImportPublicationArtifact[];
}

export interface ImportPublicationArtifact {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface ImportPublicationError {
  readonly code: SourcePackageError['code'];
  readonly expected: string;
  readonly hint: string;
  readonly detail: string;
  readonly diagnostic: SourcePackageError;
}

export type ImportPublicationResult =
  | {
      readonly ok: true;
      readonly key: string;
      readonly head: DdcHead;
      readonly catalog: readonly CatalogEntry[];
      readonly revision: ResourceRevision;
    }
  | { readonly ok: false; readonly error: ImportPublicationError; readonly head: DdcHead };

/** A validated current projection; restoring it never writes a DDC head. */
export interface ImportPublicationSnapshot {
  readonly key: string;
  readonly head: DdcHead;
  readonly catalog: readonly CatalogEntry[];
  readonly revision: ResourceRevision;
  readonly pack: unknown;
  readonly artifacts: Readonly<Record<string, DdcArtifact>>;
}

export interface StagedImportPublication {
  readonly input: ImportPublicationInput;
  readonly ddc: StagedSourcePackageDdc;
  readonly key: string;
  readonly head: DdcHead;
  readonly catalog: readonly CatalogEntry[];
  readonly revision: ResourceRevision;
}

export type StagedImportPublicationResult =
  | { readonly ok: true; readonly candidate: StagedImportPublication }
  | { readonly ok: false; readonly error: ImportPublicationError; readonly head: DdcHead };

function publicationTiming(stage: string, started: number | undefined): void {
  if (started === undefined) return;
  try {
    process.stderr.write(
      `[forgeax.meta-publication.timing] ${JSON.stringify({ stage, elapsedMs: performance.now() - started })}\n`,
    );
  } catch {
    // Optional diagnostics do not change publication outcomes.
  }
}

function inspectHead(root: string, guid: string, desiredKey: string): Promise<DdcHead> {
  return new DdcLifecycle(root).inspect(guid, desiredKey);
}

const PUBLICATION_SETTLE_TIMEOUT_MS = 5_000;
const PUBLICATION_SETTLE_POLL_MS = 10;

async function inspectAfterSupersededCommit(candidate: StagedSourcePackageDdc): Promise<DdcHead> {
  let head = await inspectHead(candidate.root, candidate.lease.guid, candidate.lease.desiredKey);
  if (head.state === 'current' && head.currentKey === candidate.lease.desiredKey) return head;

  // A newer owner may already have superseded this lease while it is still
  // cooking.  The strict DDC CAS correctly returns `stale` to this candidate;
  // wait for that owner to publish before turning an equivalent publication
  // into a user-visible import failure.  The wait is bounded so a crashed
  // owner never leaves the caller hanging and a different desired key still
  // fails closed.
  const deadline = Date.now() + PUBLICATION_SETTLE_TIMEOUT_MS;
  while (
    Date.now() < deadline &&
    head.activeLease !== undefined &&
    head.activeLease.attempt !== candidate.lease.attempt &&
    head.activeLease.desiredKey === candidate.lease.desiredKey
  ) {
    await new Promise((resolve) => setTimeout(resolve, PUBLICATION_SETTLE_POLL_MS));
    head = await inspectHead(candidate.root, candidate.lease.guid, candidate.lease.desiredKey);
    if (head.state === 'current' && head.currentKey === candidate.lease.desiredKey) return head;
  }
  return head;
}

async function stageSourcePackageDdc(
  input: SourcePackageDdcEntryInput,
): Promise<Result<StagedSourcePackageDdc, SourcePackageError>> {
  try {
    const candidate = await new DdcLifecycle(input.root).stagePublication(input.entry);
    return ok(Object.assign(candidate, { root: input.root, context: input.context }));
  } catch (error) {
    return err(sourcePackageDdcFailure(input.context, error));
  }
}

function sourcePackageDdcFailure(
  context: SourcePackageErrorContext,
  error: unknown,
): SourcePackageError {
  return sourcePackageError('source-package-ddc-failed', context, {
    stage: 'ddc',
    reason: error instanceof Error ? error.message : String(error),
    ...(error instanceof DdcStoreError ? { ddcError: error.toBrowserProjection() } : {}),
  });
}

/**
 * DDC identity is semantic Pack content. Fresh entries keep the publication
 * generation in receipt metadata; an existing matching entry reuses its exact
 * body so a generation change remains an idempotent cache hit.
 */
async function immutablePackPayload(
  input: ImportPublicationInput,
): Promise<ImmutablePackSelection> {
  const semantic = stripRuntimePackLifecycle(input.pack);
  const existing = await new DdcEntryStore(input.root).readPayloadCandidate(input.desiredKey);
  if (
    existing !== null &&
    existing.guid.toLowerCase() === input.guid.toLowerCase() &&
    canonicalDdcJson(stripRuntimePackLifecycle(existing.payload)) === canonicalDdcJson(semantic)
  ) {
    return {
      payload: existing.payload,
      ...(existing.receipt.publicationGeneration === undefined
        ? {}
        : { publicationGeneration: existing.receipt.publicationGeneration }),
    };
  }
  const generation = input.pack as { readonly generation?: unknown } | null;
  const value = generation?.generation;
  const publicationGeneration =
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    !Array.isArray(input.pack)
      ? value
      : undefined;
  return {
    payload: semantic,
    ...(publicationGeneration === undefined ? {} : { publicationGeneration }),
  };
}

async function commitSourcePackageDdc(
  candidate: StagedSourcePackageDdc,
): Promise<Result<DdcHead, SourcePackageError>> {
  try {
    const commit = await candidate.commit();
    if (commit.result !== 'current') {
      const head = await inspectAfterSupersededCommit(candidate);
      if (head.state === 'current' && head.currentKey === candidate.lease.desiredKey) {
        return ok(head);
      }
      return err(
        sourcePackageError('source-package-ddc-failed', candidate.context, {
          stage: 'ddc',
          reason: `DDC lifecycle commit returned ${commit.result}`,
          ddcCommitResult: commit.result,
        }),
      );
    }
    return ok(commit.head);
  } catch (error) {
    return err(sourcePackageDdcFailure(candidate.context, error));
  }
}

function importPublicationFailure(error: SourcePackageError): ImportPublicationError {
  return {
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    detail: error.detail.reason ?? error.detail.stage,
    diagnostic: error,
  };
}

function publicationContext(input: ImportPublicationInput): SourcePackageErrorContext {
  return {
    sourceMeta: '<import-publication>',
    anchorGuid: input.guid,
    affectedGuids: input.publishedGuids,
    producer: 'source-package/import-publication',
    importer: 'import-publication',
  };
}

/**
 * Validate the Pack-to-transport closure before DDC staging can advance its
 * head. The Pack is the authority for required artifact paths; a missing or
 * mismatched body must never become a published `current` generation.
 */
function validatePublicationArtifactClosure(
  input: ImportPublicationInput,
): Result<Readonly<Record<string, DdcArtifact>>, SourcePackageError> {
  const context = publicationContext(input);
  const invalid = (reason: string) =>
    err(
      sourcePackageError('source-package-publication-invalid', context, {
        stage: 'route-integrity',
        reason,
      }),
    );
  const decoded = decodeMaterialProgramWire(input.pack);
  if (!decoded.ok) return invalid('invalid material program table');
  const pack = decoded.value;
  const available: Record<string, DdcArtifact> = Object.create(null);
  const mismatched: string[] = [];
  for (const { path, mediaType, bytes } of input.artifacts ?? []) {
    if (Object.hasOwn(available, path)) mismatched.push(`${path}: duplicate body`);
    available[path] = { mediaType, bytes };
  }
  if (
    pack === null ||
    typeof pack !== 'object' ||
    (pack as { readonly schemaVersion?: unknown }).schemaVersion !== '2.0.0' ||
    (pack as { readonly kind?: unknown }).kind !== 'internal-text-package'
  ) {
    return ok(available);
  }
  const manifest = importArtifactManifest(pack);
  if (!manifest.ok) return invalid(manifest.error);
  const required = manifest.value;
  const missing: string[] = [];
  for (const path of Object.keys(available)) {
    if (!required.has(path)) mismatched.push(`${path}: unexpected body`);
  }
  for (const [path, descriptor] of required) {
    const artifact = available[path];
    if (artifact === undefined) {
      missing.push(path);
      continue;
    }
    if (!(artifact.bytes instanceof Uint8Array)) {
      mismatched.push(`${path}: body is not Uint8Array`);
      continue;
    }
    if (descriptor.mediaType !== undefined && artifact.mediaType !== descriptor.mediaType) {
      mismatched.push(`${path}: media type mismatch`);
    }
    if (
      descriptor.byteLength !== undefined &&
      artifact.bytes.byteLength !== descriptor.byteLength
    ) {
      mismatched.push(`${path}: byte length mismatch`);
    }
    if (descriptor.integrity !== undefined) {
      const actualDigest = `sha256:${createHash('sha256').update(artifact.bytes).digest('hex')}`;
      if (
        descriptor.integrity.algorithm !== 'sha256' ||
        descriptor.integrity.digest !== actualDigest
      ) {
        mismatched.push(`${path}: integrity mismatch`);
      }
    }
  }
  if (missing.length > 0 || mismatched.length > 0) {
    return err(
      sourcePackageError('source-package-publication-invalid', context, {
        stage: 'route-integrity',
        reason: 'Pack artifact closure is incomplete or mismatched',
        ...(missing.length === 0 ? {} : { missing }),
        ...(mismatched.length === 0 ? {} : { unexpected: mismatched }),
      }),
    );
  }

  return ok(available);
}

function projectImportPublication(
  input: ImportPublicationInput,
  head: DdcHead,
  observedAt: number,
): { readonly catalog: readonly CatalogEntry[]; readonly revision: ResourceRevision } {
  const digest = head.currentKey ?? input.desiredKey;
  const revision: ResourceRevision = { digest, observedAt, rootId: input.root };
  const published = new Set(input.publishedGuids.map((guid) => guid.toLowerCase()));
  const catalog = input.nextCatalog.map((row) => {
    if (!published.has(row.guid.toLowerCase())) return row;
    const previousLkg =
      head.lastKnownGoodKey === undefined
        ? undefined
        : input.previousCatalog.find(
            (candidate) =>
              candidate.guid.toLowerCase() === row.guid.toLowerCase() &&
              candidate.revision?.digest === head.lastKnownGoodKey,
          );
    const projection =
      row.projection === undefined
        ? undefined
        : (() => {
            const { lastKnownGood: _staleLastKnownGood, ...withoutLastKnownGood } = row.projection;
            return previousLkg?.packageUrl === undefined
              ? withoutLastKnownGood
              : { ...withoutLastKnownGood, lastKnownGood: { packageUrl: previousLkg.packageUrl } };
          })();
    return {
      ...row,
      revision,
      ...(projection === undefined ? {} : { projection }),
    };
  });
  return { catalog, revision };
}

/**
 * Adopt an equivalent current entry through the existing DDC integrity/head fence.
 * Callers serve the returned validated Pack rebound to the requested runtime scope.
 * A miss, damaged entry, changed output or active writer retains normal publication.
 */
const IMPORT_PUBLICATION_PRODUCER = 'engine-import/source-package-publication';

async function readCurrentImportEntry(root: string, guid: string, expectedKey?: string) {
  const current = await new DdcLifecycle(root).readCurrentEntry(guid).catch(() => undefined);
  if (!current || current.head.state !== 'current' || current.entry === null) return undefined;
  const { head, entry } = current;
  if (
    (expectedKey !== undefined && head.currentKey !== expectedKey) ||
    entry.key !== head.currentKey ||
    entry.guid !== guid ||
    entry.receipt.producer !== IMPORT_PUBLICATION_PRODUCER ||
    entry.receipt.inputFingerprint !== entry.key
  )
    return undefined;
  return { head, entry };
}

function importArtifactManifest(pack: unknown, requireMaps = false) {
  type Descriptor = {
    readonly mediaType?: string;
    readonly byteLength?: number;
    readonly integrity?: { readonly algorithm: string; readonly digest: string };
  };
  const required = new Map<string, Descriptor>();
  const error = visitPackArtifactDescriptors(
    pack,
    (descriptor) => {
      const { path, mediaType, byteLength, integrity } = descriptor;
      const sha =
        integrity !== null && typeof integrity === 'object'
          ? (integrity as Record<string, unknown>)
          : undefined;
      if (
        (mediaType !== undefined && typeof mediaType !== 'string') ||
        (byteLength !== undefined &&
          (typeof byteLength !== 'number' ||
            !Number.isSafeInteger(byteLength) ||
            byteLength < 0)) ||
        (integrity !== undefined &&
          (typeof sha?.algorithm !== 'string' || typeof sha.digest !== 'string'))
      )
        return `artifact descriptor ${path} has invalid metadata`;
      if (required.has(path)) return `artifact path ${path} is declared more than once`;
      required.set(path, descriptor as Descriptor);
      return undefined;
    },
    requireMaps,
  );
  return error === undefined ? ok(required) : err(error);
}

export function importPackArtifactPaths(pack: unknown): readonly string[] | undefined {
  const decoded = decodeMaterialProgramWire(pack);
  if (!decoded.ok) return undefined;
  const manifest = importArtifactManifest(decoded.value, true);
  return manifest.ok ? [...manifest.value.keys()] : undefined;
}

/** Read the accepted Meta transport for a newly opened runtime scope. */
export async function readImportPack(
  root: string,
  guid: string,
  binding: Pick<RuntimeAssetBinding, 'scopeId' | 'generation'>,
  publication?: { readonly generation: number; readonly receiptKey?: string },
): Promise<
  | {
      readonly pack: unknown;
      readonly artifacts: DdcEntry['artifacts'];
      readonly artifactPaths: readonly string[];
    }
  | undefined
> {
  const current = await readCurrentImportEntry(root, guid, publication?.receiptKey);
  if (!current) return undefined;
  const { payload, receipt, artifacts } = current.entry;
  const legacy = (payload as { readonly generation?: unknown } | null)?.generation;
  const generation =
    publication?.generation ??
    receipt.publicationGeneration ??
    (typeof legacy === 'number' ? legacy : binding.generation);
  let artifactPaths: string[] | undefined;
  const pack = bindRuntimePackScope(payload, binding.scopeId, generation, (decoded) => {
    const manifest = importArtifactManifest(decoded, true);
    if (!manifest.ok) return false;
    const paths = [...manifest.value.keys()];
    if (!paths.every((path) => Object.hasOwn(artifacts, path))) return false;
    artifactPaths = paths;
    return true;
  });
  return artifactPaths === undefined ? undefined : { pack, artifacts, artifactPaths };
}

export async function readImportPublication(
  input: ImportPublicationInput,
): Promise<ImportPublicationSnapshot | undefined> {
  const artifacts = validatePublicationArtifactClosure(input);
  if (!artifacts.ok) return undefined;
  const payload = stripRuntimePackLifecycle(input.pack);
  const outputDigest = ddcOutputDigest({
    guid: input.guid,
    payload,
    refs: [],
    artifacts: artifacts.value,
  });
  const runtime = input.pack as {
    readonly scopeId?: unknown;
    readonly generation?: unknown;
  } | null;
  const scopeId = runtime?.scopeId;
  const generation = runtime?.generation;
  const current = await readCurrentImportEntry(input.root, input.guid, input.desiredKey);
  if (
    !current ||
    current.head.activeLease !== undefined ||
    current.entry.receipt.outputDigest !== outputDigest
  )
    return undefined;
  const projected = projectImportPublication(input, current.head, Date.now());
  const pack =
    typeof scopeId === 'string' && typeof generation === 'number'
      ? bindRuntimePackScope(current.entry.payload, scopeId, generation)
      : current.entry.payload;
  return {
    key: input.desiredKey,
    head: current.head,
    ...projected,
    pack,
    artifacts: current.entry.artifacts,
  };
}

async function failedImportPublication(
  input: ImportPublicationInput,
  error: SourcePackageError,
): Promise<Extract<ImportPublicationResult, { ok: false }>> {
  return {
    ok: false,
    error: importPublicationFailure(error),
    head: await inspectHead(input.root, input.guid, input.desiredKey),
  };
}

export async function stageImportPublication(
  input: ImportPublicationInput,
): Promise<StagedImportPublicationResult> {
  const timing = input.traceTiming === true;
  let started = timing ? performance.now() : undefined;
  const validatedArtifacts = validatePublicationArtifactClosure(input);
  publicationTiming('artifact-closure', started);
  if (!validatedArtifacts.ok) return failedImportPublication(input, validatedArtifacts.error);
  const artifacts = validatedArtifacts.value;
  started = timing ? performance.now() : undefined;
  const selected = await immutablePackPayload(input);
  publicationTiming('immutable-payload', started);
  const { payload } = selected;
  started = timing ? performance.now() : undefined;
  const staged = await stageSourcePackageDdc({
    root: input.root,
    entry: {
      key: input.desiredKey,
      guid: input.guid,
      payload,
      refs: [],
      artifacts,
      receipt: {
        guid: input.guid,
        key: input.desiredKey,
        producer: IMPORT_PUBLICATION_PRODUCER,
        inputFingerprint: input.desiredKey,
        ...(selected.publicationGeneration === undefined
          ? {}
          : { publicationGeneration: selected.publicationGeneration }),
      },
    },
    context: publicationContext(input),
  });
  publicationTiming('ddc-stage', started);
  if (!staged.ok) return failedImportPublication(input, staged.error);
  const lastKnownGoodKey =
    staged.value.previousHead.currentKey !== undefined &&
    staged.value.previousHead.currentKey !== input.desiredKey
      ? staged.value.previousHead.currentKey
      : staged.value.previousHead.lastKnownGoodKey;
  const projectedHead: DdcHead = {
    ...staged.value.previousHead,
    state: 'cooking',
    currentKey: input.desiredKey,
    ...(lastKnownGoodKey === undefined ? {} : { lastKnownGoodKey }),
  };
  const projected = projectImportPublication(input, projectedHead, Date.now());
  return {
    ok: true,
    candidate: {
      input,
      ddc: staged.value,
      key: input.desiredKey,
      head: projectedHead,
      catalog: projected.catalog,
      revision: projected.revision,
    },
  };
}

export async function commitImportPublication(
  candidate: StagedImportPublication,
): Promise<ImportPublicationResult> {
  const publication = await commitSourcePackageDdc(candidate.ddc);
  if (!publication.ok) return failedImportPublication(candidate.input, publication.error);
  const projected = projectImportPublication(candidate.input, publication.value, Date.now());
  return {
    ok: true,
    key: candidate.input.desiredKey,
    head: publication.value,
    catalog: projected.catalog,
    revision: projected.revision,
  };
}

export async function restoreImportPublication(candidate: StagedImportPublication): Promise<void> {
  await candidate.ddc.restore();
}
