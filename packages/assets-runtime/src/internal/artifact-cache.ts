import { type AssetLoadError, ok, type Result } from '@forgeax/engine-types';

export interface ArtifactCacheSnapshot {
  readonly entries: number;
  readonly pending: number;
  readonly hits: number;
  readonly misses: number;
}

export class ArtifactCache {
  private readonly values = new Map<string, Uint8Array>();
  private readonly pending = new Map<string, Promise<Result<Uint8Array, AssetLoadError>>>();
  private hits = 0;
  private misses = 0;

  read(
    contentAddress: string,
    reader: () => Promise<Result<Uint8Array, AssetLoadError>>,
  ): Promise<Result<Uint8Array, AssetLoadError>> {
    const value = this.values.get(contentAddress);
    if (value !== undefined) {
      this.hits += 1;
      return Promise.resolve(ok(new Uint8Array(value)));
    }
    const pending = this.pending.get(contentAddress);
    if (pending !== undefined) {
      this.hits += 1;
      return pending;
    }
    this.misses += 1;
    const request = Promise.resolve()
      .then(reader)
      .then((result) => {
        if (result.ok && this.pending.get(contentAddress) === request) {
          this.values.set(contentAddress, new Uint8Array(result.value));
        }
        return result;
      })
      .finally(() => {
        if (this.pending.get(contentAddress) === request) this.pending.delete(contentAddress);
      });
    this.pending.set(contentAddress, request);
    return request;
  }

  clear(contentAddress?: string): void {
    if (contentAddress === undefined) {
      this.values.clear();
      this.pending.clear();
      return;
    }
    this.values.delete(contentAddress);
    this.pending.delete(contentAddress);
  }

  snapshot(): ArtifactCacheSnapshot {
    return Object.freeze({
      entries: this.values.size,
      pending: this.pending.size,
      hits: this.hits,
      misses: this.misses,
    });
  }
}
