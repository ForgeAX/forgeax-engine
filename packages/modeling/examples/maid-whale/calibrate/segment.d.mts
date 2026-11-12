export type ColorClass = 'bg' | 'white' | 'skin' | 'navy' | 'hair' | 'light' | 'gold' | 'gem' | 'dark' | 'other';
export const CAPTION_ROW: number;
export const CLASSES: readonly ColorClass[];
export function hsv(r: number, g: number, b: number): [number, number, number];
export function classify(r: number, g: number, b: number): ColorClass;
export function cleanMask(
  fg: Uint8Array,
  width: number,
  height: number,
  options?: { minIsland?: number; maxHole?: number },
): Uint8Array;
export function traceOutline(
  mask: Uint8Array,
  width: number,
  height: number,
  columns: readonly [number, number],
): { points: [number, number][]; area: number };
export function simplifyClosed(points: readonly (readonly [number, number])[], tolerance: number): [number, number][];
export function polygonArea(points: readonly (readonly [number, number])[]): number;
export function srgbToLinear(v: number): number;
