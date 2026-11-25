import {
  type CanvasTextureSource,
  canvasTextureState,
  isCanvasTextureSource,
} from '../textures/canvas-texture';
import { renderTextureSourceKey } from '../textures/source-token';

import type { TextureConsumerRoster } from './texture-consumers';

export interface PublishedCanvasFrame {
  readonly id: string;
  readonly flipY: boolean;
  readonly version: number;
  readonly disposed: boolean;
  /** Only immutable author snapshots may survive the consuming draw. */
  readonly snapshot?: 'replace' | 'reuse';
  /** A reused snapshot, disposed source or zero-sized canvas carries no pixels. */
  readonly frame?: VideoFrame;
}

export interface ReceivedCanvasFrame {
  frame?: VideoFrame | undefined;
  version: number;
  flipY: boolean;
  readonly key: object;
  readonly signal: AbortSignal;
}

interface AcceptedCanvasSnapshot {
  readonly reference: PublishedCanvasFrame;
  lastRevision: number;
}

const NO_CANVAS_FRAMES: readonly PublishedCanvasFrame[] = Object.freeze([]);

/** A source epoch owns delivery identities, never the pixels of an accepted packet. */
export class CanvasFramePublisher {
  private readonly snapshots = new Map<string, AcceptedCanvasSnapshot>();
  private readonly seen = new Set<string>();

  prepare(consumers: TextureConsumerRoster<CanvasTextureSource>): readonly PublishedCanvasFrame[] {
    if (consumers.size === 0) return NO_CANVAS_FRAMES;
    const rows: PublishedCanvasFrame[] = [];
    try {
      consumers.forEach((sources) => {
        for (const source of sources) {
          if (!isCanvasTextureSource(source)) continue;
          const id = renderTextureSourceKey(source);
          if (this.seen.has(id)) continue;
          this.seen.add(id);
          rows.push(this.sourceRow(id, source));
        }
      });
      return rows;
    } catch (cause) {
      for (const row of rows) row.frame?.close();
      throw cause;
    } finally {
      this.seen.clear();
    }
  }

  private sourceRow(id: string, source: CanvasTextureSource): PublishedCanvasFrame {
    const state = canvasTextureState(source);
    if (state === undefined || state.lifetime.signal.aborted)
      return { id, version: state?.version ?? 1, flipY: state?.flipY ?? false, disposed: true };
    const { version, flipY, snapshot, canvas } = state;
    if (snapshot !== undefined) {
      const prior = this.snapshots.get(id)?.reference;
      if (prior?.version === version && prior.flipY === flipY) return prior;
      return {
        id,
        version,
        flipY,
        disposed: false,
        snapshot: 'replace',
        frame: new VideoFrame(snapshot.frame, { timestamp: version, alpha: 'keep' }),
      };
    }
    // A live author canvas may resize or be painted before its first visible draw.
    return {
      id,
      version,
      flipY,
      disposed: false,
      ...(canvas.width > 0 && canvas.height > 0
        ? { frame: new VideoFrame(canvas, { timestamp: version, alpha: 'keep' }) }
        : {}),
    };
  }

  accept(rows: readonly PublishedCanvasFrame[], revision: number): void {
    for (const row of rows) {
      if (row.snapshot === 'replace') {
        const { id, version, flipY } = row;
        this.snapshots.set(id, {
          reference: Object.freeze({ id, version, flipY, disposed: false, snapshot: 'reuse' }),
          lastRevision: revision,
        });
      } else if (row.snapshot === 'reuse') {
        const accepted = this.snapshots.get(row.id);
        if (accepted !== undefined) accepted.lastRevision = revision;
      }
    }
    for (const [id, entry] of this.snapshots)
      if (entry.lastRevision !== revision) this.snapshots.delete(id);
  }

  clear(): void {
    this.snapshots.clear();
  }
}

interface CanvasReceiverState extends ReceivedCanvasFrame {
  readonly lifetime: AbortController;
  snapshot: boolean;
}

/** Each live immutable source has one owned frame for late draws and device recreation. */
export class CanvasFrameReceiver {
  private readonly frames = new Map<string, CanvasReceiverState>();

  get(id: string): ReceivedCanvasFrame | undefined {
    return this.frames.get(id);
  }

  hasSnapshot(row: PublishedCanvasFrame): boolean {
    const state = this.frames.get(row.id);
    return (
      state?.snapshot === true &&
      state.version === row.version &&
      state.flipY === row.flipY &&
      state.frame !== undefined &&
      state.frame.displayWidth > 0 &&
      !state.signal.aborted
    );
  }

  accept(rows: readonly PublishedCanvasFrame[], active: ReadonlySet<string>): void {
    for (const [id, state] of this.frames)
      if (!active.has(id)) {
        state.frame?.close();
        state.lifetime.abort();
        this.frames.delete(id);
      }
    for (const row of rows) {
      if (row.snapshot === 'reuse') continue;
      let state = this.frames.get(row.id);
      if (state === undefined || (state.signal.aborted && !row.disposed)) {
        const lifetime = new AbortController();
        state = {
          key: {},
          lifetime,
          signal: lifetime.signal,
          version: row.version,
          flipY: row.flipY,
          snapshot: false,
        };
        this.frames.set(row.id, state);
      }
      // The App also closes transport handles after completion. Own a separate
      // reference only when a version survives that completion.
      const snapshot = row.snapshot === 'replace';
      const frame = snapshot ? row.frame?.clone() : row.frame;
      if (snapshot) row.frame?.close();
      state.frame?.close();
      state.version = row.version;
      state.flipY = row.flipY;
      state.frame = frame;
      state.snapshot = snapshot;
      if (row.disposed) state.lifetime.abort();
    }
  }

  releaseFrames(): void {
    for (const state of this.frames.values())
      if (!state.snapshot) {
        state.frame?.close();
        state.frame = undefined;
      }
  }

  dispose(): void {
    for (const state of this.frames.values()) {
      state.frame?.close();
      state.lifetime.abort();
    }
    this.frames.clear();
  }
}
