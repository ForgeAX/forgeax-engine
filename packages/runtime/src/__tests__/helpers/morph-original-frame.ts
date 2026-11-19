import type { FrameReceipt, Renderer } from '@forgeax/engine-render';
import type { RecorderAttachment } from '@forgeax/engine-rhi-debug';

/** Observe exactly the first SSR submission; never submit a diagnostic picture. */
export class MorphOriginalFrame {
  private readonly abort = new AbortController();
  private receipt: Record<string, unknown> | undefined;
  private capture: unknown = { status: 'not-armed' };
  private tape: Uint8Array | undefined;
  private closed = false;

  constructor(
    private readonly recorder: Pick<RecorderAttachment, 'captureFrame' | 'frameBoundary'>,
    private readonly inspect: () => unknown,
  ) {}

  async begin(): Promise<void> {
    this.capture = { status: 'arming', snapshotTimeoutMs: 250, byteBudget: 64 * 1024 * 1024 };
    void this.recorder
      .captureFrame({
        signal: this.abort.signal,
        snapshotTimeoutMs: 250,
        byteBudget: 64 * 1024 * 1024,
      })
      .then(
        (result) => {
          if (result.ok) {
            this.tape = result.value.bytes;
            this.capture = {
              status: 'captured',
              digest: result.value.digest,
              bytes: this.tape.length,
            };
          } else this.capture = { status: 'unavailable', error: result.error };
        },
        (error: unknown) => {
          this.capture = { status: 'rejected', error: String(error) };
        },
      );
    const opened = await this.recorder.frameBoundary();
    if (!opened.ok) this.capture = { status: 'unavailable', error: opened.error };
  }

  submitted(
    receipt: Pick<
      FrameReceipt,
      | 'frameId'
      | 'presentation'
      | 'presentationPendingReason'
      | 'preparationCompleted'
      | 'completed'
    >,
  ): void {
    if (this.receipt !== undefined) return;
    const preparation: Record<string, unknown> = { status: 'not-published' };
    const completed: Record<string, unknown> = { status: 'pending' };
    this.receipt = {
      atUnixMs: Date.now(),
      frameId: receipt.frameId,
      presentation: receipt.presentation,
      pendingReason: receipt.presentationPendingReason,
      inspection: this.inspect(),
      preparation,
      completed,
    };
    if (receipt.preparationCompleted !== undefined) {
      preparation.status = 'pending';
      this.observe(receipt.preparationCompleted, preparation);
    }
    this.observe(receipt.completed, completed);
    this.close();
  }

  private observe(promise: PromiseLike<unknown>, target: Record<string, unknown>): void {
    void promise.then(
      (result) => Object.assign(target, { status: 'fulfilled', atUnixMs: Date.now(), result }),
      (error: unknown) =>
        Object.assign(target, { status: 'rejected', atUnixMs: Date.now(), error: String(error) }),
    );
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.recorder.frameBoundary().then(
      (result) => {
        if (!result.ok) this.capture = { status: 'unavailable', error: result.error };
      },
      (error: unknown) => {
        this.capture = { status: 'rejected', error: String(error) };
      },
    );
  }

  evidence() {
    this.close();
    return {
      receipt: this.receipt ?? null,
      capture: this.capture,
      inspection: this.inspect(),
      tape: this.tape,
    };
  }

  dispose(): void {
    this.close();
    this.abort.abort();
  }
}

/** Keep diagnostic submission wrapping outside the scene's verification logic. */
export async function observeMorphSubmission(
  renderer: Renderer,
  diagnostic?: { begin(): Promise<void>; submitted(receipt: FrameReceipt): void },
) {
  if (diagnostic === undefined) return renderer;
  await diagnostic.begin();
  return {
    observe: renderer.observe.bind(renderer),
    draw: (request: Parameters<typeof renderer.draw>[0]) => {
      const result = renderer.draw(request);
      if (result.ok) diagnostic.submitted(result.value);
      return result;
    },
  };
}

/** Diagnostic transport failure must not replace the original render error. */
export async function preserveMorphFailure(
  report: ((draw: () => Promise<unknown>, cause: unknown) => Promise<void>) | undefined,
  draw: () => Promise<unknown>,
  cause: unknown,
): Promise<never> {
  try {
    await report?.(draw, cause);
  } catch {
    // Retain the original case failure even when evidence transport rejects.
  }
  throw cause;
}
