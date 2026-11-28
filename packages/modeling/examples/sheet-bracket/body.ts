import { type Model, model, type SheetMetalSpec, sheet } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * A U-channel mounting bracket as a sheet-metal part: the flat pattern is the source (a base with
 * two flanges, a round hole in the base and a slot in each flange); the folded body is derived.
 * All lengths are meters; the base is 60 x 40 mm, each flange 25 mm tall, 1.5 mm steel.
 */
export const SHEET_BRACKET = {
  thickness: 0.0015,
  kFactor: 0.44,
  radius: 0.002,
  base: 0.06,
  flange: 0.025,
  depth: 0.04,
  foldDegrees: 90,
} as const;

const arc = (cx: number, cy: number, r: number, segments: number): [number, number][] =>
  Array.from({ length: segments }, (_, i) => {
    const a = (2 * Math.PI * i) / segments;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });

const slot = (x0: number, x1: number, y0: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** BA of one 90 degree bend: the neutral-axis length every partial fold keeps. */
export const BRACKET_ALLOWANCE = sheet.bendAllowance(
  90,
  SHEET_BRACKET.radius,
  SHEET_BRACKET.thickness,
  SHEET_BRACKET.kFactor,
);

/**
 * The bracket at `degrees` of fold (default 90). The flat pattern never changes: a partial fold
 * keeps the neutral-axis length of the 90 degree bend, so a smaller angle needs a larger radius.
 */
export function bracketSpec(degrees: number = SHEET_BRACKET.foldDegrees): SheetMetalSpec {
  const { thickness, kFactor, base, flange, depth } = SHEET_BRACKET;
  const ba = BRACKET_ALLOWANCE;
  const half = base / 2;
  const reach = half + ba + flange;
  const bendAt = half + ba / 2;
  const toe = half + ba;
  const radius = (ba * 180) / (Math.PI * degrees) - kFactor * thickness;
  return {
    thickness,
    kFactor,
    outline: {
      outer: [
        [-reach, 0],
        [reach, 0],
        [reach, depth],
        [-reach, depth],
      ],
      holes: [
        arc(0, depth / 2, 0.007, 24),
        slot(toe + 0.006, toe + 0.019, depth / 2 - 0.004, depth / 2 + 0.004),
        slot(-toe - 0.019, -toe - 0.006, depth / 2 - 0.004, depth / 2 + 0.004),
      ],
    },
    bends: [
      { line: [[-bendAt, 0], [-bendAt, depth]], angle: degrees, radius },
      { line: [[bendAt, depth], [bendAt, 0]], angle: degrees, radius },
    ],
  };
}

export function buildSheetBracket(
  degrees: number = SHEET_BRACKET.foldDegrees,
  session: SessionFactory = () => model(),
): Model {
  const m = session('sheet-bracket');
  m.sheet({ ...bracketSpec(degrees), label: 'bracket', tag: 'sheet-metal' });
  m.uv.project({ mode: 'box', scale: 0.05 });
  return m;
}
