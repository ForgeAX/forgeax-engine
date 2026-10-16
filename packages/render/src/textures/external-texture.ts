import type {
  RhiBindingResource,
  ExternalTexture as RhiExternalTexture,
} from '@forgeax/engine-rhi';
import type { RenderError } from '../errors/render';
import type { RenderResult } from '../render-contract';

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

/** Runtime material reference. Keep it in a World shared ref, never in a Pack. */
export interface ExternalTextureSource {
  readonly externalTextureId: number;
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

let nextId = 1;

export function createExternalTextureSource(): ExternalTextureSource {
  return Object.freeze({ externalTextureId: nextId++ });
}

export function isExternalTextureSource(source: unknown): source is ExternalTextureSource {
  return (
    typeof source === 'object' &&
    source !== null &&
    'externalTextureId' in source &&
    Number.isSafeInteger(source.externalTextureId) &&
    (source.externalTextureId as number) > 0
  );
}
