import { maxOf, minOf } from './arrays';
import { triangulateLoop } from './geom';
import type { CornerChannelName, EditMesh } from './mesh';
import { orient2d, trianglesOverlap2d } from './predicates';

/**
 * Pairs of different faces whose `channel` triangles overlap in their interiors (exact 2D
 * predicates, sweep over u). A pair is `[low face, high face]`, listed in discovery order of a
 * sweep sorted by the triangles' minimum u; faces missing the channel are skipped.
 */
export function uvOverlapPairs(
  mesh: EditMesh,
  faces: readonly number[],
  channel: CornerChannelName = 'uv0',
): [number, number][] {
  type UvTriangle = { face: number; p: number[][]; lo: number; hi: number };
  const tris: UvTriangle[] = [];
  for (const f of faces) {
    const halves = mesh.faceHalves(f);
    const uvs = halves.map((h) => mesh.corner(channel, h));
    if (uvs.some((uv) => uv === undefined)) continue;
    const indices = triangulateLoop(halves.map((h) => mesh.position(mesh.hVert[h] as number)));
    if (indices === undefined) continue;
    for (let i = 0; i < indices.length; i += 3) {
      const p = [0, 1, 2].map((k) => Array.from(uvs[indices[i + k] as number] as Float32Array));
      const turn = orient2d(
        p[0]?.[0] as number,
        p[0]?.[1] as number,
        p[1]?.[0] as number,
        p[1]?.[1] as number,
        p[2]?.[0] as number,
        p[2]?.[1] as number,
      );
      if (turn === 0) continue;
      if (turn < 0) p.reverse();
      const us = p.map((q) => q[0] as number);
      tris.push({ face: f, p, lo: minOf(us), hi: maxOf(us) });
    }
  }
  tris.sort((a, b) => a.lo - b.lo);
  const seen = new Set<string>();
  const pairs: [number, number][] = [];
  for (let i = 0; i < tris.length; i++) {
    const a = tris[i] as UvTriangle;
    for (let j = i + 1; j < tris.length; j++) {
      const b = tris[j] as UvTriangle;
      if (b.lo >= a.hi) break;
      if (a.face === b.face) continue;
      const lo = Math.min(a.face, b.face);
      const hi = Math.max(a.face, b.face);
      const key = `${lo},${hi}`;
      if (seen.has(key) || !trianglesOverlap2d(a.p, b.p)) continue;
      seen.add(key);
      pairs.push([lo, hi]);
    }
  }
  return pairs;
}
