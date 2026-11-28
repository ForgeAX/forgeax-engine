import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from './errors';

/*
 * Standards facts as exact millimetre literals: [major diameter, pitch, tap drill].
 * Metric rows are ISO 261 coarse with tap drill = major - pitch. UNC/UNF rows are ASME B1.1
 * (major = 0.060 in + 0.013 in per number size, pitch = 25.4 mm / TPI, tap drill = major - 0.9743 P
 * for 75 % engagement). G/Rp rows are ISO 228-1 / ISO 7-1 parallel pipe threads, whose tap drill is
 * the minor diameter (major - 1.280654 P).
 */
const METRIC_COARSE = {
  'M1.6': [1.6, 0.35, 1.25],
  M2: [2, 0.4, 1.6],
  'M2.5': [2.5, 0.45, 2.05],
  M3: [3, 0.5, 2.5],
  'M3.5': [3.5, 0.6, 2.9],
  M4: [4, 0.7, 3.3],
  M5: [5, 0.8, 4.2],
  M6: [6, 1, 5],
  M8: [8, 1.25, 6.75],
  M10: [10, 1.5, 8.5],
  M12: [12, 1.75, 10.25],
  M14: [14, 2, 12],
  M16: [16, 2, 14],
  M18: [18, 2.5, 15.5],
  M20: [20, 2.5, 17.5],
  M22: [22, 2.5, 19.5],
  M24: [24, 3, 21],
  M27: [27, 3, 24],
  M30: [30, 3.5, 26.5],
  M33: [33, 3.5, 29.5],
  M36: [36, 4, 32],
  M39: [39, 4, 35],
  M42: [42, 4.5, 37.5],
  M45: [45, 4.5, 40.5],
  M48: [48, 5, 43],
  M52: [52, 5, 47],
  M56: [56, 5.5, 50.5],
  M60: [60, 5.5, 54.5],
  M64: [64, 6, 58],
} as const;
const UNC_ROWS = {
  '#2-56': [2.1844, 0.453571, 1.742],
  '#3-48': [2.5146, 0.529167, 1.999],
  '#4-40': [2.8448, 0.635, 2.226],
  '#5-40': [3.175, 0.635, 2.556],
  '#6-32': [3.5052, 0.79375, 2.732],
  '#8-32': [4.1656, 0.79375, 3.392],
  '#10-24': [4.826, 1.058333, 3.795],
  '#12-24': [5.4864, 1.058333, 4.455],
  '1/4-20': [6.35, 1.27, 5.113],
  '5/16-18': [7.9375, 1.411111, 6.563],
  '3/8-16': [9.525, 1.5875, 7.978],
  '7/16-14': [11.1125, 1.814286, 9.345],
  '1/2-13': [12.7, 1.953846, 10.796],
  '9/16-12': [14.2875, 2.116667, 12.225],
  '5/8-11': [15.875, 2.309091, 13.625],
  '3/4-10': [19.05, 2.54, 16.575],
  '7/8-9': [22.225, 2.822222, 19.475],
  '1-8': [25.4, 3.175, 22.307],
  '1-1/8-7': [28.575, 3.628571, 25.04],
  '1-1/4-7': [31.75, 3.628571, 28.215],
  '1-3/8-6': [34.925, 4.233333, 30.8],
  '1-1/2-6': [38.1, 4.233333, 33.975],
} as const;
const UNF_ROWS = {
  '#2-64': [2.1844, 0.396875, 1.798],
  '#3-56': [2.5146, 0.453571, 2.073],
  '#4-48': [2.8448, 0.529167, 2.329],
  '#5-44': [3.175, 0.577273, 2.613],
  '#6-40': [3.5052, 0.635, 2.887],
  '#8-36': [4.1656, 0.705556, 3.478],
  '#10-32': [4.826, 0.79375, 4.053],
  '#12-28': [5.4864, 0.907143, 4.603],
  '1/4-28': [6.35, 0.907143, 5.466],
  '5/16-24': [7.9375, 1.058333, 6.906],
  '3/8-24': [9.525, 1.058333, 8.494],
  '7/16-20': [11.1125, 1.27, 9.875],
  '1/2-20': [12.7, 1.27, 11.463],
  '9/16-18': [14.2875, 1.411111, 12.913],
  '5/8-18': [15.875, 1.411111, 14.5],
  '3/4-16': [19.05, 1.5875, 17.503],
  '7/8-14': [22.225, 1.814286, 20.457],
  '1-12': [25.4, 2.116667, 23.338],
  '1-1/8-12': [28.575, 2.116667, 26.513],
  '1-1/4-12': [31.75, 2.116667, 29.688],
  '1-3/8-12': [34.925, 2.116667, 32.863],
  '1-1/2-12': [38.1, 2.116667, 36.038],
} as const;
const PIPE_ROWS = {
  '1/16': [7.723, 0.907143, 6.561],
  '1/8': [9.728, 0.907143, 8.566],
  '1/4': [13.157, 1.336842, 11.445],
  '3/8': [16.662, 1.336842, 14.95],
  '1/2': [20.955, 1.814286, 18.632],
  '5/8': [22.911, 1.814286, 20.588],
  '3/4': [26.441, 1.814286, 24.118],
  '7/8': [30.201, 1.814286, 27.878],
  '1': [33.249, 2.309091, 30.292],
  '1-1/8': [37.897, 2.309091, 34.94],
  '1-1/4': [41.91, 2.309091, 38.953],
  '1-3/8': [44.323, 2.309091, 41.366],
  '1-1/2': [47.803, 2.309091, 44.846],
  '1-3/4': [53.746, 2.309091, 50.789],
  '2': [59.614, 2.309091, 56.657],
  '2-1/4': [65.71, 2.309091, 62.753],
  '2-1/2': [75.184, 2.309091, 72.227],
  '2-3/4': [81.534, 2.309091, 78.577],
  '3': [87.884, 2.309091, 84.927],
  '3-1/2': [100.33, 2.309091, 97.373],
  '4': [113.03, 2.309091, 110.073],
} as const;

type PipeSize = keyof typeof PIPE_ROWS;

export type ThreadFamily = 'metric' | 'unc' | 'unf' | 'g' | 'rp';

/** A catalogue key: `M8`, `1/4-20` (UNC), `1/4-28` (UNF), `#10-32`, `G1/8`, `Rp1/8`. */
export type ThreadDesignation =
  | keyof typeof METRIC_COARSE
  | keyof typeof UNC_ROWS
  | keyof typeof UNF_ROWS
  | `G${PipeSize}`
  | `Rp${PipeSize}`;

export interface ThreadSpec {
  readonly family: ThreadFamily;
  readonly designation: ThreadDesignation;
  /** Major diameter (meters). */
  readonly major: number;
  /** Pitch (meters). */
  readonly pitch: number;
  /** Tap drill diameter (meters): the bore a tapped hole starts from. */
  readonly tapDrill: number;
  /** Flank angle in degrees: 60 for metric and unified, 55 for G and Rp. */
  readonly flankAngle: 55 | 60;
}

type Row = readonly [number, number, number];

function spec(
  family: ThreadFamily,
  designation: ThreadDesignation,
  [major, pitch, tapDrill]: Row,
): ThreadSpec {
  return {
    family,
    designation,
    major: major / 1000,
    pitch: pitch / 1000,
    tapDrill: tapDrill / 1000,
    flankAngle: family === 'g' || family === 'rp' ? 55 : 60,
  };
}

function find(designation: string): ThreadSpec | undefined {
  const own = (table: Readonly<Record<string, Row>>, key: string): Row | undefined =>
    Object.hasOwn(table, key) ? table[key] : undefined;
  const metric = own(METRIC_COARSE, designation);
  if (metric !== undefined) return spec('metric', designation as ThreadDesignation, metric);
  const unc = own(UNC_ROWS, designation);
  if (unc !== undefined) return spec('unc', designation as ThreadDesignation, unc);
  const unf = own(UNF_ROWS, designation);
  if (unf !== undefined) return spec('unf', designation as ThreadDesignation, unf);
  for (const [prefix, family] of [
    ['Rp', 'rp'],
    ['G', 'g'],
  ] as const) {
    if (!designation.startsWith(prefix)) continue;
    const row = own(PIPE_ROWS, designation.slice(prefix.length));
    if (row !== undefined) return spec(family, designation as ThreadDesignation, row);
  }
  return undefined;
}

/** @internal The spec of a designation the type system already admits. */
export function specOf(designation: ThreadDesignation): ThreadSpec {
  return find(designation) as ThreadSpec;
}

export const threads = {
  /** The facts of one designation; an unknown one is `model-invalid-argument`. */
  lookup(designation: ThreadDesignation): Result<ThreadSpec, ModelingError> {
    const found = find(designation);
    if (found === undefined) {
      return err(
        modelingError(
          'model-invalid-argument',
          'thread is a catalogue designation',
          {
            option: 'thread',
            value: designation,
            expected: 'a ThreadDesignation, see threads.all()',
          },
          'use threads.all() to list the designations',
        ),
      );
    }
    return ok(found);
  },
  /** Every designation, metric first, then UNC, UNF, G and Rp, each in table order. */
  all(): readonly ThreadDesignation[] {
    return [
      ...(Object.keys(METRIC_COARSE) as ThreadDesignation[]),
      ...(Object.keys(UNC_ROWS) as ThreadDesignation[]),
      ...(Object.keys(UNF_ROWS) as ThreadDesignation[]),
      ...(Object.keys(PIPE_ROWS).map((k) => `G${k}`) as ThreadDesignation[]),
      ...(Object.keys(PIPE_ROWS).map((k) => `Rp${k}`) as ThreadDesignation[]),
    ];
  },
} as const;
