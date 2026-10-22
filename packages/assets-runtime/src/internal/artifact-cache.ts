import { type AssetLoadError, ok, type Result } from '@forgeax/engine-types';

interface ArtifactCacheSnapshot {
  readonly entries: number;
  readonly bytes: number;
  readonly pending: number;
  readonly hits: number;
  readonly misses: number;
}

export class ArtifactCache<Failure = AssetLoadError> {
  private readonly values = new Map<string, Uint8Array>();
  private readonly pending = new Map<string, Promise<Result<Uint8Array, Failure>>>();
  private hits = 0;
  private misses = 0;
  private bytes = 0;

  constructor(
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly maxEntries = 1024,
  ) {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      !Number.isSafeInteger(maxEntries) ||
      maxEntries <= 0
    )
      throw new RangeError('artifact cache limits must be positive safe integers');
  }

  read(
    contentAddress: string,
    reader: () => Promise<Result<Uint8Array, Failure>>,
  ): Promise<Result<Uint8Array, Failure>> {
    const copy = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes);
    const value = this.values.get(contentAddress);
    if (value !== undefined) {
      this.hits += 1;
      this.values.delete(contentAddress);
      this.values.set(contentAddress, value);
      return Promise.resolve(ok(copy(value)));
    }
    const pending = this.pending.get(contentAddress);
    if (pending !== undefined) {
      this.hits += 1;
      return pending.then((result) => (result.ok ? ok(copy(result.value)) : result));
    }
    this.misses += 1;
    const request = Promise.resolve()
      .then(reader)
      .then((result) => {
        if (result.ok && this.pending.get(contentAddress) === request) {
          if (result.value.byteLength <= this.maxBytes) {
            while (
              this.values.size >= this.maxEntries ||
              this.bytes + result.value.byteLength > this.maxBytes
            ) {
              const oldest = this.values.keys().next().value;
              if (oldest === undefined) break;
              this.clear(oldest);
            }
            const captured = new Uint8Array(result.value);
            this.values.set(contentAddress, captured);
            this.bytes += captured.byteLength;
          }
        }
        return result;
      })
      .finally(() => {
        if (this.pending.get(contentAddress) === request) this.pending.delete(contentAddress);
      });
    this.pending.set(contentAddress, request);
    return request.then((result) => (result.ok ? ok(copy(result.value)) : result));
  }

  /** Release completed transport bytes without duplicating in-flight reads. */
  trim(): void {
    this.values.clear();
    this.bytes = 0;
  }

  clear(contentAddress?: string): void {
    if (contentAddress === undefined) {
      this.trim();
      this.pending.clear();
      return;
    }
    const value = this.values.get(contentAddress);
    if (value !== undefined) this.bytes -= value.byteLength;
    this.values.delete(contentAddress);
    this.pending.delete(contentAddress);
  }

  snapshot(): ArtifactCacheSnapshot {
    return Object.freeze({
      entries: this.values.size,
      bytes: this.bytes,
      pending: this.pending.size,
      hits: this.hits,
      misses: this.misses,
    });
  }
}
