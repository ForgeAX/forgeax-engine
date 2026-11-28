import { dynamicCapacity, shouldShrinkCapacity } from '../dynamic-capacity';
import { FrameKeyRoster } from '../frame-key-roster';
import { drawPositionAt, visitDrawPositions } from './draw-row-pages';
import type { DrawRows } from './frame-snapshot';
import type { MaterialPassLookup } from './material-pass-groups';

const EMPTY_ORDER = new Uint32Array(0);
const SELECTED = -1;

/** One active geometry pass borrows this workspace for its alternate recording order. */
export class GeometryDrawOrder {
  private readonly remaining = new FrameKeyRoster<number, number>((source) => source);
  private positions = EMPTY_ORDER;
  private count = 0;
  private peak = 0;
  private frame = -1;

  admitPass(frame: number, rows: number): void {
    if (frame !== this.frame) {
      if (shouldShrinkCapacity(Math.max(this.peak, rows), this.positions.length)) {
        this.positions = EMPTY_ORDER;
        this.remaining.reset();
      }
      this.peak = 0;
      this.frame = frame;
    }
    // Ordinary order also uses the scene's draw capacity. A pass toggling between
    // ordinary and alternate order should never cause a shrink and regrowth.
    this.peak = Math.max(this.peak, rows);
  }

  private readonly index = (source: number, position: number) => {
    if (!this.remaining.replace(source, position)) this.remaining.add(source, position);
  };

  prepare(
    rows: DrawRows,
    passes: Pick<MaterialPassLookup, 'size' | 'keys'>,
  ): GeometryDrawOrder | undefined {
    this.count = 0;
    if (passes.size === rows.length) {
      let ordinal = 0;
      for (const key of passes.keys()) {
        if (drawPositionAt(rows, ordinal) !== key) break;
        ordinal++;
      }
      if (ordinal === rows.length) return undefined;
    }

    if (this.positions.length < rows.length)
      this.positions = new Uint32Array(dynamicCapacity(rows.length));
    const { remaining, positions } = this;
    try {
      visitDrawPositions(rows, this.index);
      for (const key of passes.keys()) {
        const position = remaining.get(key);
        if (position === undefined || position === SELECTED) continue;
        positions[this.count++] = position;
        remaining.replace(key, SELECTED);
      }
      for (let i = 0; i < remaining.size; i++) {
        const position = remaining.versionAt(i);
        if (position !== SELECTED) positions[this.count++] = position;
      }
    } finally {
      remaining.clear();
    }
    return this;
  }

  at(index: number): number {
    return index < this.count ? (this.positions[index] as number) : index;
  }
}
