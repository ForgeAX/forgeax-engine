/**
 * The one authority for the leg's lengths, landmarks and widths. Parts and the design drawing
 * read these values; none of them holds a length of its own, so changing a parameter changes
 * every consumer together.
 */
export interface LegParameters {
  /** Hip to ankle, meters. */
  readonly length: number;
  /** Thigh length over shin length (a ladder step; 1.618 is the golden ratio). */
  readonly ratio: number;
  /** Thigh width, meters; the shin tapers from it. */
  readonly width: number;
  /** Shin width over thigh width. */
  readonly taper: number;
}

export const LEG: LegParameters = { length: 0.9, ratio: 1.1, width: 0.16, taper: 0.7 };

/** Landmarks (heights above the ankle plane) and per-part sizes derived from the parameters. */
export interface LegSpec {
  readonly ankle: number;
  readonly knee: number;
  readonly hip: number;
  readonly thigh: { readonly length: number; readonly width: number };
  readonly shin: { readonly length: number; readonly width: number };
}

export function legSpec(p: LegParameters = LEG): LegSpec {
  const thighLength = (p.length * p.ratio) / (1 + p.ratio);
  const shinLength = p.length - thighLength;
  return {
    ankle: 0,
    knee: shinLength,
    hip: p.length,
    thigh: { length: thighLength, width: p.width },
    shin: { length: shinLength, width: p.width * p.taper },
  };
}
