import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type DdcArtifact,
  type DdcEntry,
  DdcEntryStore,
  type DdcGenerationEntryCandidate,
  DdcGenerationSession,
  type DdcHead,
  DdcLifecycle,
  DdcStoreError,
  ddcOutputDigest,
} from '@forgeax/engine-ddc';
import { canonicalDdcJson } from '@forgeax/engine-ddc/key';
import { stripRuntimePackLifecycle } from '@forgeax/engine-pack/build';
import { decodeMaterialProgramWire } from '@forgeax/engine-pack/runtime';
import {
  type CatalogEntry,
  err,
  ok,
  type ResourceRevision,
  type Result,
} from '@forgeax/engine-types';
import {
  type SourcePackageError,
  type SourcePackageErrorContext,
  sourcePackageError,
} from './source-package-errors.js';

interface SourcePackageDdcEntryInput {
  readonly root: string;
  readonly entry: DdcEntry;
  readonly context: SourcePackageErrorContext;
}

interface StagedSourcePackageDdc extends DdcGenerationEntryCandidate {
  readonly root: string;
  readonly session: DdcGenerationSession;
  readonly context: SourcePackageErrorContext;
}

interface ImmutablePackSelection {
  readonly payload: unknown;
  readonly publicationGeneration?: number;
}

export interface ImportPublicationInput {
  readonly root: string;
  readonly guid: string;
  readonly desiredKey: string;
  readonly pack: unknown;
  readonly previousCatalog: readonly CatalogEntry[];
  readonly nextCatalog: readonly CatalogEntry[];
  readonly publishedGuids: readonly string[];
  readonly transport?: {
    readonly path: string;
    readonly body: string;
    /** Complete package-relative artifact closure for the published Pack. */
    readonly artifacts?: readonly ImportPublicationArtifact[];
  };
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
      readonly transportPersisted: boolean;
    }
  | { readonly ok: false; readonly error: ImportPublicationError; readonly head: DdcHead };

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
  const session = new DdcGenerationSession(input.root, { generation: 1 });
  try {
    const candidate = await session.stageEntry(input.entry);
    return ok(Object.assign(candidate, { root: input.root, session, context: input.context }));
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
  const existing = await new DdcEntryStore(input.root).read(input.desiredKey);
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
  const publicationGeneration =
    input.pack !== null &&
    typeof input.pack === 'object' &&
    !Array.isArray(input.pack) &&
    typeof (input.pack as { readonly generation?: unknown }).generation === 'number' &&
    Number.isSafeInteger((input.pack as { readonly generation: number }).generation) &&
    (input.pack as { readonly generation: number }).generation > 0
      ? (input.pack as { readonly generation: number }).generation
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
    const commit = await candidate.session.commitEntry(candidate, candidate.lease.desiredKey);
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

async function persistTransport(transport: ImportPublicationInput['transport']): Promise<boolean> {
  if (transport === undefined) return true;
  const directory = dirname(transport.path);
  const temporary = `${transport.path}.${randomUUID()}.tmp`;
  try {
    await mkdir(directory, { recursive: true });
    if (((await stat(directory)).mode & 0o222) === 0) {
      throw new Error('transport directory is read-only');
    }
    await writeFile(temporary, transport.body);
    try {
      await rename(temporary, transport.path);
    } catch (error) {
      // Concurrent equivalent replacements can report EPERM on Windows.
      // Admit only the exact already-published bytes; all other failures retain
      // the existing rollback path, without deleting the destination.
      if (
        process.platform !== 'win32' ||
        (error as NodeJS.ErrnoException).code !== 'EPERM' ||
        !(await readFile(transport.path)).equals(Buffer.from(transport.body, 'utf8'))
      ) {
        throw error;
      }
      await rm(temporary, { force: true });
    }
    return true;
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    return false;
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

function publicationArtifacts(
  transport: ImportPublicationInput['transport'],
): Readonly<Record<string, DdcArtifact>> {
  return Object.fromEntries(
    (transport?.artifacts ?? []).map((artifact) => [
      artifact.path,
      { mediaType: artifact.mediaType, bytes: artifact.bytes },
    ]),
  );
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
  const decoded = decodeMaterialProgramWire(input.pack);
  if (!decoded.ok)
    return err(
      sourcePackageError('source-package-publication-invalid', context, {
        stage: 'route-integrity',
        reason: 'invalid material program table',
      }),
    );
  const pack = decoded.value;
  if (
    pack === null ||
    typeof pack !== 'object' ||
    (pack as { readonly schemaVersion?: unknown }).schemaVersion !== '2.0.0' ||
    (pack as { readonly kind?: unknown }).kind !== 'internal-text-package'
  ) {
    return ok(publicationArtifacts(input.transport));
  }
  const assets = (pack as { readonly assets?: unknown }).assets;
  if (!Array.isArray(assets)) {
    return err(
      sourcePackageError('source-package-publication-invalid', context, {
        stage: 'route-integrity',
        reason: 'published Pack does not contain an assets array',
      }),
    );
  }

  const required = new Map<
    string,
    {
      readonly mediaType?: string;
      readonly byteLength?: number;
      readonly integrity?: { readonly algorithm: string; readonly digest: string };
    }
  >();
  for (const asset of assets) {
    if (asset === null || typeof asset !== 'object') {
      return err(
        sourcePackageError('source-package-publication-invalid', context, {
          stage: 'route-integrity',
          reason: 'published Pack contains a non-object asset row',
        }),
      );
    }
    const rawArtifacts = (asset as { readonly artifacts?: unknown }).artifacts;
    if (rawArtifacts === undefined) continue;
    if (rawArtifacts === null || typeof rawArtifacts !== 'object' || Array.isArray(rawArtifacts)) {
      return err(
        sourcePackageError('source-package-publication-invalid', context, {
          stage: 'route-integrity',
          reason: 'published Pack contains an invalid asset artifact map',
        }),
      );
    }
    for (const [localKey, rawDescriptor] of Object.entries(
      rawArtifacts as Record<string, unknown>,
    )) {
      if (rawDescriptor === null || typeof rawDescriptor !== 'object') {
        return err(
          sourcePackageError('source-package-publication-invalid', context, {
            stage: 'route-integrity',
            reason: `artifact descriptor ${localKey} is not an object`,
          }),
        );
      }
      const descriptor = rawDescriptor as Record<string, unknown>;
      const path = descriptor.path;
      if (typeof path !== 'string' || path.length === 0) {
        return err(
          sourcePackageError('source-package-publication-invalid', context, {
            stage: 'route-integrity',
            reason: `artifact descriptor ${localKey} has no package-relative path`,
          }),
        );
      }
      const mediaType = descriptor.mediaType;
      const byteLength = descriptor.byteLength;
      const integrityValue = descriptor.integrity;
      const integrity =
        integrityValue !== null && typeof integrityValue === 'object'
          ? {
              algorithm: (integrityValue as { readonly algorithm?: unknown }).algorithm,
              digest: (integrityValue as { readonly digest?: unknown }).digest,
            }
          : undefined;
      if (
        (mediaType !== undefined && typeof mediaType !== 'string') ||
        (byteLength !== undefined &&
          (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0)) ||
        (integrityValue !== undefined &&
          (integrity === undefined ||
            typeof integrity.algorithm !== 'string' ||
            typeof integrity.digest !== 'string'))
      ) {
        return err(
          sourcePackageError('source-package-publication-invalid', context, {
            stage: 'route-integrity',
            reason: `artifact descriptor ${path} has invalid metadata`,
          }),
        );
      }
      if (required.has(path)) {
        return err(
          sourcePackageError('source-package-publication-invalid', context, {
            stage: 'route-integrity',
            reason: `artifact path ${path} is declared more than once`,
          }),
        );
      }
      required.set(path, {
        ...(typeof mediaType === 'string' ? { mediaType } : {}),
        ...(typeof byteLength === 'number' ? { byteLength } : {}),
        ...(integrity !== undefined &&
        typeof integrity.algorithm === 'string' &&
        typeof integrity.digest === 'string'
          ? { integrity: { algorithm: integrity.algorithm, digest: integrity.digest } }
          : {}),
      });
    }
  }

  const available = new Map<string, ImportPublicationArtifact>();
  const duplicatePaths: string[] = [];
  for (const artifact of input.transport?.artifacts ?? []) {
    if (available.has(artifact.path)) duplicatePaths.push(artifact.path);
    available.set(artifact.path, artifact);
  }
  const missing: string[] = [];
  const mismatched: string[] = [...duplicatePaths.map((path) => `${path}: duplicate body`)];
  for (const path of available.keys()) {
    if (!required.has(path)) mismatched.push(`${path}: unexpected body`);
  }
  for (const [path, descriptor] of required) {
    const artifact = available.get(path);
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

  if (input.transport !== undefined) {
    let transportedPack: unknown;
    try {
      const decodedTransport = decodeMaterialProgramWire(JSON.parse(input.transport.body));
      if (!decodedTransport.ok) throw new TypeError('Invalid material program table');
      transportedPack = decodedTransport.value;
    } catch {
      return err(
        sourcePackageError('source-package-publication-invalid', context, {
          stage: 'route-integrity',
          reason: 'transport body is not valid JSON for the published Pack',
        }),
      );
    }
    if (canonicalDdcJson(transportedPack) !== canonicalDdcJson(pack)) {
      return err(
        sourcePackageError('source-package-publication-invalid', context, {
          stage: 'route-integrity',
          reason: 'transport body does not match the published Pack',
        }),
      );
    }
  }

  return ok(publicationArtifacts(input.transport));
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

export async function publishImportPublication(
  input: ImportPublicationInput,
): Promise<ImportPublicationResult> {
  const staged = await stageImportPublication(input);
  if (!staged.ok) return staged;
  return commitImportPublication(staged.candidate);
}

export async function stageImportPublication(
  input: ImportPublicationInput,
): Promise<StagedImportPublicationResult> {
  const validatedArtifacts = validatePublicationArtifactClosure(input);
  if (!validatedArtifacts.ok) {
    return {
      ok: false,
      error: importPublicationFailure(validatedArtifacts.error),
      head: await inspectHead(input.root, input.guid, input.desiredKey),
    };
  }
  const artifacts = validatedArtifacts.value;
  const selected = await immutablePackPayload(input);
  const { payload } = selected;
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
        producer: 'engine-import/source-package-publication',
        inputFingerprint: input.desiredKey,
        ...(selected.publicationGeneration === undefined
          ? {}
          : { publicationGeneration: selected.publicationGeneration }),
        outputDigest: ddcOutputDigest({
          guid: input.guid,
          payload,
          refs: [],
          artifacts,
        }),
      },
    },
    context: publicationContext(input),
  });
  if (!staged.ok) {
    return {
      ok: false,
      error: importPublicationFailure(staged.error),
      head: await inspectHead(input.root, input.guid, input.desiredKey),
    };
  }
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
  if (!publication.ok) {
    return {
      ok: false,
      error: importPublicationFailure(publication.error),
      head: await inspectHead(
        candidate.input.root,
        candidate.input.guid,
        candidate.input.desiredKey,
      ),
    };
  }
  const transportPersisted = await persistTransport(candidate.input.transport);
  if (!transportPersisted) {
    await restoreImportPublication(candidate);
    return {
      ok: false,
      error: {
        code: 'source-package-publication-invalid',
        expected: 'the sidecar and DDC publication to commit atomically',
        hint: 'repair the sidecar destination, then rebuild or cold-cook the source package',
        detail: 'sidecar transport persistence failed; restored the previous DDC/LKG generation',
        diagnostic: sourcePackageError(
          'source-package-publication-invalid',
          {
            sourceMeta: '<import-publication>',
            anchorGuid: candidate.input.guid,
            affectedGuids: candidate.input.publishedGuids,
            producer: 'source-package/import-publication',
            importer: 'import-publication',
          },
          { stage: 'route-integrity', reason: 'sidecar transport persistence failed' },
        ),
      },
      head: await inspectHead(
        candidate.input.root,
        candidate.input.guid,
        candidate.input.desiredKey,
      ),
    };
  }
  const projected = projectImportPublication(candidate.input, publication.value, Date.now());
  return {
    ok: true,
    key: candidate.input.desiredKey,
    head: publication.value,
    catalog: projected.catalog,
    revision: projected.revision,
    transportPersisted,
  };
}

export async function discardImportPublication(candidate: StagedImportPublication): Promise<void> {
  await candidate.ddc.session.discardEntry(candidate.ddc);
}

export async function restoreImportPublication(candidate: StagedImportPublication): Promise<void> {
  await candidate.ddc.session.restoreEntry(candidate.ddc);
}
