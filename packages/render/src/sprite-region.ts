export type SpriteRegion = readonly [number, number, number, number];

/** Flip the selected atlas rectangle, including an instance's animation frame. */
export function spriteUvRegion(
  region: ArrayLike<number> | undefined,
  flipX: unknown,
  flipY: unknown,
): [number, number, number, number] {
  let x = region?.[0] ?? 0;
  let y = region?.[1] ?? 0;
  let width = region?.[2] ?? 1;
  let height = region?.[3] ?? 1;
  if (typeof flipX === 'number' && flipX !== 0) {
    x += width;
    width = -width;
  }
  if (typeof flipY === 'number' && flipY !== 0) {
    y += height;
    height = -height;
  }
  return [x, y, width, height];
}
