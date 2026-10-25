interface CompletionRequest {
  poll(): boolean;
  free(): void;
}

// forgeax-async-whitelist: wasm-bindgen — private native queue Promise driver
export type NativeCompletionDriver = (
  start: () => CompletionRequest,
  previous: Promise<undefined>,
) => Promise<undefined>;

// forgeax-async-whitelist: wasm-bindgen — native callback completion retains rejected-Promise semantics
async function observeCompletion(request: CompletionRequest): Promise<undefined> {
  const startedAt = Date.now();
  const deadline = startedAt + 30_000;
  let polls = 0;
  let firstPollDelayMs = 0;
  let lastPollAt = startedAt;
  let maximumPollGapMs = 0;
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    // forgeax-async-whitelist: wasm-bindgen — yield between synchronous native polls
    await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 0 : 1));
    const polledAt = Date.now();
    if (polls === 0) firstPollDelayMs = polledAt - startedAt;
    maximumPollGapMs = Math.max(maximumPollGapMs, polledAt - lastPollAt);
    lastPollAt = polledAt;
    polls++;
    // A busy Host can delay this wake after the GPU has already completed.
    // The deadline bounds further waiting, never an observable native receipt.
    if (request.poll()) return undefined;
    if (polledAt >= deadline) break;
  }
  throw Object.assign(new Error('Queue completion exceeded its bounded native polls'), {
    detail: {
      operation: 'native-queue-completion',
      elapsedMs: Date.now() - startedAt,
      polls,
      firstPollDelayMs,
      maximumPollGapMs,
      deadlineMs: 30_000,
      pollLimit: 10_000,
      lastPollCompleted: false,
    },
  });
}

/** Keep native calls on a catchable JS stack; a Rust future cannot catch WASM traps. */
export const driveNativeCompletion: NativeCompletionDriver = (start, previous) => {
  const observed = (async () => {
    // Register now, preserving the caller's submission boundary, before yielding.
    const request = start();
    return observeCompletion(request).then(
      () => {
        request.free();
        return undefined;
      },
      (cause: unknown) => {
        try {
          request.free();
        } catch (releaseError) {
          // A trap can strand wasm-bindgen's borrow guard. Preserve both failures;
          // the caller must retire that native realm instead of reusing the device.
          throw new AggregateError(
            [cause, releaseError],
            'Native queue completion failed and its ticket could not be released',
            { cause },
          );
        }
        throw cause;
      },
    );
  })();
  // Attach both handlers immediately, even while an earlier request is pending.
  // A failed observation rejects in FIFO order without poisoning the next request.
  const ordered = previous.then(
    () => undefined,
    () => undefined,
  );
  return observed.then(
    () => ordered.then(() => undefined),
    (error: unknown) =>
      ordered.then(() => {
        throw error;
      }),
  );
};
