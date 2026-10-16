/** Standard document navigation settles on departure; embedded hosts supply their own placement. */
export function navigateBrowserDocument(
  window: Pick<Window, 'location' | 'addEventListener' | 'removeEventListener'>,
  url: string,
  { signal, replace = false }: { signal?: AbortSignal; replace?: boolean } = {},
): Promise<void> {
  const navigate = () => (replace ? window.location.replace(url) : window.location.assign(url));
  if (!window.addEventListener) {
    navigate();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('pagehide', leave);
      signal?.removeEventListener('abort', cancel);
    };
    const leave = () => {
      cleanup();
      resolve();
    };
    const cancel = () => {
      cleanup();
      reject(signal?.reason ?? new Error('document navigation cancelled'));
    };
    window.addEventListener('pagehide', leave, { once: true });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }
    try {
      navigate();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
