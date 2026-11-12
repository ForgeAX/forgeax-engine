/** Poll presentation-owned compilation without extending a transport request. */
export async function loadDocumentReference(
  invoke: (args: any, options?: any) => Promise<any>,
  url: string,
  options: { signal?: AbortSignal } = {},
) {
  const { signal } = options;
  for (;;) {
    signal?.throwIfAborted();
    const result = await invoke({ action: 'document', url }, options);
    signal?.throwIfAborted();
    if (result.phase === 'ready') return result.reference;
    if (result.phase !== 'pending') throw new Error('Invalid MCP document phase');
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const timer = setTimeout(finish, 100);
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}
