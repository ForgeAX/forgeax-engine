/** Share only concurrent snapshot reads. Each caller keeps its cancellation lease. */
export function createRequestSharing() {
  type Flight<T> = { controller: AbortController; promise: Promise<T>; readers: number };
  const flights = new Map<string, Flight<unknown>>();
  return {
    fence() { flights.clear(); },
    read<T>(key: string, execute: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(signal.reason);
      let flight = flights.get(key) as Flight<T> | undefined;
      if (!flight) {
        const controller = new AbortController();
        flight = { controller, promise: Promise.resolve().then(() => execute(controller.signal)), readers: 0 };
        flights.set(key, flight);
        const owned = flight;
        void owned.promise.finally(() => { if (flights.get(key) === owned) flights.delete(key); }).catch(() => {});
      }
      const owned = flight; owned.readers++;
      return new Promise((resolve, reject) => {
        let released = false;
        const release = (cancel = false) => {
          if (released) return; released = true;
          signal?.removeEventListener('abort', abort);
          if (--owned.readers === 0) { if (flights.get(key) === owned) flights.delete(key); if (cancel) owned.controller.abort(signal?.reason); }
        };
        const abort = () => { release(true); reject(signal?.reason); };
        signal?.addEventListener('abort', abort, {once: true});
        owned.promise.then(value => { if (released) return; release(); resolve(value); }, error => { if (released) return; release(); reject(error); });
      });
    },
  };
}
