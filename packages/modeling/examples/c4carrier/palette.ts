import type { Rgb } from '../case/render.ts';

/** Slots of the heavy turret: armor paint over gunmetal and blued steel (render colors, linear-ish display values). */
export const SLOT_COLORS = {
  Default: [0.5, 0.52, 0.55],
  armor: [0.4, 0.43, 0.47],
  plate: [0.32, 0.35, 0.4],
  trim: [0.55, 0.57, 0.6],
  frame: [0.16, 0.17, 0.19],
  steel: [0.5, 0.5, 0.54],
  barrel: [0.3, 0.31, 0.34],
  vent: [0.07, 0.075, 0.09],
  marking: [0.86, 0.86, 0.82],
  glass: [0.04, 0.09, 0.12],
  hazard: [0.78, 0.5, 0.06],
  highlight: [0.95, 0.2, 0.55],
} as const satisfies Record<string, Rgb>;

export const METALLIC: readonly string[] = ['steel', 'barrel', 'frame', 'trim'];
