// Aborting asks the transport to close its connection. Race the abort event
// and deadline too, so callers can proceed if transport cleanup stays pending.
export async function withinHttpDeadline(operation, controller, timeoutMs, message) {
  const signal = controller?.signal;
  signal?.throwIfAborted();
  let timer;
  let abort;
  try {
    const deadline = new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        const error = new Error(message);
        reject(error);
        controller?.abort(error);
      }, timeoutMs);
    });
    return await Promise.race([Promise.resolve().then(operation), deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function discardHttpResponse(response, controller) {
  controller.abort();
  // An unused body has no file writer. Abort synchronously and let the
  // transport finish closing without holding the next request.
  void response.body?.cancel().catch(() => {});
}
