import type { WaterViewError, WaterViewState } from '@forgeax/engine-water';

/** Source-owned selection carried by the existing view publication envelope. */
export type WaterRenderView =
  | { readonly kind: 'available'; readonly world: number; readonly state: WaterViewState }
  | {
      readonly kind: 'unavailable';
      readonly errors: readonly { readonly world: number; readonly error: WaterViewError }[];
    };
