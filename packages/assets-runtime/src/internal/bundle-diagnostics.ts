export interface BundleTransferCounters {
  fullReads: number;
  rangeReads: number;
  requestedRangeBytes: number;
  responseEntityBytes: number;
  decodedEntryBytes: number;
  declaredContentLengthBytes: number;
  declaredLengthResponses: number;
  wholeBundleFallbacks: number;
  verifiedReuse: number;
  coalescedReads: number;
  residentHits: number;
  evictions: number;
  rereads: number;
}

export interface BundleTransferObservation {
  readonly status: number;
  /** Bytes exposed by arrayBuffer(), after any HTTP content decoding. */
  readonly entityBytes: number;
  readonly contentLength: number | null;
}

const counters = (): BundleTransferCounters => ({
  fullReads: 0,
  rangeReads: 0,
  requestedRangeBytes: 0,
  responseEntityBytes: 0,
  decodedEntryBytes: 0,
  declaredContentLengthBytes: 0,
  declaredLengthResponses: 0,
  wholeBundleFallbacks: 0,
  verifiedReuse: 0,
  coalescedReads: 0,
  residentHits: 0,
  evictions: 0,
  rereads: 0,
});

/** Monotonic realm-local counters; subtract snapshots to select a load window. */
export class BundleTransferDiagnostics {
  private readonly totals = counters();
  private readonly details = new Map<
    string,
    { url: string; digest: string; counters: BundleTransferCounters }
  >();
  private readonly startedAtMs = Date.now();
  private omittedDetailUpdates = 0;

  count(key: string, field: keyof BundleTransferCounters, value = 1): void {
    this.totals[field] += value;
    let detail = this.details.get(key);
    if (detail === undefined) {
      if (this.details.size >= 128) {
        this.omittedDetailUpdates++;
        return;
      }
      const [url = '', digest = ''] = key.split('\0');
      detail = { url, digest, counters: counters() };
      this.details.set(key, detail);
    }
    detail.counters[field] += value;
  }

  observe(key: string, rangeBytes: number | undefined, response: BundleTransferObservation): void {
    this.count(key, rangeBytes === undefined ? 'fullReads' : 'rangeReads');
    if (rangeBytes !== undefined) {
      this.count(key, 'requestedRangeBytes', rangeBytes);
      if (response.status === 200 && response.entityBytes > rangeBytes)
        this.count(key, 'wholeBundleFallbacks');
    }
    this.count(key, 'responseEntityBytes', response.entityBytes);
    if (response.contentLength !== null) {
      this.count(key, 'declaredLengthResponses');
      this.count(key, 'declaredContentLengthBytes', response.contentLength);
    }
  }

  snapshot() {
    return {
      startedAtMs: this.startedAtMs,
      sampledAtMs: Date.now(),
      clock: 'unix-ms' as const,
      httpCache: 'not-observable' as const,
      totals: { ...this.totals },
      bundles: [...this.details.values()].map((detail) => ({
        ...detail,
        counters: { ...detail.counters },
      })),
      omittedDetailUpdates: this.omittedDetailUpdates,
    };
  }
}
