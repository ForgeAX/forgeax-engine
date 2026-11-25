import type { BindGroup, RhiRenderCommands } from '@forgeax/engine-rhi';

/** A pass consumes its address word synchronously. Composite layouts retain all physical offsets. */
export function bindGeometryOffsets(
  pass: RhiRenderCommands,
  index: number,
  group: BindGroup,
  offsets: readonly number[],
  word: Uint32Array,
): void {
  const offset = offsets.length === 1 ? offsets[0] : undefined;
  if (offset !== undefined && offset === offset >>> 0) {
    word[0] = offset;
    pass.setBindGroup(index, group, word, 0, 1);
  } else pass.setBindGroup(index, group, offsets);
}

export const EMPTY_GEOMETRY_OFFSETS: readonly number[] = Object.freeze([]);
const ZERO_RASTER_OFFSET = Object.freeze([0]);

/** Prepared mesh raster uses one View address and an optional Material address. */
export function bindRasterOffset(
  pass: RhiRenderCommands,
  index: 0 | 1,
  group: BindGroup,
  offset: number | undefined,
  words?: Uint32Array,
): void {
  if (offset === undefined) {
    pass.setBindGroup(index, group);
  } else if (offset === 0) {
    pass.setBindGroup(index, group, ZERO_RASTER_OFFSET);
  } else if (words !== undefined && offset === offset >>> 0) {
    words[0] = offset;
    pass.setBindGroup(index, group, words, 0, 1);
  } else {
    // Preserve the RHI's validation of caller-supplied values outside u32.
    pass.setBindGroup(index, group, [offset]);
  }
}

export function sameGeometryOffsets(left: readonly number[], right: readonly number[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

/** Physical dynamic address after resolving the pass's actual material layout and program. */
export function rasterMaterialOffset(
  byteOffset: number,
  count: 0 | 1 | undefined,
  uniformRequired?: boolean,
): number | undefined {
  if (count === 0) return undefined;
  return uniformRequired === false ? 0 : byteOffset;
}
