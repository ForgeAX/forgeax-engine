import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createImage, drawText, type Image, type RGB, resize, toPng } from './image.ts';

export interface SheetCell {
  readonly image: Image;
  readonly caption: string;
}

export interface SheetOptions {
  readonly columns?: number;
  /** Cell image size in pixels (default 320). */
  readonly cell?: number;
  readonly title?: string;
  readonly background?: RGB;
  /** Text scale for captions (default 1). */
  readonly textScale?: number;
  /** Write the PNG here as well. */
  readonly path?: string;
}

const TEXT: RGB = [226, 230, 238];
const PAD = 8;

function wrap(text: string, width: number, scale: number): string[] {
  const perLine = Math.max(8, Math.floor(width / (6 * scale)));
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    if (cur.length > 0 && cur.length + 1 + word.length > perLine) {
      lines.push(cur);
      cur = word;
    } else cur = cur.length === 0 ? word : `${cur} ${word}`;
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
}

/** A grid of images with captions under each, in input order; the output depends only on its inputs. */
export function contactSheet(cells: readonly SheetCell[], options: SheetOptions = {}): Image {
  const columns = options.columns ?? 4;
  const cell = options.cell ?? 320;
  const scale = options.textScale ?? 1;
  const lineH = 7 * scale + 4;
  const captions = cells.map((c) => wrap(c.caption, cell, scale));
  const captionRows = Math.max(1, ...captions.map((c) => c.length));
  const rowH = cell + captionRows * lineH + PAD * 2;
  const rows = Math.ceil(cells.length / columns);
  const titleH = options.title === undefined ? 0 : 7 * scale * 2 + PAD * 2;
  const width = columns * (cell + PAD) + PAD;
  const sheet = createImage(width, titleH + rows * rowH + PAD, options.background ?? [14, 16, 21]);
  if (options.title !== undefined) drawText(sheet, PAD, PAD, options.title, TEXT, scale * 2);
  cells.forEach((c, i) => {
    const x = PAD + (i % columns) * (cell + PAD);
    const y = titleH + PAD + Math.floor(i / columns) * rowH;
    const thumb =
      c.image.width === cell && c.image.height === cell ? c.image : resize(c.image, cell, cell);
    for (let yy = 0; yy < cell; yy++)
      sheet.rgba.set(
        thumb.rgba.subarray(yy * cell * 4, (yy + 1) * cell * 4),
        ((y + yy) * width + x) * 4,
      );
    (captions[i] as string[]).forEach((line, li) => {
      drawText(sheet, x, y + cell + 4 + li * lineH, line, TEXT, scale);
    });
  });
  if (options.path !== undefined) {
    mkdirSync(dirname(options.path), { recursive: true });
    writeFileSync(options.path, toPng(sheet));
  }
  return sheet;
}
