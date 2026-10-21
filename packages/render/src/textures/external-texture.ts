import type {
  RhiBindingResource,
  ExternalTexture as RhiExternalTexture,
} from '@forgeax/engine-rhi';
import type { RenderTextureSourceToken } from '@forgeax/engine-types';
import type { RenderError } from '../errors/render';
import type { RenderResult } from '../render-contract';
import { isRenderTextureSourceToken } from './source-token';

/**
 * One external-source concept; the kind is the only difference. A
 * `gpu-texture` is a caller-owned GPUTexture created on
 * `renderer.nativeDevice()`; a `video` source is re-imported by the renderer
 * every frame.
 */
export type ExternalTextureInput =
  | { readonly kind: 'gpu-texture'; readonly texture: GPUTexture }
  | { readonly kind: 'video'; readonly source: HTMLVideoElement | VideoFrame };

export type ExternalTextureKind = ExternalTextureInput['kind'];

/** Copyable runtime reference; only its importing Renderer may resolve it. */
export interface ExternalTextureSource extends RenderTextureSourceToken {
  readonly source: 'external';
}

/** Renderer-local handle returned by `renderer.importTexture`. */
export interface ExternalTexture {
  readonly source: ExternalTextureSource;
  readonly kind: ExternalTextureKind;
  /** Swap the input in place; every material referencing `source` rebinds next frame. */
  replace(input: ExternalTextureInput): Promise<RenderResult<void, RenderError>>;
  /** Drops renderer state. The caller's GPUTexture, video element, or VideoFrame is never destroyed. */
  release(): RenderResult<void, RenderError>;
}

/** Record-stage seam: resolves a source for one material slot of the active frame. */
export interface ExternalTextureBinder {
  /**
   * `slotExternal` is true for `texture_external` slots. Undefined keeps the
   * slot default; the structured cause is already on the error channel.
   */
  resolve(source: ExternalTextureSource, slotExternal: boolean): RhiBindingResource | undefined;
  /** Zero-copy frame import, memoized per frame; undefined when the capability is absent. */
  importVideoFrame(source: HTMLVideoElement | VideoFrame): RhiExternalTexture | undefined;
}

export function createExternalTextureSource(owner: string, id: number): ExternalTextureSource {
  return Object.freeze({ kind: 'render-texture-source', source: 'external', owner, id });
}

export function isExternalTextureSource(source: unknown): source is ExternalTextureSource {
  return isRenderTextureSourceToken(source) && source.source === 'external';
}
