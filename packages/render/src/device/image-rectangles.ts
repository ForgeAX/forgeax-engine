import { StableRangeAllocator } from '../stable-range-allocator';
import type { DataTexture } from './data-texture';

const IMAGE_PAGE_SIDE = 2048;
const PAGE = IMAGE_PAGE_SIDE ** 2;
interface Band {
  readonly start: number;
  readonly height: number;
  readonly columns: StableRangeAllocator;
  references: number;
}
export interface ImageRectangle {
  readonly start: number;
  release(): void;
}

/** Equal-height rectangles share rows; no rectangle crosses an array layer. */
export class ImageRectangles {
  private readonly bands = new Map<number, Band[]>();
  constructor(private readonly texture: DataTexture) {}
  allocate(width: number, height: number): ImageRectangle {
    const roster = this.bands.get(height) ?? [];
    if (!this.bands.has(height)) this.bands.set(height, roster);
    let selected: { band: Band; column: number } | undefined;
    for (const band of roster) {
      const column = band.columns.allocate(width);
      if (column + width <= IMAGE_PAGE_SIDE) {
        selected = { band, column };
        break;
      }
      band.columns.release(column, width);
    }
    if (selected === undefined) {
      let start = this.texture.allocate(height * IMAGE_PAGE_SIDE, IMAGE_PAGE_SIDE);
      if ((start % PAGE) + height * IMAGE_PAGE_SIDE > PAGE) {
        this.texture.release(start, height * IMAGE_PAGE_SIDE);
        start = this.texture.allocate(height * IMAGE_PAGE_SIDE, PAGE);
      }
      const band = { start, height, columns: new StableRangeAllocator(), references: 0 };
      roster.push(band);
      selected = { band, column: band.columns.allocate(width) };
    }
    const { band, column } = selected;
    band.references++;
    let released = false;
    return {
      start: band.start + column,
      release: () => {
        if (released) return;
        released = true;
        band.columns.release(column, width);
        if (--band.references !== 0) return;
        const index = roster.indexOf(band);
        if (index >= 0) roster.splice(index, 1);
        if (roster.length === 0) this.bands.delete(height);
        this.texture.release(band.start, height * IMAGE_PAGE_SIDE);
      },
    };
  }
}
