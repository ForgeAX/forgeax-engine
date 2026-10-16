import type { VolumeBounds } from './component';

const CLIP_ROWS = [0, 1, 2, 3] as const;

/** Conservative geometric footprint in normalized framebuffer coordinates. */
export type VolumeProjectedBounds = readonly [number, number, number, number];

/** Reproject current accepted owners; no identity or revision cache observes live data. */
export function projectVolumeCompositeBounds(
  owners: readonly VolumeBounds[],
  viewProjection: ArrayLike<number>,
  cameraPosition: ArrayLike<number>,
): VolumeProjectedBounds | undefined {
  if (
    owners.length === 0 ||
    viewProjection.length !== 16 ||
    cameraPosition.length !== 3 ||
    !Array.from(cameraPosition).every(Number.isFinite)
  )
    return undefined;
  const matrix = Array.from(viewProjection);
  if (!matrix.every(Number.isFinite)) return undefined;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const clip = [0, 0, 0, 0];
  const error = [0, 0, 0, 0];
  for (const bounds of owners) {
    if (
      !bounds.min.every(Number.isFinite) ||
      !bounds.max.every(Number.isFinite) ||
      bounds.max.some((value, axis) => value <= (bounds.min[axis] ?? value))
    )
      return undefined;
    if (
      bounds.min.every((v, axis) => v <= (cameraPosition[axis] ?? v)) &&
      bounds.max.every((v, axis) => v >= (cameraPosition[axis] ?? v))
    )
      return undefined;
    for (let corner = 0; corner < 8; corner++) {
      const px = bounds[corner & 1 ? 'max' : 'min'][0];
      const py = bounds[corner & 2 ? 'max' : 'min'][1];
      const pz = bounds[corner & 4 ? 'max' : 'min'][2];
      let output = 0;
      for (const row of CLIP_ROWS) {
        let value = 0;
        let magnitude = 0;
        for (let column = 0; column < 4; column++) {
          const term =
            (matrix[column * 4 + row] ?? Number.NaN) *
            (column === 0 ? px : column === 1 ? py : column === 2 ? pz : 1);
          value += term;
          magnitude += Math.abs(term);
        }
        if (magnitude > 3.402823e38) return undefined;
        clip[output] = value;
        // Bound f32 dot-product cancellation before perspective division.
        error[output++] = 8 * 2 ** -23 * (magnitude + 1);
      }
      const w = clip[3] ?? Number.NaN;
      const wError = error[3] ?? Infinity;
      if (!(w > wError) || !clip.every(Number.isFinite)) return undefined;
      // Reverse-Z uses z <= w for the near plane. A crossing owner keeps the
      // ordinary full viewport even when all perspective divisors are positive.
      if (w - (clip[2] ?? Infinity) <= wError + (error[2] ?? Infinity)) return undefined;
      const x = (clip[0] ?? Number.NaN) / w;
      const y = (clip[1] ?? Number.NaN) / w;
      const ex = ((error[0] ?? Infinity) + Math.abs(x) * wError) / (w - wError);
      const ey = ((error[1] ?? Infinity) + Math.abs(y) * wError) / (w - wError);
      left = Math.min(left, (x - ex) * 0.5 + 0.5);
      right = Math.max(right, (x + ex) * 0.5 + 0.5);
      top = Math.min(top, 0.5 - (y + ey) * 0.5);
      bottom = Math.max(bottom, 0.5 - (y - ey) * 0.5);
    }
  }
  if (![left, top, right, bottom].every(Number.isFinite)) return undefined;
  return [left, top, right, bottom];
}

/** Three resolve texels cover temporal 3x3, bilinear support, and all composite taps. */
export function volumeCompositeScissor(
  bounds: VolumeProjectedBounds | undefined,
  width: number,
  height: number,
  resolvedWidth: number,
  resolvedHeight: number,
): readonly [number, number, number, number] | undefined {
  if (
    bounds === undefined ||
    ![width, height, resolvedWidth, resolvedHeight].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    !bounds.every(Number.isFinite)
  )
    return undefined;
  // Two additional target pixels retain subpixel TAA jitter and raster rounding.
  const padX = (3 * width) / resolvedWidth + 2;
  const padY = (3 * height) / resolvedHeight + 2;
  const x = Math.max(0, Math.floor(bounds[0] * width - padX));
  const y = Math.max(0, Math.floor(bounds[1] * height - padY));
  const endX = Math.min(width, Math.ceil(bounds[2] * width + padX));
  const endY = Math.min(height, Math.ceil(bounds[3] * height + padY));
  // Empty/unknown view admission belongs to the source gate, never a zero-area draw.
  if (endX <= x || endY <= y || (x === 0 && y === 0 && endX === width && endY === height))
    return undefined;
  return [x, y, endX - x, endY - y];
}
