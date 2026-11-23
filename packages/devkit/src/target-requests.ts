export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

type PendingRequest<Details> = Details & {
  resolve(value: unknown): void;
  reject(cause: unknown): void;
};

/** Own completion and cleanup of requests sent to a replaceable execution target. */
export class TargetRequests<Id, Details extends object> {
  readonly #pending = new Map<Id, PendingRequest<Details>>();

  get size(): number {
    return this.#pending.size;
  }

  get(id: Id) {
    return this.#pending.get(id);
  }

  values() {
    return this.#pending.values();
  }

  open<T = unknown>(
    id: Id,
    details: Details,
    timeout: { readonly ms: number; readonly error: () => unknown } | undefined,
    signal?: AbortSignal,
    cancel?: () => void,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.#pending.has(id))
      throw new Error('A request with this target identity is already pending');
    const { promise, resolve, reject } = createDeferred<unknown>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): boolean => {
      if (this.#pending.get(id) !== request) return false;
      this.#pending.delete(id);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      return true;
    };
    const cancelWith = (error: () => unknown) => {
      if (!finish()) return;
      reject(error());
      cancel?.();
    };
    const onAbort = () => cancelWith(() => signal?.reason);
    const request = Object.assign(details, {
      resolve(value: unknown) {
        if (finish()) resolve(value);
      },
      reject(cause: unknown) {
        if (finish()) reject(cause);
      },
    });
    this.#pending.set(id, request);
    if (timeout !== undefined) {
      timer = setTimeout(() => cancelWith(() => timeout.error()), timeout.ms);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    return promise as Promise<T>;
  }
}
