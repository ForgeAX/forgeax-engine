import type { UePosition } from './geometry.ts';
import { previewRect } from './geometry.ts';

export type DropRect = { x: number; y: number; width: number; height: number };

export function rectOf(element: { getBoundingClientRect?: () => unknown } | null | undefined): DropRect | null {
  if (!element?.getBoundingClientRect) return null;
  const rect = element.getBoundingClientRect() as {
    width: number;
    height: number;
    left?: number;
    top?: number;
    x?: number;
    y?: number;
  } | null;
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.left ?? rect.x ?? 0, y: rect.top ?? rect.y ?? 0, width: rect.width, height: rect.height };
}

/** Grid director / tab hits only — edge drops are resolved in the drag controller. */
export function previewRectForGridTarget(
  contentRect: DropRect | null | undefined,
  position: UePosition | null,
): DropRect | null {
  if (!position || !contentRect) return null;
  return previewRect(contentRect, position);
}
