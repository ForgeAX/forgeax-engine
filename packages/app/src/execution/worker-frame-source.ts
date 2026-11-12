/** Private native frame leases share the existing Engine-to-Host channel. */
export type FrameNotice =
  | { readonly kind: 'native-frame-ready'; readonly supported: boolean }
  | { readonly kind: 'native-frame'; readonly id: number };
export type FrameRequest = { readonly kind: 'native-frame-request'; readonly id: number };
type FramePort = { postMessage(message: FrameRequest): void };

/** Host owns one future demand; a replaced port cannot fulfil its successor. */
export class WorkerFrameSource {
  private port: FramePort | undefined;
  private supported = false;
  private sequence = 0;
  private pending: { id: number; callback: () => void; unavailable: () => void } | undefined;

  connect(port: FramePort | undefined): void {
    const pending = this.pending;
    this.pending = undefined;
    this.port = port;
    this.supported = false;
    pending?.unavailable();
  }

  receive(port: FramePort, notice: FrameNotice): void {
    if (port !== this.port) return;
    if (notice.kind === 'native-frame-ready') {
      this.supported = notice.supported;
      if (!notice.supported) {
        const pending = this.pending;
        this.pending = undefined;
        pending?.unavailable();
      }
    } else if (this.pending?.id === notice.id) {
      const pending = this.pending;
      this.pending = undefined;
      pending.callback();
    }
  }

  request(callback: () => void, unavailable: () => void): (() => void) | undefined {
    const port = this.port;
    if (!this.supported || port === undefined) return undefined;
    if (this.pending !== undefined) throw new Error('A native frame lease is already pending');
    const id = ++this.sequence;
    this.pending = { id, callback, unavailable };
    try {
      port.postMessage({ kind: 'native-frame-request', id } satisfies FrameRequest);
    } catch {
      this.pending = undefined;
      this.supported = false;
      return undefined;
    }
    return () => {
      if (this.pending?.id !== id) return;
      this.pending = undefined;
      try {
        port.postMessage({ kind: 'native-frame-request', id: -id } satisfies FrameRequest);
      } catch {
        this.supported = false;
      }
    };
  }
}

/** Uses this Engine Worker's native rAF, without a heartbeat or another Worker. */
export function createWorkerFrameResponder(
  port: { postMessage(message: FrameNotice): void },
  native: Pick<typeof globalThis, 'requestAnimationFrame' | 'cancelAnimationFrame'> = globalThis,
) {
  let pending: { id: number; token: number } | undefined;
  const cancel = (): void => {
    if (pending === undefined) return;
    native.cancelAnimationFrame(pending.token);
    pending = undefined;
  };
  const supported =
    typeof native.requestAnimationFrame === 'function' &&
    typeof native.cancelAnimationFrame === 'function';
  const receive = (data: FrameRequest): void => {
    if (data.kind !== 'native-frame-request' || !supported) return;
    const id = data.id;
    if (id < 0) {
      if (pending?.id === -id) cancel();
      return;
    }
    cancel();
    try {
      const token = native.requestAnimationFrame(() => {
        if (pending?.id !== id) return;
        pending = undefined;
        port.postMessage({ kind: 'native-frame', id } satisfies FrameNotice);
      });
      pending = { id, token };
    } catch {
      port.postMessage({ kind: 'native-frame-ready', supported: false } satisfies FrameNotice);
    }
  };
  port.postMessage({ kind: 'native-frame-ready', supported } satisfies FrameNotice);
  return {
    receive,
    dispose(): void {
      cancel();
      port.postMessage({ kind: 'native-frame-ready', supported: false } satisfies FrameNotice);
    },
  };
}
