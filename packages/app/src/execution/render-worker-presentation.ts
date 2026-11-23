interface NativeRenderClock {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(id: number): void;
}

interface PendingPresentation {
  id: number;
  readonly settle: (draw: boolean) => void;
}

/** A serial draw can claim one browser display turn. Hiding drains admitted work. */
export class RenderWorkerPresentation {
  private pending: PendingPresentation | undefined;
  private visible = false;
  private stopped = false;
  private supported = true;

  constructor(private readonly clock: NativeRenderClock) {}

  get waiting(): boolean {
    return this.pending !== undefined;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) this.releasePending(true);
  }

  stop(): void {
    this.stopped = true;
    this.releasePending(false);
  }

  run<T>(draw: () => T): T | undefined | Promise<T | undefined> {
    if (this.stopped) return undefined;
    if (!this.visible || !this.supported) return draw();
    if (this.pending !== undefined)
      throw Error('One browser Render Worker draw may await presentation');
    return new Promise((resolve, reject) => {
      const pending: PendingPresentation = {
        id: 0,
        settle: (shouldDraw) => {
          try {
            resolve(shouldDraw ? draw() : undefined);
          } catch (error) {
            reject(error);
          }
        },
      };
      this.pending = pending;
      try {
        pending.id = this.clock.requestAnimationFrame(() => {
          if (this.pending !== pending) return;
          this.pending = undefined;
          pending.settle(true);
        });
      } catch (error) {
        this.pending = undefined;
        if (error instanceof DOMException && error.name === 'NotSupportedError') {
          // Some browsers expose the method without an animation-frame provider.
          this.supported = false;
          pending.settle(true);
        } else reject(error);
      }
    });
  }

  private releasePending(draw: boolean): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending === undefined) return;
    this.clock.cancelAnimationFrame(pending.id);
    pending.settle(draw);
  }
}

const scope = globalThis as unknown as NativeRenderClock & {
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
let port: MessagePort | undefined;
let presentation: RenderWorkerPresentation | undefined;

export function adoptBrowserRenderPort(connection: MessagePort, visible: boolean): void {
  port = connection;
  if (typeof scope.requestAnimationFrame === 'function') {
    presentation = new RenderWorkerPresentation(scope);
    presentation.setVisible(visible);
  }
}

export function setBrowserRenderVisibility(visible: boolean): void {
  presentation?.setVisible(visible);
}

export function renderPresentation(): RenderWorkerPresentation | undefined {
  return presentation;
}

export function postRenderWorkerMessage(message: unknown, transfer?: Transferable[]): void {
  if (port !== undefined) port.postMessage(message, transfer ?? []);
  else if (transfer === undefined) scope.postMessage(message);
  else scope.postMessage(message, transfer);
}
