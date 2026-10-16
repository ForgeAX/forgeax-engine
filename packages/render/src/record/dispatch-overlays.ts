import type { MaterialRenderState } from '@forgeax/engine-types';
import type { DispatchEntry } from '../render-system-extract';
import { variantSetFromDefines } from './helpers';

interface DispatchOverlay {
  readonly renderState: MaterialRenderState | undefined;
  readonly stencilReference: number | undefined;
  readonly variantSet: string | undefined;
}

export interface DispatchOverlays {
  readonly dispatch: readonly DispatchEntry[];
  readonly values: ReadonlyMap<number, DispatchOverlay>;
}

/** Capture last-dispatch authority before residency callbacks can run. */
export function captureDispatchOverlays(dispatch: readonly DispatchEntry[]): DispatchOverlays {
  const values = new Map<number, DispatchOverlay>();
  for (const entry of dispatch) {
    const index = entry.renderableIndex;
    if (index === undefined) continue;
    values.set(index, {
      renderState: entry.renderState,
      stencilReference: entry.stencilReference,
      variantSet: variantSetFromDefines(entry.defines),
    });
  }
  return { dispatch, values };
}
