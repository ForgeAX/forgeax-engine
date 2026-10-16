import {
  type CanvasTextureSource,
  canvasTextureState,
  isCanvasTextureSource,
} from '../textures/canvas-texture';

export interface PublishedCanvasFrame {
  readonly id: number;
  readonly version: number;
  readonly disposed: boolean;
  /** Missing for a disposed or zero-sized canvas. */
  readonly frame?: VideoFrame;
}

export interface ReceivedCanvasFrame {
  frame?: VideoFrame | undefined;
  version: number;
  readonly key: object;
  readonly signal: AbortSignal;
}

/** Native frames snapshot author pixels without transferring ownership of the canvas. */
export function publicationCanvasFrames(
  consumers: ReadonlyMap<number, readonly CanvasTextureSource[]>,
): readonly PublishedCanvasFrame[] {
  if (consumers.size === 0) return [];
  const frames = new Map<number, PublishedCanvasFrame>();
  try {
    for (const sources of consumers.values())
      for (const source of sources) {
        if (!isCanvasTextureSource(source) || frames.has(source.canvasTextureId)) continue;
        const state = canvasTextureState(source);
        if (state === undefined) throw new Error('Canvas texture has no source owner');
        const live =
          !state.lifetime.signal.aborted && state.canvas.width > 0 && state.canvas.height > 0;
        frames.set(source.canvasTextureId, {
          id: source.canvasTextureId,
          version: state.version,
          disposed: state.lifetime.signal.aborted,
          ...(live
            ? { frame: new VideoFrame(state.canvas, { timestamp: state.version, alpha: 'keep' }) }
            : {}),
        });
      }
    return [...frames.values()];
  } catch (cause) {
    for (const row of frames.values()) row.frame?.close();
    throw cause;
  }
}

/** Receiver session owns frame clones and stable GPU keys, including retirement. */
export class CanvasFrameReceiver {
  private readonly frames = new Map<number, ReceivedCanvasFrame & { lifetime: AbortController }>();

  get(id: number): ReceivedCanvasFrame | undefined {
    return this.frames.get(id);
  }

  accept(rows: readonly PublishedCanvasFrame[]): void {
    this.releaseFrames();
    const active = new Set(rows.map((row) => row.id));
    for (const [id, state] of this.frames)
      if (!active.has(id)) {
        state.lifetime.abort();
        this.frames.delete(id);
      }
    for (const row of rows) {
      let state = this.frames.get(row.id);
      if (state === undefined || state.signal.aborted) {
        const lifetime = new AbortController();
        state = { key: {}, lifetime, signal: lifetime.signal, version: row.version };
        this.frames.set(row.id, state);
      }
      state.version = row.version;
      state.frame = row.frame;
      if (row.disposed) state.lifetime.abort();
    }
  }

  releaseFrames(): void {
    for (const state of this.frames.values()) {
      state.frame?.close();
      state.frame = undefined;
    }
  }

  dispose(): void {
    this.releaseFrames();
    for (const state of this.frames.values()) state.lifetime.abort();
    this.frames.clear();
  }
}
