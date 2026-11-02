import type { World } from '@forgeax/engine-ecs';
import type { TextureFormat } from '@forgeax/engine-rhi';
import type { createUiCompositor } from '../assembly/ui-compositor';
import type { OutputColorSpace } from '../output-color-space';

/** The one failure vocabulary of the UI compositor; each code names one former `throw`. */
export type SurfaceUiFailureCode =
  /** Sparse-strips extent differs from the physical output. */
  | 'ui-paint-extent-mismatch'
  /** The rgba paint is not tightly packed premultiplied sRGB RGBA8. */
  | 'ui-paint-invalid-bytes'
  /** The raster is not initialized or its encode failed. */
  | 'ui-raster-failed'
  /** The owner is disposed, or a texture write or pipeline creation failed. */
  | 'ui-device-operation-failed';

export interface SurfaceUiFailed {
  readonly kind: 'failed';
  readonly frame: number;
  readonly code: SurfaceUiFailureCode;
  readonly detail: string;
}

/** What preparing the screen UI for one frame produced. */
export type SurfaceUiOutcome =
  /** The source reported no change; the retained picture is reused. */
  | { readonly kind: 'retained'; readonly frame: number; readonly generation: number }
  | { readonly kind: 'painted'; readonly frame: number; readonly generation: number }
  | SurfaceUiFailed;

/** What encoding the prepared screen UI into the frame encoder produced. */
export type SurfaceUiEncodeOutcome = { readonly kind: 'encoded' } | SurfaceUiFailed;

export type UiCompositorOwner = Awaited<ReturnType<typeof createUiCompositor>>;

/** The renderer-wide screen UI: its owner and the latest frame-stamped prepare outcome. */
export interface SurfaceUiState {
  readonly owner: UiCompositorOwner;
  readonly format: TextureFormat;
  encodedFrame: number | undefined;
  outcome: SurfaceUiOutcome | undefined;
}

/** Immutable Host inputs for the UI domain; no paint or layout callback is staged here. */
export interface SurfaceUiInput {
  readonly frame: number;
  readonly sampleTimeMs: number;
  readonly width: number;
  readonly height: number;
  readonly uiOnly: boolean;
  readonly colorSpace: OutputColorSpace;
  readonly captureEncodedOutput: boolean;
}
export const RenderSurfaceUiInput = Object.freeze({ name: 'RenderSurfaceUiInput' });

/** World resource key of the renderer-wide {@link SurfaceUiState}. */
export const RenderSurfaceUi = Object.freeze({ name: 'RenderSurfaceUi' });

export function installSurfaceUi(
  world: World,
  owner: UiCompositorOwner,
  format: TextureFormat,
): SurfaceUiState {
  const state: SurfaceUiState = { owner, format, outcome: undefined, encodedFrame: undefined };
  world.insertResource<SurfaceUiState>(RenderSurfaceUi, state);
  return state;
}

/** The installed screen UI, or `undefined` when the Renderer has none. */
export function surfaceUi(world: World): SurfaceUiState | undefined {
  return world.hasResource(RenderSurfaceUi)
    ? world.getResource<SurfaceUiState>(RenderSurfaceUi)
    : undefined;
}
