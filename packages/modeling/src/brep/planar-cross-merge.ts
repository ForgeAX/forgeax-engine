import { pushAll } from '../arrays';
import { cross3, dot3, len3, type P3, sub3 } from './vec';

/** One kept arrangement cell: a vertex-id ring (counter-clockwise about the group's plane normal). */
export interface KeptCell {
  readonly group: number;
  readonly ring: readonly number[];
}

/** One output face region of a group: an outer ring plus the hole rings it contains. */
export interface MergedRegion {
  readonly group: number;
  readonly outer: readonly number[];
  readonly holes: readonly (readonly number[])[];
}

export interface MergeInput {
  readonly cells: readonly KeptCell[];
  readonly position: (id: number) => P3;
  readonly normalOf: (group: number) => P3;
}

function ringArea(ring: readonly number[], position: (id: number) => P3, normal: P3): number {
  const origin = position(ring[0] as number);
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = sub3(position(ring[i] as number), origin);
    const q = sub3(position(ring[(i + 1) % ring.length] as number), origin);
    s += dot3(normal, cross3(p, q));
  }
  return s / 2;
}

function containsPoint(
  ring: readonly number[],
  point: P3,
  position: (id: number) => P3,
  normal: P3,
): boolean {
  const [nx, ny, nz] = [Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2])];
  const project = (q: P3): [number, number] =>
    nx >= ny && nx >= nz ? [q[1], q[2]] : ny >= nz ? [q[2], q[0]] : [q[0], q[1]];
  const [pu, pv] = project(point);
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [au, av] = project(position(ring[i] as number));
    const [bu, bv] = project(position(ring[j] as number));
    if (av > pv !== bv > pv && pu < ((bu - au) * (pv - av)) / (bv - av) + au) inside = !inside;
  }
  return inside;
}

/** Merge the cells of one group by cancelling shared edges; null when the result is not clean. */
function mergeGroup(
  group: number,
  rings: readonly (readonly number[])[],
  position: (id: number) => P3,
  normal: P3,
): MergedRegion[] | null {
  const directed = new Set<string>();
  for (const ring of rings) {
    if (new Set(ring).size !== ring.length) return null;
    for (let i = 0; i < ring.length; i++) {
      const key = `${ring[i]}>${ring[(i + 1) % ring.length]}`;
      if (directed.has(key)) return null;
      directed.add(key);
    }
  }
  const next = new Map<number, number>();
  for (const key of directed) {
    const [a, b] = key.split('>').map(Number) as [number, number];
    if (directed.has(`${b}>${a}`)) continue;
    if (next.has(a)) return null;
    next.set(a, b);
  }
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let at = start;
    while (!seen.has(at)) {
      seen.add(at);
      loop.push(at);
      const following = next.get(at);
      if (following === undefined) return null;
      at = following;
    }
    if (at !== start || loop.length < 3) return null;
    loops.push(loop);
  }
  const outers: { ring: number[]; area: number; holes: number[][] }[] = [];
  const holes: { ring: number[]; area: number }[] = [];
  for (const ring of loops) {
    const area = ringArea(ring, position, normal);
    if (area > 0) outers.push({ ring, area, holes: [] });
    else if (area < 0) holes.push({ ring, area });
    else return null;
  }
  for (const hole of holes) {
    const probe = position(hole.ring[0] as number);
    const hosts = outers
      .filter((outer) => containsPoint(outer.ring, probe, position, normal))
      .sort((x, y) => x.area - y.area);
    const host = hosts[0];
    if (host === undefined) return null;
    host.holes.push(hole.ring);
  }
  if (outers.length === 0) return null;
  return outers.map((outer) => ({ group, outer: outer.ring, holes: outer.holes }));
}

function straight(a: P3, v: P3, b: P3, band: number): boolean {
  const edge = sub3(b, a);
  const length = len3(edge);
  if (length === 0) return false;
  const offset = len3(cross3(edge, sub3(v, a))) / length;
  return offset <= band && dot3(sub3(v, a), sub3(b, v)) > 0;
}

/**
 * Merge, per group, the kept coplanar cells into outer rings with their holes, then drop every
 * vertex that is exactly collinear in all rings that use it. A group whose cells do not merge to
 * clean simple loops (a pinch, a repeated edge, an unplaceable hole) keeps its cells unmerged.
 */
export function mergeCoplanarCells(input: MergeInput): MergedRegion[] {
  const { cells, position, normalOf } = input;
  const byGroup = new Map<number, (readonly number[])[]>();
  for (const cell of cells)
    byGroup.set(cell.group, [...(byGroup.get(cell.group) ?? []), cell.ring]);

  const regions: MergedRegion[] = [];
  for (const [group, rings] of byGroup) {
    const merged = mergeGroup(group, rings, position, normalOf(group));
    if (merged !== null) pushAll(regions, merged);
    else for (const ring of rings) regions.push({ group, outer: ring, holes: [] });
  }

  let scale = 1;
  const allRings = regions.flatMap((region) => [region.outer, ...region.holes]);
  for (const ring of allRings) {
    for (const id of ring) {
      const p = position(id);
      scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
    }
  }
  const band = Number.EPSILON * scale * 64;
  const corners = new Set<number>();
  for (const ring of allRings) {
    for (let i = 0; i < ring.length; i++) {
      const id = ring[i] as number;
      const a = position(ring[(i + ring.length - 1) % ring.length] as number);
      const b = position(ring[(i + 1) % ring.length] as number);
      if (!straight(a, position(id), b, band)) corners.add(id);
    }
  }
  const trim = (ring: readonly number[]): number[] => ring.filter((id) => corners.has(id));
  const trimmed = regions.map((region) => ({
    group: region.group,
    outer: trim(region.outer),
    holes: region.holes.map(trim),
  }));
  const degenerate = trimmed.some(
    (region) => region.outer.length < 3 || region.holes.some((hole) => hole.length < 3),
  );
  return degenerate ? regions : trimmed;
}
