/** One transport admission point for all nested realms; polls cannot consume foreground slots. */
export function createToolQueue<T, R = unknown>(
  execute: (params: T, signal?: AbortSignal) => Promise<R>,
  limits = { foreground: 3, background: 1 },
) {
  type Job = {
    params: T;
    signal?: AbortSignal;
    resolve(value: R): void;
    reject(error: unknown): void;
    abort(): void;
  };
  const lanes = {
    foreground: { active: 0, jobs: [] as Job[] },
    background: { active: 0, jobs: [] as Job[] },
  };
  const lifetime = new AbortController();
  let closed = false;
  const pump = (name: keyof typeof lanes) => {
    const lane = lanes[name];
    while (!closed && lane.active < limits[name] && lane.jobs.length) {
      const job = lane.jobs.shift()!;
      job.signal?.removeEventListener('abort', job.abort);
      if (job.signal?.aborted) {
        job.reject(job.signal.reason);
        continue;
      }
      lane.active++;
      Promise.resolve()
        .then(() =>
          execute(
            job.params,
            job.signal ? AbortSignal.any([job.signal, lifetime.signal]) : lifetime.signal,
          ),
        )
        .then(job.resolve, job.reject)
        .finally(() => {
          lane.active--;
          pump(name);
        });
    }
  };
  return {
    call(
      params: T,
      { signal, background = false }: { signal?: AbortSignal; background?: boolean } = {},
    ) {
      if (closed) return Promise.reject(new Error('MCP document retired'));
      if (signal?.aborted) return Promise.reject(signal.reason);
      const name = background ? 'background' : 'foreground';
      const lane = lanes[name];
      if (lane.jobs.length >= 512)
        return Promise.reject(new Error('MCP pending request bound exceeded'));
      return new Promise<R>((resolve, reject) => {
        const job: Job = {
          params,
          signal,
          resolve,
          reject,
          abort() {
            const index = lane.jobs.indexOf(job);
            if (index >= 0) lane.jobs.splice(index, 1);
            reject(signal?.reason);
          },
        };
        signal?.addEventListener('abort', job.abort, { once: true });
        lane.jobs.push(job);
        pump(name);
      });
    },
    close() {
      closed = true;
      lifetime.abort(new Error('MCP document retired'));
      for (const lane of Object.values(lanes))
        for (const job of lane.jobs.splice(0)) {
          job.signal?.removeEventListener('abort', job.abort);
          job.reject(new Error('MCP document retired'));
        }
    },
  };
}
