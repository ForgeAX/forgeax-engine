import { readAssetBundleTable } from '@forgeax/engine-pack/bundle';
import type { ArtifactDescriptor } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';
import { BundleTransferDiagnostics } from './bundle-diagnostics.js';
import { findVerifiedArtifactBytes } from './shared-immutable.js';

type BundleWindow = NonNullable<ArtifactDescriptor['byteRange']>;

export interface BundleWindowRead<Failure> {
  /** Resolved Bundle file URL. */
  readonly url: string;
  readonly range: BundleWindow;
  /**
   * Read the Bundle file and verify `range.bundleDigest`. With `entry`, ask for
   * only `range`; a response of exactly that length is the unverified entry.
   */
  fetch(entry: boolean): Promise<Result<Uint8Array, Failure>>;
  /** Decode and verify one stored entry. Its result is what consumers receive. */
  finish(stored: Uint8Array): Promise<Result<Uint8Array, Failure>>;
  /** Verify a private copy of a value another owner already extracted. */
  reuse(copy: Uint8Array): Promise<Result<Uint8Array, Failure>>;
  /**
   * Content digest of the decoded entry. A consumer may keep the realm's shared
   * view of that content after the extracted value is gone; reusing it avoids a
   * Range refetch.
   */
  readonly digest?: string;
  invalid(reason: string): Failure;
}

interface Resident {
  readonly entries: Map<number, Uint8Array>;
  bytes: number;
}

/**
 * Fetched Bundles stay resident as independent entries. Taking an entry moves it
 * out: each byte lives either in its Bundle or in the extracted value, never both.
 * Once a Bundle has been fetched whole, a later read of a released entry asks for
 * only that window; a host that answers with the whole file repopulates it.
 */
export class BundleStore<Failure> {
  readonly transfers = new BundleTransferDiagnostics();
  private readonly resident = new Map<string, Resident>();
  private readonly loading = new Map<string, Promise<Result<void, Failure>>>();
  private readonly fetched = new Set<string>();
  private readonly windows = new Map<
    string,
    Promise<Result<Uint8Array, Failure>> | WeakRef<Uint8Array>
  >();
  private bytes = 0;

  constructor(private readonly maxResidentBytes = 256 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxResidentBytes) || maxResidentBytes <= 0)
      throw new RangeError('bundle residency limit must be a positive safe integer');
  }

  async read(request: BundleWindowRead<Failure>): Promise<Result<Uint8Array, Failure>> {
    const bundle = `${request.url}\0${request.range.bundleDigest}`;
    const key = `${bundle}\0${request.range.offset}`;
    const existing = this.windows.get(key);
    if (existing !== undefined && !('deref' in existing)) {
      this.transfers.count(bundle, 'coalescedReads');
      const shared = await existing;
      return shared.ok ? request.reuse(shared.value.slice()) : shared;
    }
    const alive =
      existing?.deref() ??
      (request.digest === undefined ? undefined : findVerifiedArtifactBytes(request.digest));
    if (alive !== undefined) {
      // Owners may mutate or transfer their bytes; a reuse is a verified private copy.
      const reused = await request.reuse(alive.slice());
      if (reused.ok) {
        this.transfers.count(bundle, 'verifiedReuse');
        return reused;
      }
    }
    const current = this.windows.get(key);
    if (current !== undefined && current !== existing) return this.read(request);
    const pending = this.extract(bundle, request);
    this.windows.set(key, pending);
    void pending.then(
      (result) => {
        if (result.ok) this.transfers.count(bundle, 'decodedEntryBytes', result.value.byteLength);
        if (this.windows.get(key) !== pending) return;
        if (result.ok && typeof WeakRef === 'function')
          this.windows.set(key, new WeakRef(result.value));
        else this.windows.delete(key);
      },
      () => {
        if (this.windows.get(key) === pending) this.windows.delete(key);
      },
    );
    return pending;
  }

  /** Release resident entries; extracted values keep their own owners. */
  trim(): number {
    const released = this.resident.size;
    for (const key of this.resident.keys()) this.transfers.count(key, 'evictions');
    this.resident.clear();
    this.bytes = 0;
    return released;
  }

  clear(): void {
    this.trim();
    this.loading.clear();
    this.fetched.clear();
    this.windows.clear();
  }

  snapshot(): { readonly bundles: number; readonly bytes: number } {
    return { bundles: this.resident.size, bytes: this.bytes };
  }

  private async extract(
    bundle: string,
    request: BundleWindowRead<Failure>,
  ): Promise<Result<Uint8Array, Failure>> {
    let stored = this.take(bundle, request.range);
    if (stored === undefined && this.fetched.has(bundle) && !this.loading.has(bundle)) {
      this.transfers.count(bundle, 'rereads');
      const fetched = await request.fetch(true);
      if (!fetched.ok) return fetched;
      if (fetched.value.byteLength === request.range.length) return request.finish(fetched.value);
      const admitted = this.admit(bundle, fetched.value, request);
      if (!admitted.ok) return admitted;
      stored = this.take(bundle, request.range);
    } else if (stored === undefined) {
      const loaded = await this.load(bundle, request);
      if (!loaded.ok) return loaded;
      stored = this.take(bundle, request.range);
    }
    if (stored === undefined)
      return err(request.invalid(`no Bundle entry at offset ${request.range.offset}`));
    if (stored.byteLength !== request.range.length)
      return err(request.invalid(`Bundle entry length ${stored.byteLength}`));
    return request.finish(stored);
  }

  private take(bundle: string, range: BundleWindow): Uint8Array | undefined {
    const resident = this.resident.get(bundle);
    const stored = resident?.entries.get(range.offset);
    if (resident === undefined || stored === undefined) return undefined;
    this.transfers.count(bundle, 'residentHits');
    resident.entries.delete(range.offset);
    resident.bytes -= stored.byteLength;
    this.bytes -= stored.byteLength;
    this.resident.delete(bundle);
    if (resident.entries.size > 0) this.resident.set(bundle, resident);
    return stored;
  }

  private load(bundle: string, request: BundleWindowRead<Failure>): Promise<Result<void, Failure>> {
    let loading = this.loading.get(bundle);
    if (loading === undefined) {
      const current = this.populate(bundle, request).finally(() => {
        if (this.loading.get(bundle) === current) this.loading.delete(bundle);
      });
      this.loading.set(bundle, current);
      loading = current;
    } else this.transfers.count(bundle, 'coalescedReads');
    return loading;
  }

  private async populate(
    bundle: string,
    request: BundleWindowRead<Failure>,
  ): Promise<Result<void, Failure>> {
    const fetched = await request.fetch(false);
    return fetched.ok ? this.admit(bundle, fetched.value, request) : fetched;
  }

  private admit(
    bundle: string,
    bytes: Uint8Array,
    request: BundleWindowRead<Failure>,
  ): Result<void, Failure> {
    const table = readAssetBundleTable(bytes);
    if (!table.ok) return err(request.invalid(table.error));
    const previous = this.resident.get(bundle);
    if (previous !== undefined) {
      this.bytes -= previous.bytes;
      this.resident.delete(bundle);
    }
    const resident: Resident = { entries: new Map(), bytes: 0 };
    for (const window of table.value) {
      const extracted = this.windows.get(`${bundle}\0${window.offset}`);
      const settled = extracted !== undefined && 'deref' in extracted;
      // Alive extracted values already own their bytes; every other entry is restored.
      if (settled && extracted.deref() !== undefined) continue;
      resident.entries.set(
        window.offset,
        bytes.slice(window.offset, window.offset + window.length),
      );
      resident.bytes += window.length;
    }
    this.fetched.add(bundle);
    this.resident.set(bundle, resident);
    this.bytes += resident.bytes;
    for (const [key, other] of this.resident) {
      if (this.bytes <= this.maxResidentBytes) break;
      if (key === bundle) continue;
      this.transfers.count(key, 'evictions');
      this.resident.delete(key);
      this.bytes -= other.bytes;
    }
    return ok(undefined);
  }
}
