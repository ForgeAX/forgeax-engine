import { decodePackDataRecord, encodePackDataRecord } from '@forgeax/engine-pack/runtime';
import type { DirectPackJson } from '@forgeax/engine-pack/source';
import { sha256 } from '@noble/hashes/sha2.js';
import type { RuntimePackContent, RuntimeScriptablePackSource } from './runtime-pack.js';
import { parseRuntimePackContent } from './runtime-pack-content.js';

/** Complete records are replaceable, disposable data owned by the platform adapter. */
export interface RuntimePackCacheStore {
  read(key: string, signal: AbortSignal): Promise<Uint8Array | undefined>;
  write(key: string, bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<void>;
}

const maxRecordBytes = 32 * 1024 * 1024;
const maxPendingWrites = 4;
const readDeadlineMs = 250;
const checksumBytes = 32;

type DeclaredOutputs = NonNullable<NonNullable<RuntimeScriptablePackSource['runtime']>['outputs']>;

function matchesDeclaredOutputs(source: DirectPackJson, outputs: DeclaredOutputs): boolean {
  const entries = Object.entries(source.assets);
  return (
    entries.length === Object.keys(outputs).length &&
    entries.every(([key, asset]) => Object.hasOwn(outputs, key) && outputs[key] === asset.kind)
  );
}

export class RuntimePackPersistentCache {
  private readonly lifetime = new AbortController();
  private readonly pendingWrites = new Map<string, RuntimePackContent>();
  private writing = false;

  constructor(private readonly store: RuntimePackCacheStore) {}

  async read(
    key: string,
    packageId: string,
    outputs: DeclaredOutputs,
    owner: RuntimePackContent,
    signal?: AbortSignal,
  ): Promise<RuntimePackContent | undefined> {
    const bytes = await this.readBytes(key, signal);
    if (!bytes || bytes.byteLength <= checksumBytes || bytes.byteLength > maxRecordBytes) return;
    try {
      const payload = bytes.subarray(checksumBytes);
      if (!sha256(payload).every((value, index) => value === bytes[index])) return;
      const record = decodePackDataRecord(payload, maxRecordBytes - checksumBytes);
      if (!('key' in record) || record.key !== key || !('content' in record)) return;
      const data = record.content;
      if (
        !data ||
        typeof data !== 'object' ||
        !('source' in data) ||
        Object.keys(data).some((field) => field !== 'source' && field !== 'blobs')
      )
        return;
      const content = parseRuntimePackContent({
        ...data,
        ...(owner.programs === undefined ? {} : { programs: owner.programs }),
        ...(owner.dependencies === undefined ? {} : { dependencies: owner.dependencies }),
      });
      if (
        content.source.packageId !== packageId ||
        !('assets' in content.source) ||
        !matchesDeclaredOutputs(content.source, outputs)
      )
        return;
      return content;
    } catch {
      return undefined;
    }
  }

  private readBytes(key: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const lifetime = this.lifetime.signal;
    if (signal?.aborted || lifetime.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const controller = new AbortController();
      const settle = (bytes?: Uint8Array) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        lifetime.removeEventListener('abort', abort);
        resolve(bytes);
      };
      const abort = () => {
        controller.abort();
        settle();
      };
      const timer = setTimeout(abort, readDeadlineMs);
      signal?.addEventListener('abort', abort, { once: true });
      lifetime.addEventListener('abort', abort, { once: true });
      void Promise.resolve()
        .then(() => this.store.read(key, controller.signal))
        .then(
          (bytes) => settle(bytes),
          () => settle(),
        );
    });
  }

  /** Queue the producer-owned graph. Encode only the active write. */
  write(key: string, content: RuntimePackContent): void {
    if (this.lifetime.signal.aborted || this.pendingWrites.size >= maxPendingWrites) return;
    this.pendingWrites.set(key, content);
    if (!this.writing) this.scheduleWrite();
  }

  private scheduleWrite(): void {
    const next = this.pendingWrites.entries().next();
    if (next.done) {
      this.writing = false;
      return;
    }
    const [key, content] = next.value;
    this.pendingWrites.delete(key);
    this.writing = true;
    setTimeout(() => {
      void this.writeRecord(key, content, this.lifetime.signal)
        .catch(() => {
          // Storage and cache encoding cannot reject an already published Pack.
        })
        .finally(() => this.scheduleWrite());
    }, 0);
  }

  private async writeRecord(
    key: string,
    { source, blobs }: RuntimePackContent,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const payload = encodePackDataRecord(
      { key, content: { source, blobs } },
      maxRecordBytes - checksumBytes,
    );
    const bytes = new Uint8Array(checksumBytes + payload.byteLength);
    bytes.set(sha256(payload));
    bytes.set(payload, checksumBytes);
    await this.store.write(key, bytes, signal);
  }

  dispose(): void {
    this.lifetime.abort();
    this.pendingWrites.clear();
  }
}
