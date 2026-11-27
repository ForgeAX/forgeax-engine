import type { BindGroup, RhiRenderCommands } from '@forgeax/engine-rhi';

/** Physical group(2) state of one encoder. Caller-owned address lists may change in place. */
export class PassMeshBindGroup {
  private group: BindGroup | undefined;
  private count = -1;
  private single = 0;
  private composite: Uint32Array | undefined;

  constructor(
    private readonly pass: RhiRenderCommands,
    private readonly word: Uint32Array,
  ) {}

  bind(group: BindGroup, offsets: readonly number[], force = false): void {
    const count = offsets.length;
    const same = !force && this.group === group && this.count === count;
    if (count === 1) {
      const offset = offsets[0];
      if (same && offset === this.single) return;
      if (offset !== undefined && offset === offset >>> 0) {
        this.word[0] = offset;
        this.pass.setBindGroup(2, group, this.word, 0, 1);
        this.single = offset;
      } else {
        this.count = -1;
        this.pass.setBindGroup(2, group, offsets);
        return;
      }
    } else if (count === 0) {
      if (same) return;
      this.pass.setBindGroup(2, group, offsets);
    } else {
      let words = this.composite;
      if (words === undefined || words.length < count)
        this.composite = words = new Uint32Array(count);
      let changed = !same;
      for (let i = 0; i < count; i++) {
        const offset = offsets[i];
        if (offset === undefined || offset !== offset >>> 0) {
          this.count = -1;
          this.pass.setBindGroup(2, group, offsets);
          return;
        }
        if (words[i] !== offset) {
          changed = true;
          words[i] = offset;
        }
      }
      if (!changed) return;
      // A failed encoder call must not qualify the overwritten address words for reuse.
      this.count = -1;
      this.pass.setBindGroup(2, group, words, 0, count);
    }
    this.group = group;
    this.count = count;
  }
}

export const EMPTY_GEOMETRY_OFFSETS: readonly number[] = Object.freeze([]);
const ZERO_RASTER_OFFSET = Object.freeze([0]);

/** Bind one raster address while preserving validation for borrowed offsets. */
export function bindRasterOffset(
  pass: RhiRenderCommands,
  index: 0 | 1 | 2,
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
