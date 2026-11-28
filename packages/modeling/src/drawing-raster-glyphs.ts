/**
 * Stroke glyphs of the bitmap raster's fallback. Each glyph sits on the 4 x 6 grid of
 * `textStrokes` (cap height 6, advance 6, baseline y = 0). Letters and digits come from the
 * shared stroke font; the symbols below are owned here so the shared font stays unchanged.
 * Lowercase letters are drawn as capitals, as the shared stroke font does.
 */
import type { Point2 } from './primitives';
import { textStrokes } from './text';

const EXTRA: Readonly<Record<string, readonly (readonly Point2[])[]>> = {
  '!': [
    [
      [2, 6],
      [2, 2],
    ],
    [
      [1.9, 0],
      [2.1, 0],
    ],
  ],
  '"': [
    [
      [1, 6],
      [1, 4],
    ],
    [
      [3, 6],
      [3, 4],
    ],
  ],
  $: [
    [
      [4, 5],
      [3, 6],
      [1, 6],
      [0, 5],
      [0, 4],
      [1, 3],
      [3, 3],
      [4, 2],
      [4, 1],
      [3, 0],
      [1, 0],
      [0, 1],
    ],
    [
      [2, 0],
      [2, 6],
    ],
  ],
  '%': [
    [
      [0, 6],
      [4, 0],
    ],
    [
      [0, 5],
      [1, 5],
      [1, 6],
      [0, 6],
      [0, 5],
    ],
    [
      [3, 1],
      [4, 1],
      [4, 0],
      [3, 0],
      [3, 1],
    ],
  ],
  '&': [
    [
      [4, 0],
      [0, 4],
      [0, 5],
      [1, 6],
      [3, 6],
      [4, 5],
      [4, 4],
      [0, 1],
      [0, 0],
      [4, 0],
    ],
  ],
  "'": [
    [
      [2, 6],
      [2, 4],
    ],
  ],
  '(': [
    [
      [3, 6],
      [1, 4],
      [1, 2],
      [3, 0],
    ],
  ],
  ')': [
    [
      [1, 6],
      [3, 4],
      [3, 2],
      [1, 0],
    ],
  ],
  '*': [
    [
      [2, 4],
      [2, 2],
    ],
    [
      [0, 5],
      [4, 3],
    ],
    [
      [0, 3],
      [4, 5],
    ],
  ],
  ',': [
    [
      [2, 1],
      [1, -1],
    ],
  ],
  ';': [
    [
      [1.9, 4],
      [2.1, 4],
    ],
    [
      [2, 1],
      [1, -1],
    ],
  ],
  '<': [
    [
      [4, 5],
      [0, 3],
      [4, 1],
    ],
  ],
  '=': [
    [
      [0, 4],
      [4, 4],
    ],
    [
      [0, 2],
      [4, 2],
    ],
  ],
  '>': [
    [
      [0, 5],
      [4, 3],
      [0, 1],
    ],
  ],
  '?': [
    [
      [0, 5],
      [1, 6],
      [3, 6],
      [4, 5],
      [4, 4],
      [2, 3],
      [2, 2],
    ],
    [
      [2, 0.5],
      [2, 0],
    ],
  ],
  '@': [
    [
      [4, 1],
      [4, 5],
      [2, 6],
      [0, 5],
      [0, 1],
      [2, 0],
      [4, 1],
    ],
    [
      [2, 2],
      [2, 4],
    ],
  ],
  '[': [
    [
      [3, 6],
      [1, 6],
      [1, 0],
      [3, 0],
    ],
  ],
  '\\': [
    [
      [0, 6],
      [4, 0],
    ],
  ],
  ']': [
    [
      [1, 6],
      [3, 6],
      [3, 0],
      [1, 0],
    ],
  ],
  '^': [
    [
      [0, 4],
      [2, 6],
      [4, 4],
    ],
  ],
  _: [
    [
      [0, -1],
      [4, -1],
    ],
  ],
  '`': [
    [
      [1, 6],
      [2, 5],
    ],
  ],
  '{': [
    [
      [3, 6],
      [2, 6],
      [2, 4],
      [1, 3],
      [2, 2],
      [2, 0],
      [3, 0],
    ],
  ],
  '|': [
    [
      [2, 6],
      [2, -1],
    ],
  ],
  '}': [
    [
      [1, 6],
      [2, 6],
      [2, 4],
      [3, 3],
      [2, 2],
      [2, 0],
      [1, 0],
    ],
  ],
  '~': [
    [
      [0, 3],
      [1, 4],
      [3, 2],
      [4, 3],
    ],
  ],
  '°': [
    [
      [1, 5],
      [2, 6],
      [3, 5],
      [2, 4],
      [1, 5],
    ],
  ],
  '±': [
    [
      [2, 4],
      [2, 1],
    ],
    [
      [0, 2.5],
      [4, 2.5],
    ],
    [
      [0, -0.5],
      [4, -0.5],
    ],
  ],
  '×': [
    [
      [0, 5],
      [4, 1],
    ],
    [
      [0, 1],
      [4, 5],
    ],
  ],
};

/** The diameter sign (U+00D8) is a circle with a slash: the O outline plus the diagonal. */
function slashedO(): readonly (readonly Point2[])[] {
  const o = textStrokes('O', { height: 6 });
  if (!o.ok) return [];
  return [
    ...o.value,
    [
      [0, 0],
      [4, 6],
    ],
  ];
}

const GLYPH_CACHE = new Map<string, readonly (readonly Point2[])[] | null>();

/**
 * The stroke centerlines of one character on the 4 x 6 grid, or null when neither the shared
 * stroke font nor the raster symbols draw it. Null is an error for the caller, never a skip.
 */
export function strokeGlyph(ch: string): readonly (readonly Point2[])[] | null {
  const cached = GLYPH_CACHE.get(ch);
  if (cached !== undefined) return cached;
  let glyph: readonly (readonly Point2[])[] | null = null;
  if (ch === ' ') glyph = [];
  else if (ch === '\u00d8') glyph = slashedO();
  else if (EXTRA[ch] !== undefined) glyph = EXTRA[ch] ?? null;
  else {
    const shared = textStrokes(ch, { height: 6 });
    if (shared.ok && shared.value.length > 0) glyph = shared.value;
  }
  GLYPH_CACHE.set(ch, glyph);
  return glyph;
}

/** Advance of one stroke glyph on the grid (matches `textStrokes`). */
export const STROKE_ADVANCE = 6;
