import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from './errors';
import type { Point2 } from './primitives';
import { type OffsetOptions, type RegionResult, region2d } from './region2d';

/**
 * A single-stroke engineering font on a 4 x 6 grid (cap height 6, advance 6): capital
 * letters, digits and `- . / + : #`. Text becomes polylines, then `region2d.stroke`
 * gives filled outlines for decal textures or surface imprints, with no font file.
 */
type Glyph = readonly (readonly Point2[])[];

const O: Glyph = [
  [
    [1, 0],
    [0, 1],
    [0, 5],
    [1, 6],
    [3, 6],
    [4, 5],
    [4, 1],
    [3, 0],
    [1, 0],
  ],
];
const P: Glyph = [
  [
    [0, 0],
    [0, 6],
    [3, 6],
    [4, 5],
    [4, 4],
    [3, 3],
    [0, 3],
  ],
];

const GLYPHS: Readonly<Record<string, Glyph>> = {
  A: [
    [
      [0, 0],
      [0, 4],
      [2, 6],
      [4, 4],
      [4, 0],
    ],
    [
      [0, 3],
      [4, 3],
    ],
  ],
  B: [
    [
      [0, 3],
      [3, 3],
      [4, 2],
      [4, 1],
      [3, 0],
      [0, 0],
      [0, 6],
      [3, 6],
      [4, 5],
      [4, 4],
      [3, 3],
    ],
  ],
  C: [
    [
      [4, 5],
      [3, 6],
      [1, 6],
      [0, 5],
      [0, 1],
      [1, 0],
      [3, 0],
      [4, 1],
    ],
  ],
  D: [
    [
      [0, 0],
      [0, 6],
      [2, 6],
      [4, 4],
      [4, 2],
      [2, 0],
      [0, 0],
    ],
  ],
  E: [
    [
      [4, 6],
      [0, 6],
      [0, 0],
      [4, 0],
    ],
    [
      [0, 3],
      [3, 3],
    ],
  ],
  F: [
    [
      [4, 6],
      [0, 6],
      [0, 0],
    ],
    [
      [0, 3],
      [3, 3],
    ],
  ],
  G: [
    [
      [4, 5],
      [3, 6],
      [1, 6],
      [0, 5],
      [0, 1],
      [1, 0],
      [3, 0],
      [4, 1],
      [4, 3],
      [2, 3],
    ],
  ],
  H: [
    [
      [0, 0],
      [0, 6],
    ],
    [
      [4, 0],
      [4, 6],
    ],
    [
      [0, 3],
      [4, 3],
    ],
  ],
  I: [
    [
      [1, 6],
      [3, 6],
    ],
    [
      [2, 6],
      [2, 0],
    ],
    [
      [1, 0],
      [3, 0],
    ],
  ],
  J: [
    [
      [4, 6],
      [4, 1],
      [3, 0],
      [1, 0],
      [0, 1],
    ],
  ],
  K: [
    [
      [0, 0],
      [0, 6],
    ],
    [
      [4, 6],
      [0, 2],
    ],
    [
      [1, 3],
      [4, 0],
    ],
  ],
  L: [
    [
      [0, 6],
      [0, 0],
      [4, 0],
    ],
  ],
  M: [
    [
      [0, 0],
      [0, 6],
      [2, 3],
      [4, 6],
      [4, 0],
    ],
  ],
  N: [
    [
      [0, 0],
      [0, 6],
      [4, 0],
      [4, 6],
    ],
  ],
  O,
  P,
  Q: [
    ...O,
    [
      [2, 2],
      [4, 0],
    ],
  ],
  R: [
    ...P,
    [
      [2, 3],
      [4, 0],
    ],
  ],
  S: [
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
  ],
  T: [
    [
      [0, 6],
      [4, 6],
    ],
    [
      [2, 6],
      [2, 0],
    ],
  ],
  U: [
    [
      [0, 6],
      [0, 1],
      [1, 0],
      [3, 0],
      [4, 1],
      [4, 6],
    ],
  ],
  V: [
    [
      [0, 6],
      [2, 0],
      [4, 6],
    ],
  ],
  W: [
    [
      [0, 6],
      [1, 0],
      [2, 4],
      [3, 0],
      [4, 6],
    ],
  ],
  X: [
    [
      [0, 6],
      [4, 0],
    ],
    [
      [0, 0],
      [4, 6],
    ],
  ],
  Y: [
    [
      [0, 6],
      [2, 3],
      [4, 6],
    ],
    [
      [2, 3],
      [2, 0],
    ],
  ],
  Z: [
    [
      [0, 6],
      [4, 6],
      [0, 0],
      [4, 0],
    ],
  ],
  '0': [
    ...O,
    [
      [1, 1],
      [3, 5],
    ],
  ],
  '1': [
    [
      [1, 5],
      [2, 6],
      [2, 0],
    ],
    [
      [1, 0],
      [3, 0],
    ],
  ],
  '2': [
    [
      [0, 5],
      [1, 6],
      [3, 6],
      [4, 5],
      [4, 4],
      [0, 0],
      [4, 0],
    ],
  ],
  '3': [
    [
      [0, 5],
      [1, 6],
      [3, 6],
      [4, 5],
      [4, 4],
      [3, 3],
      [4, 2],
      [4, 1],
      [3, 0],
      [1, 0],
      [0, 1],
    ],
    [
      [1, 3],
      [3, 3],
    ],
  ],
  '4': [
    [
      [3, 0],
      [3, 6],
      [0, 2],
      [4, 2],
    ],
  ],
  '5': [
    [
      [4, 6],
      [0, 6],
      [0, 3],
      [3, 3],
      [4, 2],
      [4, 1],
      [3, 0],
      [1, 0],
      [0, 1],
    ],
  ],
  '6': [
    [
      [4, 5],
      [3, 6],
      [1, 6],
      [0, 5],
      [0, 1],
      [1, 0],
      [3, 0],
      [4, 1],
      [4, 2],
      [3, 3],
      [0, 3],
    ],
  ],
  '7': [
    [
      [0, 6],
      [4, 6],
      [1, 0],
    ],
  ],
  '8': [
    [
      [1, 3],
      [0, 4],
      [0, 5],
      [1, 6],
      [3, 6],
      [4, 5],
      [4, 4],
      [3, 3],
      [1, 3],
      [0, 2],
      [0, 1],
      [1, 0],
      [3, 0],
      [4, 1],
      [4, 2],
      [3, 3],
    ],
  ],
  '9': [
    [
      [4, 3],
      [1, 3],
      [0, 4],
      [0, 5],
      [1, 6],
      [3, 6],
      [4, 5],
      [4, 1],
      [3, 0],
      [1, 0],
      [0, 1],
    ],
  ],
  '-': [
    [
      [1, 3],
      [3, 3],
    ],
  ],
  '.': [
    [
      [1.8, 0],
      [2.2, 0],
    ],
  ],
  '/': [
    [
      [0, 0],
      [4, 6],
    ],
  ],
  '+': [
    [
      [2, 1],
      [2, 5],
    ],
    [
      [0, 3],
      [4, 3],
    ],
  ],
  ':': [
    [
      [1.8, 1],
      [2.2, 1],
    ],
    [
      [1.8, 5],
      [2.2, 5],
    ],
  ],
  '#': [
    [
      [1, 0],
      [1.5, 6],
    ],
    [
      [2.5, 0],
      [3, 6],
    ],
    [
      [0, 2],
      [4, 2],
    ],
    [
      [0, 4],
      [4, 4],
    ],
  ],
  ' ': [],
};

/** Characters the stroke font draws (lowercase letters map to capitals). */
export const TEXT_CHARACTERS: string = Object.keys(GLYPHS).join('');

export interface TextOptions {
  /** Cap height in region units (default 1). */
  readonly height?: number;
  /** Stroke width as a fraction of the cap height (default 0.12). */
  readonly weight?: number;
  /** Extra space between characters, as a fraction of the cap height (default 0). */
  readonly tracking?: number;
  /** 'left' (default) starts at x = 0, 'center' centers the line on x = 0. */
  readonly align?: 'left' | 'center';
  /** Italic shear (x += slant * y, default 0). */
  readonly slant?: number;
}

/** Stroke polylines of one line of text; the baseline is y = 0. */
export function textStrokes(
  text: string,
  options: TextOptions = {},
): Result<Point2[][], ModelingError> {
  const height = options.height ?? 1;
  if (!Number.isFinite(height) || height <= 0) {
    return err(
      modelingError('model-invalid-argument', 'height is a finite length > 0', { height }),
    );
  }
  const unit = height / 6;
  const advance = 6 * unit + (options.tracking ?? 0) * height;
  const slant = options.slant ?? 0;
  const lines: Point2[][] = [];
  const chars = [...text.toUpperCase()];
  for (const [i, ch] of chars.entries()) {
    const glyph = GLYPHS[ch];
    if (glyph === undefined) {
      return err(
        modelingError(
          'model-invalid-argument',
          `text uses only the characters ${JSON.stringify(TEXT_CHARACTERS)}`,
          {
            character: ch,
            index: i,
          },
        ),
      );
    }
    for (const stroke of glyph) {
      lines.push(
        stroke.map(([x, y]): Point2 => [i * advance + x * unit + slant * y * unit, y * unit]),
      );
    }
  }
  if (options.align === 'center' && chars.length > 0) {
    const width = (chars.length - 1) * advance + 4 * unit;
    for (const line of lines) for (const p of line) (p as [number, number])[0] -= width / 2;
  }
  return ok(lines);
}

/** Filled outlines of one line of text (`region2d.stroke` of its strokes, round ends). */
export function textRegion(
  text: string,
  options: TextOptions & Pick<OffsetOptions, 'tolerance' | 'compute' | 'arcTolerance'> = {},
): Result<RegionResult, ModelingError> {
  const strokes = textStrokes(text, options);
  if (!strokes.ok) return strokes;
  const height = options.height ?? 1;
  const weight = options.weight ?? 0.12;
  if (!Number.isFinite(weight) || weight <= 0 || weight > 0.5) {
    return err(
      modelingError('model-invalid-argument', 'weight is a fraction in (0, 0.5]', { weight }),
    );
  }
  return region2d.stroke(strokes.value, (weight * height) / 2, {
    cap: 'round',
    join: 'round',
    tolerance: options.tolerance ?? height * 1e-6,
    arcTolerance: options.arcTolerance ?? height * 0.002,
    ...(options.compute === undefined ? {} : { compute: options.compute }),
  });
}
