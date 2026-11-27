import type { RenderTextureSourceToken } from '@forgeax/engine-types';
import { uuidv7 } from 'uuidv7';
import type { RenderFeatureTextureSource } from '../features/texture-source';
import type { RenderTargetTextureSource } from '../targets/contracts';
import type { ExternalTextureSource } from './external-texture';
import { isRenderTextureSourceToken } from './source-token';

/** Copyable runtime material reference; native pixels stay with the CanvasTexture owner. */
export interface CanvasTextureSource extends RenderTextureSourceToken {
  readonly source: 'canvas';
}

interface CanvasState {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly flipY: boolean;
  readonly lifetime: AbortController;
  snapshot?:
    | {
        readonly frame: VideoFrame;
        readonly width: number;
        readonly height: number;
      }
    | undefined;
  version: number;
}

// Each locally issued Canvas has one source slot and a unique owner across realms.
const CANVAS_SLOT = 1;
/** Bound material fields borrow this slot; disposal releases its pixels for every reader. */
export interface CanvasSourceSlot {
  readonly state: CanvasState | undefined;
}

const sources = new Map<string, CanvasSourceSlot>();

/** Canvas pixels stay with the author; each Renderer owns its uploaded texture. */
export class CanvasTexture {
  readonly source: CanvasTextureSource;
  private readonly slot: { state: CanvasState | undefined };

  constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    options: { readonly flipY?: boolean; readonly snapshot?: boolean } = {},
  ) {
    const state: CanvasState = {
      canvas,
      flipY: options.flipY ?? true,
      version: 1,
      lifetime: new AbortController(),
    };
    if (options.snapshot) state.snapshot = snapshotCanvas(state);
    this.slot = { state };
    this.source = Object.freeze({
      kind: 'render-texture-source',
      source: 'canvas',
      owner: uuidv7(),
      id: CANVAS_SLOT,
    });
    sources.set(this.source.owner, this.slot);
  }

  /** Call after painting or resizing. Repeated draws share one upload of this version. */
  update(): void {
    const state = this.slot.state;
    if (state === undefined) return;
    if (state.snapshot !== undefined) {
      const next = snapshotCanvas(state);
      state.snapshot.frame.close();
      state.snapshot = next;
    }
    state.version++;
  }

  /** Releases uploads in every Renderer; does not clear or destroy the caller's canvas. */
  dispose(): void {
    const state = this.slot.state;
    if (state === undefined) return;
    this.slot.state = undefined;
    sources.delete(this.source.owner);
    state.lifetime.abort();
    state.snapshot?.frame.close();
    state.snapshot = undefined;
  }
}

function snapshotCanvas(state: CanvasState): NonNullable<CanvasState['snapshot']> {
  const frame = new VideoFrame(state.canvas, { timestamp: state.version, alpha: 'keep' });
  return { frame, width: frame.displayWidth, height: frame.displayHeight };
}

export type MaterialTextureSource =
  | import('../features/feature-texture-source').RenderFeatureTextureSource
  | RenderTargetTextureSource
  | CanvasTextureSource
  | ExternalTextureSource
  | RenderFeatureTextureSource;

export function isCanvasTextureSource(source: unknown): source is CanvasTextureSource {
  return isRenderTextureSourceToken(source) && source.source === 'canvas';
}

export function canvasSourceSlot(source: CanvasTextureSource): CanvasSourceSlot | undefined {
  return source.id === CANVAS_SLOT ? sources.get(source.owner) : undefined;
}

export function canvasTextureState(source: CanvasTextureSource): CanvasState | undefined {
  return canvasSourceSlot(source)?.state;
}
