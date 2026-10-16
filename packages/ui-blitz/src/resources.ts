import type { UiDocument } from '../pkg/ui-native.mjs';

/** The host owns transport and package policy; Blitz owns URL discovery and decoding. */
export interface UiResources {
  readonly baseUrl: string;
  read(url: string, signal: AbortSignal): Promise<Uint8Array>;
}

export class UiResourceError extends Error {
  readonly code = 'ui-resource-load-failed';
  constructor(
    readonly url: string,
    cause: unknown,
  ) {
    super(`UI resource failed: ${url}`, { cause });
  }
}

export class BlitzResources {
  private readonly lifetime = new AbortController();
  private loading: Promise<void> | undefined;
  constructor(
    private readonly core: UiDocument,
    private readonly source: UiResources | undefined,
  ) {}

  load(): Promise<void> {
    if (this.loading) return this.loading;
    const loading = this.drain();
    this.loading = loading;
    const clear = () => {
      this.loading = undefined;
    };
    void loading.then(clear, clear);
    return loading;
  }

  start(onError: (error: unknown) => void): void {
    if (this.loading || this.lifetime.signal.aborted) return;
    void this.load().catch((cause) => {
      if (!this.lifetime.signal.aborted) onError(cause);
    });
  }

  dispose(): void {
    this.lifetime.abort(new Error('UI document disposed'));
  }

  private async read(url: string): Promise<Uint8Array> {
    const { signal } = this.lifetime;
    signal.throwIfAborted();
    if (!this.source) throw new Error('UI resource reader is not configured');
    let release = () => {};
    const aborted = new Promise<never>((_, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      release = () => signal.removeEventListener('abort', abort);
    });
    try {
      const bytes = await Promise.race([this.source.read(url, signal), aborted]);
      signal.throwIfAborted();
      if (!(bytes instanceof Uint8Array))
        throw new TypeError('UI resource reader must return bytes');
      if (bytes.byteLength > 32 * 1024 * 1024) throw new RangeError('UI resource exceeds 32 MiB');
      return bytes;
    } finally {
      release();
    }
  }

  private async drain(): Promise<void> {
    const { signal } = this.lifetime;
    const failures: UiResourceError[] = [];
    const causes = new Map<string, unknown>();
    for (;;) {
      signal.throwIfAborted();
      const requests = this.core.resource_requests();
      const errors = this.core.resource_errors();
      for (let index = 0; index < errors.length; index += 2) {
        const url = errors[index] ?? '';
        failures.push(new UiResourceError(url, causes.get(url) ?? errors[index + 1]));
      }
      causes.clear();
      if (!requests.length) break;
      // Bound host I/O without changing the core's request or dependency graph.
      for (let start = 0; start < requests.length; start += 8) {
        await Promise.all(
          Array.from(requests.slice(start, start + 8), async (id) => {
            const url = this.core.resource_url(id);
            let bytes: Uint8Array;
            try {
              bytes = await this.read(url);
            } catch (cause) {
              signal.throwIfAborted();
              causes.set(url, cause);
              this.core.resource_failed(id, cause instanceof Error ? cause.message : String(cause));
              return;
            }
            signal.throwIfAborted();
            this.core.resource_response(id, bytes);
          }),
        );
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'UI resources failed');
  }
}
