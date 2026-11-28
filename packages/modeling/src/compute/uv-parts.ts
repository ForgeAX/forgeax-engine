import { maxOf, minOf } from '../arrays';
import type { EditMesh } from '../mesh';
import { NONE } from '../mesh';

/** Part density multipliers as the pack job takes them: tag and multiplier, sorted by tag. */
export type PartList = readonly (readonly [string, number])[];

/**
 * `PackOptions.density.parts` as a sorted pair list (equal records give equal job params and
 * cache keys). An empty table is no table: it packs, reports and caches like `undefined`.
 */
export function partList(
  parts: Readonly<Record<string, number>> | undefined,
): PartList | undefined {
  if (parts === undefined || Object.keys(parts).length === 0) return undefined;
  return Object.entries(parts)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([tag, multiplier]) => [tag, multiplier] as const);
}

/** Largest ratio between two island densities of one table (unlisted islands count as 1). */
export const MAX_PART_RATIO = 64;

/**
 * Every tag is a non-empty name and every multiplier a finite number above zero, and the
 * multipliers (with the base 1 of unlisted islands) span at most `MAX_PART_RATIO`: a wider
 * table would collapse an island below a texel.
 */
export function validParts(parts: PartList): boolean {
  return (
    parts.every(
      ([tag, m]) => typeof tag === 'string' && tag.length > 0 && Number.isFinite(m) && m > 0,
    ) &&
    Math.max(1, maxOf(parts.map(([, m]) => m))) / Math.min(1, minOf(parts.map(([, m]) => m))) <=
      MAX_PART_RATIO
  );
}

/** Tag ids of the listed parts in `mesh` (-1 for a tag no face carries). */
export function partTagIds(mesh: EditMesh, parts: PartList): number[] {
  return parts.map(([tag]) => mesh.tagIndex(tag, false));
}

/**
 * The part of an island: the listed tag most of its faces carry (the smallest tag on a tie,
 * the list length when no face carries one), and whether faces of several parts share it.
 */
export function partOfFaces(
  mesh: EditMesh,
  faces: readonly number[],
  ids: readonly number[],
): { readonly part: number; readonly mixed: boolean } {
  let best = ids.length;
  let most = 0;
  let present = 0;
  for (const [k, id] of ids.entries()) {
    if (id < 0) continue;
    let count = 0;
    for (const f of faces) if (mesh.hasTag(f, id)) count++;
    if (count > 0) present++;
    if (count > most) {
      most = count;
      best = k;
    }
  }
  return { part: best, mixed: present > 1 };
}

/** What `uv.pack` and `validate` need of a UV measurement to attribute islands to parts. */
export interface IslandAreas {
  readonly faceIsland: Int32Array;
  readonly islands: readonly { readonly area3d: number; readonly areaUv: number }[];
}

export interface IslandParts {
  /** Part index per island (the list length: no part). */
  readonly part: readonly number[];
  /** Islands carrying faces of more than one part. */
  readonly mixed: number;
}

/** Part of every measured island. */
export function islandParts(mesh: EditMesh, measured: IslandAreas, parts: PartList): IslandParts {
  const ids = partTagIds(mesh, parts);
  const faces: number[][] = measured.islands.map(() => []);
  for (const f of mesh.faces()) {
    const island = measured.faceIsland[f] as number;
    if (island !== NONE) (faces[island] as number[]).push(f);
  }
  let mixed = 0;
  const part = faces.map((list) => {
    const found = partOfFaces(mesh, list, ids);
    if (found.mixed) mixed++;
    return found.part;
  });
  return { part, mixed };
}

/** Texel density of the islands of one part (`part: null`: islands of no listed part). */
export interface PartDensity {
  readonly part: string | null;
  readonly multiplier: number;
  readonly islands: number;
  readonly area3d: number;
  readonly texelsPerMeter: number;
}

/** Density table of `parts` (plus the unlisted islands last), from a complete UV measurement. */
export function partDensities(
  mesh: EditMesh,
  measured: IslandAreas,
  parts: PartList,
  resolution: number,
): { readonly rows: PartDensity[]; readonly mixed: number } {
  const owner = islandParts(mesh, measured, parts);
  const sums = Array.from({ length: parts.length + 1 }, () => ({ n: 0, a3: 0, au: 0 }));
  for (const [i, x] of measured.islands.entries()) {
    const s = sums[owner.part[i] as number] as { n: number; a3: number; au: number };
    s.n++;
    s.a3 += x.area3d;
    s.au += x.areaUv;
  }
  const rows = sums.map((s, k): PartDensity => {
    const listed = parts[k];
    return {
      part: listed === undefined ? null : listed[0],
      multiplier: listed === undefined ? 1 : listed[1],
      islands: s.n,
      area3d: s.a3,
      texelsPerMeter: s.a3 > 0 ? resolution * Math.sqrt(s.au / s.a3) : 0,
    };
  });
  return { rows: rows.filter((r) => r.part !== null || r.islands > 0), mixed: owner.mixed };
}
