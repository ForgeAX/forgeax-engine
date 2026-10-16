import type { RenderTargetTextureSource } from '../targets/contracts';
import type { ExternalTextureSource } from './external-texture';

/** Runtime material reference. Keep it in a World shared ref, never in a Pack. */
export interface CanvasTextureSource {
  readonly canvasTextureId: number;
  /** Immutable UV orientation, retained by native render publications. */
  readonly flipY: boolean;
}

interface CanvasState {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly lifetime: AbortController;
  version: number;
}

const sources = new WeakMap<CanvasTextureSource, CanvasState>();
let nextId = 1;

/** Canvas pixels stay with the author; each Renderer owns its uploaded texture. */
export class CanvasTexture {
  readonly source: CanvasTextureSource;
  private readonly state: CanvasState;

  constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    options: { readonly flipY?: boolean } = {},
  ) {
    this.state = { canvas, version: 1, lifetime: new AbortController() };
    this.source = Object.freeze({ canvasTextureId: nextId++, flipY: options.flipY ?? true });
    sources.set(this.source, this.state);
  }

  /** Call after painting or resizing. Repeated draws share one upload of this version. */
  update(): void {
    if (!this.state.lifetime.signal.aborted) this.state.version++;
  }

  /** Releases uploads in every Renderer; does not clear or destroy the caller's canvas. */
  dispose(): void {
    this.state.lifetime.abort();
  }
}

export type MaterialTextureSource =
  | RenderTargetTextureSource
  | CanvasTextureSource
  | ExternalTextureSource;

export function isCanvasTextureSource(source: unknown): source is CanvasTextureSource {
  return (
    typeof source === 'object' &&
    source !== null &&
    'canvasTextureId' in source &&
    'flipY' in source &&
    typeof source.flipY === 'boolean' &&
    Number.isSafeInteger(source.canvasTextureId) &&
    (source.canvasTextureId as number) > 0
  );
}

export function canvasTextureState(source: CanvasTextureSource): CanvasState | undefined {
  return sources.get(source);
}
