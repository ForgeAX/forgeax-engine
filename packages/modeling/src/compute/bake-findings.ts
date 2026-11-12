import { maxOf, minOf } from '../arrays';
import type { Tuple3 } from '../geom';
import {
  BAKE_CLUSTER_FACES,
  type BakeBounds,
  type BakeClipCluster,
  type BakeStrayCluster,
} from './job';

/**
 * Located bake findings (cage clips, samples on hovering parts), kept as additive records so
 * Worker parts merge by key in any order: the counts add, the worst distance is a maximum and
 * the bounds are a min and a max, each independent of the merge order.
 */
export const FINDING_KIND = { above: 0, below: 1, stray: 2 } as const;

/** kind, group, cell x y z (stray: part, 0, 0), base face, detail face (stray: -1), count, worst, bounds min xyz, max xyz. */
export const FINDING_WIDTH = 15;

/** A hovering detail part's static facts (audit A3). */
export interface StrayPart {
  readonly gap: number;
  readonly bounds: BakeBounds;
  /** Detail faces of the part, ascending. */
  readonly faces: readonly number[];
}

/** Grid cells per diagonal: clipped base samples in adjacent cells belong to one feature. */
const CELLS_PER_DIAGONAL = 32;

export class FindingLog {
  private readonly rows = new Map<string, number[]>();
  private readonly cell: number;

  constructor(diagonal: number) {
    this.cell = diagonal / CELLS_PER_DIAGONAL;
  }

  /** A clipped base sample at P: `excess` m of detail beyond the cage, lost on `detailFace`. */
  clip(
    group: number,
    kind: typeof FINDING_KIND.above | typeof FINDING_KIND.below,
    p: Tuple3,
    baseFace: number,
    detailFace: number,
    excess: number,
  ): void {
    const cell = [0, 1, 2].map((c) => Math.floor((p[c] as number) / this.cell));
    this.add(
      [kind, group, cell[0] as number, cell[1] as number, cell[2] as number, baseFace, detailFace],
      excess,
      p,
    );
  }

  /** A base sample whose correspondence landed on hovering part `part`. */
  stray(group: number, part: number, baseFace: number): void {
    this.add([FINDING_KIND.stray, group, part, 0, 0, baseFace, -1], 0, [0, 0, 0]);
  }

  private add(key: readonly number[], worst: number, p: Tuple3): void {
    const id = key.join(',');
    const row = this.rows.get(id);
    if (row === undefined) {
      this.rows.set(id, [...key, 1, worst, ...p, ...p]);
      return;
    }
    row[7] = (row[7] as number) + 1;
    row[8] = Math.max(row[8] as number, worst);
    for (let c = 0; c < 3; c++) {
      row[9 + c] = Math.min(row[9 + c] as number, p[c] as number);
      row[12 + c] = Math.max(row[12 + c] as number, p[c] as number);
    }
  }

  /** The records since the last call, in key order, and clear them. */
  drain(): Float64Array {
    const rows = [...this.rows.values()].sort(compareKeys);
    this.rows.clear();
    return Float64Array.from(rows.flat());
  }
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 7; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/** Records of any number of parts merged by key, in key order. */
export function mergeFindings(parts: readonly Float64Array[]): number[][] {
  const merged = new Map<string, number[]>();
  for (const part of parts) {
    for (let at = 0; at < part.length; at += FINDING_WIDTH) {
      const row = Array.from(part.subarray(at, at + FINDING_WIDTH));
      const id = row.slice(0, 7).join(',');
      const into = merged.get(id);
      if (into === undefined) {
        merged.set(id, row);
        continue;
      }
      into[7] = (into[7] as number) + (row[7] as number);
      into[8] = Math.max(into[8] as number, row[8] as number);
      for (let c = 0; c < 3; c++) {
        into[9 + c] = Math.min(into[9 + c] as number, row[9 + c] as number);
        into[12 + c] = Math.max(into[12 + c] as number, row[12 + c] as number);
      }
    }
  }
  return [...merged.values()].sort(compareKeys);
}

function listed(ids: Iterable<number>): { list: number[]; count: number } {
  const all = [...new Set(ids)].sort((a, b) => a - b);
  return { list: all.slice(0, BAKE_CLUSTER_FACES), count: all.length };
}

/** Connected components of the records' grid cells (26-neighbourhood): record indices per component. */
function components(rows: readonly (readonly number[])[]): number[][] {
  const cellOf = new Map<string, number>();
  const parent: number[] = [];
  for (const row of rows) {
    const id = `${row[2]},${row[3]},${row[4]}`;
    if (!cellOf.has(id)) {
      cellOf.set(id, parent.length);
      parent.push(parent.length);
    }
  }
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r] as number;
    return r;
  };
  for (const [id, a] of cellOf) {
    const [x, y, z] = id.split(',').map(Number) as [number, number, number];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const b = cellOf.get(`${x + dx},${y + dy},${z + dz}`);
          if (b !== undefined && find(a) !== find(b)) parent[find(b)] = find(a);
        }
  }
  const byRoot = new Map<number, number[]>();
  for (const [i, row] of rows.entries()) {
    const root = find(cellOf.get(`${row[2]},${row[3]},${row[4]}`) as number);
    const list = byRoot.get(root);
    if (list === undefined) byRoot.set(root, [i]);
    else list.push(i);
  }
  return [...byRoot.values()];
}

/** The cage-clip clusters of one group, most samples first. */
export function clipClusters(
  merged: readonly (readonly number[])[],
  group: number,
): BakeClipCluster[] {
  const clusters: BakeClipCluster[] = [];
  for (const kind of [FINDING_KIND.above, FINDING_KIND.below]) {
    const rows = merged.filter((r) => r[0] === kind && r[1] === group);
    for (const members of components(rows)) {
      const own = members.map((i) => rows[i] as readonly number[]);
      const min = [0, 1, 2].map((c) => minOf(own.map((r) => r[9 + c] as number)));
      const max = [0, 1, 2].map((c) => maxOf(own.map((r) => r[12 + c] as number)));
      const base = listed(own.map((r) => r[5] as number));
      const detail = listed(own.map((r) => r[6] as number));
      clusters.push({
        side: kind === FINDING_KIND.above ? 'above' : 'below',
        samples: own.reduce((n, r) => n + (r[7] as number), 0),
        worst: maxOf(own.map((r) => r[8] as number)),
        bounds: { min: min as unknown as Tuple3, max: max as unknown as Tuple3 },
        baseFaces: base.list,
        baseFaceCount: base.count,
        detailFaces: detail.list,
        detailFaceCount: detail.count,
      });
    }
  }
  return clusters.sort(
    (a, b) =>
      b.samples - a.samples ||
      a.bounds.min[0] - b.bounds.min[0] ||
      a.bounds.min[1] - b.bounds.min[1] ||
      a.bounds.min[2] - b.bounds.min[2] ||
      (a.side < b.side ? -1 : a.side > b.side ? 1 : 0),
  );
}

/** The clusters of one group's hovering parts that caught samples, in part order. */
export function strayClusters(
  merged: readonly (readonly number[])[],
  group: number,
  parts: readonly StrayPart[],
): BakeStrayCluster[] {
  const clusters: BakeStrayCluster[] = [];
  for (const [part, info] of parts.entries()) {
    const rows = merged.filter(
      (r) => r[0] === FINDING_KIND.stray && r[1] === group && r[2] === part,
    );
    if (rows.length === 0) continue;
    const base = listed(rows.map((r) => r[5] as number));
    const detail = listed(info.faces);
    clusters.push({
      part,
      samples: rows.reduce((n, r) => n + (r[7] as number), 0),
      gap: info.gap,
      bounds: info.bounds,
      baseFaces: base.list,
      baseFaceCount: base.count,
      detailFaces: detail.list,
      detailFaceCount: detail.count,
    });
  }
  return clusters;
}
