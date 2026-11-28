import { type CornerChannelName, type EditMesh, FACE_MIRRORED, NONE } from './mesh';

export type MirrorAxis = 0 | 1 | 2;

/**
 * The pairing `Model.mirror` leaves implicit: every face it flagged `FACE_MIRRORED` is the reflection,
 * across one coordinate plane through the origin, of an unflagged face. The pairing is derived from
 * positions, never stored, so a copy that was moved or edited after mirroring is reported in
 * `unpaired` instead of being guessed.
 */
export interface MirrorPairs {
  /** Flagged face -> the unflagged face it reflects and the axis of the reflecting plane. */
  readonly partner: ReadonlyMap<number, { readonly face: number; readonly axis: MirrorAxis }>;
  /** Flagged faces of the set that reflect no unflagged face of the set. */
  readonly unpaired: readonly number[];
  /** Paired faces whose material slot or tag set differs from their partner's. */
  readonly asymmetric: readonly number[];
  /** The vertex a vertex reflects to across `axis`, or undefined when no unflagged face has one there. */
  image(axis: MirrorAxis, vertex: number): number | undefined;
  /** The edge a half-edge of a paired face reflects to, or undefined. */
  edgeImage(half: number): number | undefined;
}

const AXES: readonly MirrorAxis[] = [0, 1, 2];

export function mirrorPairs(
  mesh: EditMesh,
  faces: readonly number[],
  tolerance: number,
): MirrorPairs {
  const inSet = new Set(faces);
  const flagged = (f: number) => ((mesh.fFlags[f] as number) & FACE_MIRRORED) !== 0;
  const copies = faces.filter(flagged).sort((a, b) => a - b);
  const partner = new Map<number, { face: number; axis: MirrorAxis }>();
  const unpaired: number[] = [];
  const asymmetric: number[] = [];
  if (copies.length === 0) {
    return { partner, unpaired, asymmetric, image: () => undefined, edgeImage: () => undefined };
  }
  const cell = 2 * Math.max(tolerance, 1e-12);
  const cellOf = (x: number) => Math.floor(x / cell);
  const buckets = new Map<string, number[]>();
  const seen = new Set<number>();
  for (const f of faces) {
    if (flagged(f)) continue;
    for (const v of mesh.faceVertices(f)) {
      if (seen.has(v)) continue;
      seen.add(v);
      const key = `${cellOf(mesh.pos[v * 3] as number)},${cellOf(mesh.pos[v * 3 + 1] as number)},${cellOf(mesh.pos[v * 3 + 2] as number)}`;
      const list = buckets.get(key);
      if (list === undefined) buckets.set(key, [v]);
      else list.push(v);
    }
  }
  const memo: Map<number, number | undefined>[] = AXES.map(() => new Map());
  const image = (axis: MirrorAxis, vertex: number): number | undefined => {
    const cache = memo[axis] as Map<number, number | undefined>;
    if (cache.has(vertex)) return cache.get(vertex);
    const p = [
      mesh.pos[vertex * 3] as number,
      mesh.pos[vertex * 3 + 1] as number,
      mesh.pos[vertex * 3 + 2] as number,
    ];
    p[axis] = -(p[axis] as number);
    const [cx, cy, cz] = p.map(cellOf) as [number, number, number];
    let best: number | undefined;
    let bestDistance = Infinity;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (let k = -1; k <= 1; k++) {
          for (const v of buckets.get(`${cx + i},${cy + j},${cz + k}`) ?? []) {
            const d = Math.max(
              Math.abs((mesh.pos[v * 3] as number) - (p[0] as number)),
              Math.abs((mesh.pos[v * 3 + 1] as number) - (p[1] as number)),
              Math.abs((mesh.pos[v * 3 + 2] as number) - (p[2] as number)),
            );
            if (
              d <= tolerance &&
              (d < bestDistance || (d === bestDistance && v < (best as number)))
            ) {
              best = v;
              bestDistance = d;
            }
          }
        }
      }
    }
    cache.set(vertex, best);
    return best;
  };
  const sameTags = (f: number, g: number) => {
    for (let w = 0; w < mesh.tagWords; w++) {
      if (mesh.fTags[f * mesh.tagWords + w] !== mesh.fTags[g * mesh.tagWords + w]) return false;
    }
    return true;
  };
  for (const f of copies) {
    const loop = mesh.faceVertices(f);
    let found: { face: number; axis: MirrorAxis } | undefined;
    for (const axis of AXES) {
      const images = loop.map((v) => image(axis, v));
      if (images.some((v) => v === undefined)) continue;
      for (let i = 0; i < loop.length && found === undefined; i++) {
        const half = mesh.findHalf(images[(i + 1) % loop.length] as number, images[i] as number);
        if (half === NONE) continue;
        const g = mesh.hFace[half] as number;
        if (g === NONE || g === f || !inSet.has(g) || flagged(g)) continue;
        const members = new Set(mesh.faceVertices(g));
        if (members.size !== loop.length || !images.every((v) => members.has(v as number)))
          continue;
        found = { face: g, axis };
      }
      if (found !== undefined) break;
    }
    if (found === undefined) unpaired.push(f);
    else {
      partner.set(f, found);
      if (mesh.fMaterial[f] !== mesh.fMaterial[found.face] || !sameTags(f, found.face)) {
        asymmetric.push(f);
      }
    }
  }
  const edgeImage = (half: number): number | undefined => {
    const pair = partner.get(mesh.hFace[half] as number);
    if (pair === undefined) return undefined;
    const a = image(pair.axis, mesh.hVert[half] as number);
    const b = image(pair.axis, mesh.hVert[mesh.hNext[half] as number] as number);
    if (a === undefined || b === undefined) return undefined;
    const twin = mesh.findHalf(b, a);
    return twin === NONE ? undefined : twin >> 1;
  };
  return { partner, unpaired, asymmetric, image, edgeImage };
}

/**
 * Copies get the corner values of the unflagged face they reflect, per paired vertex, moved right by
 * the width of every value in `faces` plus one so no copy corner coincides with an original one: the
 * copy keeps its own island until a pack shares the texels.
 */
export function copyPairedCorners(
  mesh: EditMesh,
  pairs: MirrorPairs,
  faces: readonly number[],
  channel: CornerChannelName,
): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of faces) {
    for (const h of mesh.faceHalves(f)) {
      const value = mesh.corner(channel, h);
      if (value === undefined) continue;
      lo = Math.min(lo, value[0] as number);
      hi = Math.max(hi, value[0] as number);
    }
  }
  const shift = hi >= lo ? hi - lo + 1 : 1;
  for (const [copy, { face, axis }] of pairs.partner) {
    const source = mesh.faceHalves(face);
    for (const h of mesh.faceHalves(copy)) {
      const image = pairs.image(axis, mesh.hVert[h] as number);
      const twin = source.find((s) => mesh.hVert[s] === image);
      const value = twin === undefined ? undefined : mesh.corner(channel, twin);
      if (value === undefined) continue;
      mesh.setCorner(channel, h, [(value[0] as number) + shift, value[1] as number]);
    }
  }
}
