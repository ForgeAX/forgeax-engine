import { encodePng } from '@forgeax/engine-image/png';
import { GLYPH_ADVANCE, GLYPH_HEIGHT, GLYPH_WIDTH, glyph } from './font.ts';

export type RGB = readonly [number, number, number];

/** An opaque RGBA8 raster; every kit function produces and consumes this one shape. */
export interface Image {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export function createImage(width: number, height: number, fill: RGB): Image {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = fill[0];
    rgba[i + 1] = fill[1];
    rgba[i + 2] = fill[2];
    rgba[i + 3] = 255;
  }
  return { width, height, rgba };
}

export function toPng(image: Image): Uint8Array {
  return encodePng(image.width, image.height, image.rgba);
}

/** Box filter to an exact size; integer ratios reproduce supersample averaging exactly. */
export function resize(image: Image, width: number, height: number): Image {
  const out = new Uint8Array(width * height * 4);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = y * sy;
    const y1 = (y + 1) * sy;
    for (let x = 0; x < width; x++) {
      const x0 = x * sx;
      const x1 = (x + 1) * sx;
      let r = 0;
      let g = 0;
      let b = 0;
      let wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const w = wy * (Math.min(xx + 1, x1) - Math.max(xx, x0));
          const o =
            (Math.min(yy, image.height - 1) * image.width + Math.min(xx, image.width - 1)) * 4;
          r += (image.rgba[o] as number) * w;
          g += (image.rgba[o + 1] as number) * w;
          b += (image.rgba[o + 2] as number) * w;
          wsum += w;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = Math.round(r / wsum);
      out[o + 1] = Math.round(g / wsum);
      out[o + 2] = Math.round(b / wsum);
      out[o + 3] = 255;
    }
  }
  return { width, height, rgba: out };
}

export function setPixel(image: Image, x: number, y: number, c: RGB): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const o = (y * image.width + x) * 4;
  image.rgba[o] = c[0];
  image.rgba[o + 1] = c[1];
  image.rgba[o + 2] = c[2];
}

export function fillRect(image: Image, x: number, y: number, w: number, h: number, c: RGB): void {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) setPixel(image, xx, yy, c);
}

export function textWidth(text: string, scale = 1): number {
  return text.length * GLYPH_ADVANCE * scale;
}

export function textHeight(scale = 1): number {
  return GLYPH_HEIGHT * scale;
}

/** Draws `text` with its top-left corner at (x, y); returns the x after the last character. */
export function drawText(
  image: Image,
  x: number,
  y: number,
  text: string,
  c: RGB,
  scale = 1,
): number {
  let cx = x;
  for (const char of text) {
    const columns = glyph(char);
    for (let col = 0; col < GLYPH_WIDTH; col++) {
      const bits = columns[col] ?? 0;
      for (let row = 0; row < GLYPH_HEIGHT; row++)
        if ((bits >> row) & 1) fillRect(image, cx + col * scale, y + row * scale, scale, scale, c);
    }
    cx += GLYPH_ADVANCE * scale;
  }
  return cx;
}

/** Copies `source` into `target` with its top-left corner at (x, y). */
export function blit(target: Image, source: Image, x: number, y: number): void {
  for (let yy = 0; yy < source.height; yy++)
    for (let xx = 0; xx < source.width; xx++) {
      const o = (yy * source.width + xx) * 4;
      setPixel(target, x + xx, y + yy, [
        source.rgba[o] as number,
        source.rgba[o + 1] as number,
        source.rgba[o + 2] as number,
      ]);
    }
}
