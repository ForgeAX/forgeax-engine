import type { RenderTextureSourceToken } from '@forgeax/engine-types';
import type { RenderTargetTextureSource } from '../targets/contracts';
import type { ExternalTextureSource } from './external-texture';
import { isRenderTextureSourceToken, renderTextureSourceKey } from './source-token';

/** Copyable runtime material reference; native pixels stay with the CanvasTexture owner. */
export interface CanvasTextureSource extends RenderTextureSourceToken {
  readonly source: 'canvas';
}

interface CanvasState {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly flipY: boolean;
  readonly lifetime: AbortController;
  version: number;
}

const sources = new Map<string, CanvasState>();

/** Canvas pixels stay with the author; each Renderer owns its uploaded texture. */
export class CanvasTexture {
  readonly source: CanvasTextureSource;
  private readonly state: CanvasState;

  constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    options: { readonly flipY?: boolean } = {},
  ) {
    this.state = {
      canvas,
      flipY: options.flipY ?? true,
      version: 1,
      lifetime: new AbortController(),
    };
    this.source = Object.freeze({
      kind: 'render-texture-source',
      source: 'canvas',
      owner: crypto.randomUUID(),
      id: 1,
    });
    sources.set(renderTextureSourceKey(this.source), this.state);
  }

  /** Call after painting or resizing. Repeated draws share one upload of this version. */
  update(): void {
    if (!this.state.lifetime.signal.aborted) this.state.version++;
  }

  /** Releases uploads in every Renderer; does not clear or destroy the caller's canvas. */
  dispose(): void {
    this.state.lifetime.abort();
    sources.delete(renderTextureSourceKey(this.source));
  }
}

export type MaterialTextureSource =
  | RenderTargetTextureSource
  | CanvasTextureSource
  | ExternalTextureSource;

export function isCanvasTextureSource(source: unknown): source is CanvasTextureSource {
  return isRenderTextureSourceToken(source) && source.source === 'canvas';
}

export function canvasTextureState(source: CanvasTextureSource): CanvasState | undefined {
  return sources.get(renderTextureSourceKey(source));
}
