import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  canonicalDdcCapturedDigest,
  canonicalDdcDigest,
  canonicalDdcReadbackDigests,
  captureCanonicalDdcJson,
} from './canonical-json.js';
import { DdcStoreError } from './errors.js';
import { canonicalDdcJson } from './key.js';

export { DdcStoreError } from './errors.js';

export interface DdcArtifact {
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface DdcReceipt {
  readonly guid: string;
  readonly key: string;
  readonly producer: string;
  readonly inputFingerprint: string;
  readonly outputDigest: string;
  /** Optional publication tuple metadata kept outside immutable Pack payloads. */
  readonly publicationGeneration?: number;
}

export interface DdcEntry {
  readonly key: string;
  readonly guid: string;
  readonly payload: unknown;
  readonly refs: readonly string[];
  readonly artifacts: Readonly<Record<string, DdcArtifact>>;
  readonly receipt: DdcReceipt;
}

/** Producers may let staging derive the digest from its one private capture. */
export type DdcEntryInput = Omit<DdcEntry, 'receipt'> & {
  readonly receipt: Omit<DdcReceipt, 'outputDigest'> & { readonly outputDigest?: string };
};

export interface StagedDdcEntry {
  readonly key: string;
  readonly path: string;
  /** Validated candidate identity; publish still verifies the complete existing entry. */
  readonly existing?: Pick<DdcEntry, 'key' | 'guid' | 'receipt'>;
}

export interface PublishDdcEntryResult {
  readonly result: 'published' | 'existing' | 'conflict';
  readonly key: string;
}

interface ArtifactIntegrity {
  readonly mediaType: string;
  readonly byteLength: number;
  readonly digest: string;
}

interface EntryIntegrity {
  readonly payload: string;
  readonly refs: string;
  readonly receipt: string;
  readonly artifacts: Readonly<Record<string, ArtifactIntegrity>>;
  readonly entry: string;
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function artifactFile(key: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(key)) return key;
  return Buffer.from(key, 'utf8').toString('base64url');
}

function validateKey(key: string): void {
  if (!/^[a-f0-9]{64}$/.test(key)) {
    throw new DdcStoreError({ code: 'ddc-entry-invalid', detail: `invalid semantic key: ${key}` });
  }
}

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function sortedArtifacts(entry: Pick<DdcEntry, 'artifacts'>): readonly [string, DdcArtifact][] {
  return Object.entries(entry.artifacts).sort(([left], [right]) => left.localeCompare(right));
}

/** The one output identity shared by receipt validation and DDC publication. */
export function ddcOutputDigest(
  entry: Pick<DdcEntry, 'guid' | 'payload' | 'refs' | 'artifacts'>,
): string {
  return `sha256:${canonicalDdcDigest(outputShape(entry))}`;
}

function outputShape(entry: Pick<DdcEntry, 'guid' | 'payload' | 'refs' | 'artifacts'>) {
  return {
    guid: entry.guid,
    payload: entry.payload,
    refs: entry.refs,
    artifacts: Object.fromEntries(
      sortedArtifacts(entry).map(([key, artifact]) => [
        key,
        {
          mediaType: artifact.mediaType,
          bytes: artifact.bytes,
        },
      ]),
    ),
  };
}

function existingResult(
  existing: Pick<DdcEntry, 'key' | 'guid' | 'receipt'>,
  candidate: Pick<DdcEntry, 'key' | 'guid' | 'receipt'>,
  key: string,
): PublishDdcEntryResult {
  const { publicationGeneration: _existingGeneration, ...existingReceipt } = existing.receipt;
  const { publicationGeneration: _candidateGeneration, ...candidateReceipt } = candidate.receipt;
  const sameImmutableContent =
    existing.key === candidate.key &&
    existing.guid === candidate.guid &&
    // Both entries passed readDirectory's complete content/integrity validation.
    existing.receipt.outputDigest === candidate.receipt.outputDigest &&
    canonicalDdcJson(existingReceipt) === canonicalDdcJson(candidateReceipt);
  return sameImmutableContent ? { result: 'existing', key } : { result: 'conflict', key };
}

function entryShape(entry: DdcEntry): Record<string, unknown> {
  return {
    key: entry.key,
    guid: entry.guid,
    payload: entry.payload,
    refs: entry.refs,
    receipt: entry.receipt,
    artifacts: Object.fromEntries(
      sortedArtifacts(entry).map(([key, artifact]) => [
        key,
        { mediaType: artifact.mediaType, byteLength: artifact.bytes.byteLength },
      ]),
    ),
  };
}

function integrityFor(
  entry: DdcEntry,
  readback?: Pick<EntryIntegrity, 'payload' | 'entry'>,
): EntryIntegrity {
  const artifacts = Object.fromEntries(
    sortedArtifacts(entry).map(([key, artifact]) => [
      key,
      {
        mediaType: artifact.mediaType,
        byteLength: artifact.bytes.byteLength,
        digest: digest(artifact.bytes),
      },
    ]),
  );
  return {
    payload: readback?.payload ?? canonicalDdcDigest(entry.payload),
    refs: canonicalDdcDigest(entry.refs),
    receipt: canonicalDdcDigest(entry.receipt),
    artifacts,
    entry: readback?.entry ?? canonicalDdcDigest(entryShape(entry)),
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function captureEntry(entry: DdcEntryInput): {
  readonly entry: DdcEntry;
  readonly payloadJson: Uint8Array;
  readonly deriveOutputDigest: boolean;
  readonly canonicalPayload: boolean;
} {
  const { key, guid } = entry;
  const artifacts = Object.fromEntries(
    sortedArtifacts(entry).map(([name, artifact]) => [
      name,
      { mediaType: artifact.mediaType, bytes: new Uint8Array(artifact.bytes) },
    ]),
  );
  const captured = captureCanonicalDdcJson(entry.payload);
  const payloadJson = captured.json;
  const payload: unknown = JSON.parse(payloadJson);
  const refs = JSON.parse(canonicalDdcJson(entry.refs)) as readonly string[];
  const receipt = JSON.parse(canonicalDdcJson(entry.receipt)) as DdcEntryInput['receipt'];
  return {
    entry: {
      key,
      guid,
      payload,
      refs,
      receipt: { ...receipt, outputDigest: receipt.outputDigest ?? '' },
      artifacts,
    },
    payloadJson: Buffer.from(payloadJson),
    deriveOutputDigest: receipt.outputDigest === undefined,
    canonicalPayload: captured.canonical,
  };
}

export class DdcEntryStore {
  private readonly entries: string;
  private readonly staging: string;

  public constructor(root: string) {
    this.entries = join(root, 'entries');
    this.staging = join(root, 'staging');
  }

  public async stage(input: DdcEntryInput): Promise<StagedDdcEntry> {
    // Capture once before yielding. Hash the same private JSON and artifact
    // bytes that will be written, sharing the payload across all three hashes.
    const captured = captureEntry(input);
    let entry = captured.entry;
    validateKey(entry.key);
    if (entry.receipt?.key !== entry.key || entry.receipt.guid !== entry.guid) {
      throw new DdcStoreError({
        code: 'ddc-entry-invalid',
        detail: 'receipt identity does not match entry',
      });
    }
    // Canonical text and private buffers were captured synchronously above.
    // Do not traverse that same payload again or require producers to hash it first.
    let output: string;
    if (captured.canonicalPayload) {
      output = await canonicalDdcCapturedDigest(
        outputShape(entry),
        entry.payload,
        captured.payloadJson,
      );
    } else {
      const checked = await canonicalDdcReadbackDigests(
        { payload: entry.payload, output: outputShape(entry), entry: entryShape(entry) },
        captured.payloadJson,
      );
      if (checked.payload !== digest(captured.payloadJson)) {
        throw new DdcStoreError({
          code: 'ddc-entry-invalid',
          detail: 'captured payload text is not canonical',
        });
      }
      output = checked.output;
    }
    if (captured.deriveOutputDigest) {
      entry = { ...entry, receipt: { ...entry.receipt, outputDigest: `sha256:${output}` } };
    } else if (entry.receipt.outputDigest !== `sha256:${output}`) {
      throw new DdcStoreError({
        code: 'ddc-entry-invalid',
        detail: 'receipt output digest does not match entry',
      });
    }
    const readback = {
      payload: digest(captured.payloadJson),
      output,
      entry: await canonicalDdcCapturedDigest(
        entryShape(entry),
        entry.payload,
        captured.payloadJson,
      ),
    };
    // This is only an admission hint, not a trusted cache read. The candidate
    // above is fully validated; publish rereads and validates the stored body.
    // Avoid writing and then rereading a duplicate temporary entry just to
    // discover that the immutable destination already contains the same data.
    const target = join(this.entries, entry.key);
    const receipt = await readJson<DdcReceipt>(join(target, 'receipt.json')).catch(() => undefined);
    if (
      receipt !== null &&
      typeof receipt === 'object' &&
      existingResult({ key: receipt.key, guid: receipt.guid, receipt }, entry, entry.key).result ===
        'existing'
    ) {
      return {
        key: entry.key,
        path: target,
        existing: { key: entry.key, guid: entry.guid, receipt: entry.receipt },
      };
    }
    const path = join(this.staging, `${entry.key}-${randomUUID()}`);
    try {
      await mkdir(join(path, 'artifacts'), { recursive: true });
      await writeFile(join(path, 'payload.json'), captured.payloadJson);
      await writeFile(join(path, 'refs.json'), canonicalDdcJson(entry.refs));
      await writeFile(join(path, 'receipt.json'), canonicalDdcJson(entry.receipt));
      const artifacts: Record<string, { mediaType: string; file: string }> = {};
      for (const [key, artifact] of sortedArtifacts(entry)) {
        const file = artifactFile(key);
        artifacts[key] = { mediaType: artifact.mediaType, file };
        await writeFile(join(path, 'artifacts', `${file}.bin`), artifact.bytes);
      }
      await writeFile(join(path, 'artifacts.json'), canonicalDdcJson(artifacts));
      await writeFile(
        join(path, 'integrity.json'),
        canonicalDdcJson(integrityFor(entry, readback)),
      );
      return { key: entry.key, path };
    } catch (error) {
      await rm(path, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  public async publish(staged: StagedDdcEntry): Promise<PublishDdcEntryResult> {
    const { entry: _entry, ...result } = await this.publishValidated(staged);
    return result;
  }

  /** Lifecycle calls this directly; no caller-supplied validation token is accepted. */
  public async publishForCommit(staged: StagedDdcEntry): Promise<DdcEntry | null> {
    const published = await this.publishValidated(staged);
    if (published.result === 'conflict') {
      throw new DdcStoreError({
        code: 'ddc-entry-conflict',
        detail: `immutable DDC entry ${published.key} conflicts with the staged candidate`,
        expected: 'the existing DDC entry to have the same validated output',
        actual: { key: published.key },
      });
    }
    // A cold rename gets its destination readback. An existing destination has
    // just passed that exact read; carry it directly to the lifecycle fence.
    return published.result === 'published'
      ? this.readDirectory(join(this.entries, staged.key), false)
      : published.entry;
  }

  private async publishValidated(
    staged: StagedDdcEntry,
  ): Promise<PublishDdcEntryResult & { readonly entry: DdcEntry }> {
    validateKey(staged.key);
    const target = join(this.entries, staged.key);
    if (staged.existing !== undefined) {
      const existing = await this.readDirectory(target, false);
      return { ...existingResult(existing, staged.existing, staged.key), entry: existing };
    }
    const candidate = await this.readDirectory(staged.path, true);
    await mkdir(this.entries, { recursive: true });
    const useExisting = async (): Promise<PublishDdcEntryResult & { readonly entry: DdcEntry }> => {
      const existing = await this.readDirectory(target, false);
      await rm(staged.path, { recursive: true, force: true });
      return { ...existingResult(existing, candidate, staged.key), entry: existing };
    };
    try {
      await stat(target);
      return useExisting();
    } catch (error) {
      if (error instanceof DdcStoreError) throw error;
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    try {
      await rename(staged.path, target);
      return { result: 'published', key: staged.key, entry: candidate };
    } catch (error) {
      const code = errorCode(error);
      if (process.platform === 'win32' && code === 'EPERM') {
        // Windows reports a concurrently published directory as EPERM. Keep
        // genuine permission failures unless that destination now exists.
        const existing = await stat(target).catch(() => null);
        if (!existing?.isDirectory()) throw error;
      } else if (!['EEXIST', 'ENOTEMPTY', 'EISDIR'].includes(code ?? '')) throw error;
      return useExisting();
    }
  }

  public async discard(staged: StagedDdcEntry): Promise<void> {
    if (staged.existing !== undefined) return;
    await rm(staged.path, { recursive: true, force: true });
  }

  public async write(entry: DdcEntry): Promise<PublishDdcEntryResult> {
    const staged = await this.stage(entry);
    return this.publish(staged);
  }

  public async read(key: string): Promise<DdcEntry | null> {
    try {
      validateKey(key);
      return await this.readDirectory(join(this.entries, key), false);
    } catch {
      return null;
    }
  }

  /** Payload comparison only; this candidate cannot establish artifact readiness. */
  public async readPayloadCandidate(
    key: string,
  ): Promise<Pick<DdcEntry, 'guid' | 'payload' | 'receipt'> | null> {
    try {
      validateKey(key);
      const path = join(this.entries, key);
      const [payloadJson, receipt, integrity] = await Promise.all([
        readFile(join(path, 'payload.json')),
        readJson<DdcReceipt>(join(path, 'receipt.json')),
        readJson<EntryIntegrity>(join(path, 'integrity.json')),
      ]);
      const payload: unknown = JSON.parse(payloadJson.toString('utf8'));
      if (
        receipt.key !== key ||
        typeof receipt.guid !== 'string' ||
        // The normal writer stores canonical JSON. Matching its byte digest
        // needs no second graph traversal; equivalent noncanonical JSON keeps
        // the semantic fallback. Full entry admission remains at publication.
        (digest(payloadJson) !== integrity.payload &&
          canonicalDdcDigest(payload) !== integrity.payload) ||
        canonicalDdcDigest(receipt) !== integrity.receipt
      )
        return null;
      return { guid: receipt.guid, payload, receipt };
    } catch {
      return null;
    }
  }

  public async listKeys(): Promise<readonly string[]> {
    const entries = await readdir(this.entries, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  public async remove(key: string): Promise<void> {
    validateKey(key);
    await rm(join(this.entries, key), { recursive: true, force: false });
  }

  /** Read with a machine-readable corruption result for recovery tooling. */
  public async readChecked(
    key: string,
  ): Promise<
    | { readonly ok: true; readonly value: DdcEntry | null }
    | { readonly ok: false; readonly error: DdcStoreError }
  > {
    try {
      validateKey(key);
      try {
        await stat(join(this.entries, key));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return { ok: true, value: null };
        throw error;
      }
      try {
        return { ok: true, value: await this.readDirectory(join(this.entries, key), false) };
      } catch (error) {
        if (error instanceof DdcStoreError && error.code === 'ddc-entry-incomplete') {
          return { ok: true, value: null };
        }
        throw error;
      }
    } catch (error) {
      const normalized =
        error instanceof DdcStoreError
          ? error
          : new DdcStoreError({ code: 'ddc-entry-invalid', detail: 'entry is unreadable' });
      return { ok: false, error: normalized };
    }
  }

  private async readDirectory(path: string, incompleteIsError: boolean): Promise<DdcEntry> {
    try {
      const payloadJson = await readFile(join(path, 'payload.json'));
      const payload: unknown = JSON.parse(payloadJson.toString('utf8'));
      const refs = await readJson<readonly string[]>(join(path, 'refs.json'));
      const receipt = await readJson<DdcReceipt>(join(path, 'receipt.json'));
      const manifest = await readJson<
        Readonly<Record<string, { mediaType: string; file: string }>>
      >(join(path, 'artifacts.json'));
      const integrity = await readJson<EntryIntegrity>(join(path, 'integrity.json'));
      const artifacts: Record<string, DdcArtifact> = {};
      for (const [key, descriptor] of Object.entries(manifest).sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        const file = await readFile(join(path, 'artifacts', `${descriptor.file}.bin`));
        // readFile owns this storage. Keep an exact backing buffer without a
        // second artifact-sized allocation; trim pooled/subarray storage so a
        // small artifact cannot retain unrelated bytes. Expose Uint8Array,
        // whose slice still copies, rather than Buffer's aliasing slice.
        const bytes =
          file.byteOffset === 0 && file.byteLength === file.buffer.byteLength
            ? new Uint8Array(file.buffer)
            : new Uint8Array(file);
        artifacts[key] = { mediaType: descriptor.mediaType, bytes };
      }
      const entry = { key: receipt.key, guid: receipt.guid, payload, refs, artifacts, receipt };
      // These parsed objects and buffers are owned by this read. Cooperate with
      // lease heartbeats without exposing caller callbacks across an await.
      const readback = await canonicalDdcReadbackDigests(
        { payload, output: outputShape(entry), entry: entryShape(entry) },
        payloadJson,
      );
      const outputDigest = `sha256:${readback.output}`;
      if (entry.receipt.outputDigest !== outputDigest) {
        throw new DdcStoreError({
          code: 'ddc-entry-invalid',
          detail: 'receipt output digest does not match entry',
        });
      }
      const actual = integrityFor(entry, readback);
      if (canonicalDdcJson(actual) !== canonicalDdcJson(integrity)) {
        throw new DdcStoreError({ code: 'ddc-entry-invalid', detail: 'entry integrity mismatch' });
      }
      return entry;
    } catch (error) {
      if (incompleteIsError) {
        if (error instanceof DdcStoreError) throw error;
        throw new DdcStoreError({
          code: 'ddc-entry-incomplete',
          detail: 'staged entry is incomplete',
        });
      }
      if (error instanceof DdcStoreError) throw error;
      throw new DdcStoreError({ code: 'ddc-entry-invalid', detail: 'entry is unreadable' });
    }
  }
}
