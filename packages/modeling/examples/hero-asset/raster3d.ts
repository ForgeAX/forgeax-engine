// Software rasterizer for the checker-on-mesh render: depth-tested triangles, checker sampled through uv0.
// Orthographic, flat-lit. Seam overlay is drawn by the caller where needed.
import { EDGE_SEAM, type EditMesh } from '../../src/mesh.ts';
import { createImage, type Image, type RGB, setPixel } from '../brep-kit/image.ts';

type V3 = readonly [number, number, number];

export interface View3 {
  readonly name: string;
  readonly dir: V3; // direction towards the viewer
}
export const VIEWS3: readonly View3[] = [
  { name: 'iso', dir: [0.6, -0.7, 0.6] },
  { name: 'front', dir: [0, -1, 0] },
  { name: 'top', dir: [0, 0, 1] },
];

const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v: V3): V3 => {
  const l = Math.sqrt(dot3(v, v)) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

const SEAM_PX = 0.02;

export function raster3d(mesh: EditMesh, view: View3, size: number): Image {
  const d = norm(view.dir);
  // Camera basis: right = up0 x d, up = d x right (up0 = world z unless the view is top-down).
  const up0: V3 = Math.abs(d[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  const right = norm(cross(up0, d));
  const up = norm(cross(d, right));
  const proj = (p: V3): V3 => [dot3(p, right), dot3(p, up), dot3(p, d)];
  const pts: V3[] = [];
  for (const v of mesh.vertices()) {
    const p = mesh.position(v);
    const q = proj([p[0], p[1], p[2]]);
    pts.push(q);
  }
  let loX = Infinity;
  let loY = Infinity;
  let hiX = -Infinity;
  let hiY = -Infinity;
  for (const [x, y] of pts) {
    loX = Math.min(loX, x);
    loY = Math.min(loY, y);
    hiX = Math.max(hiX, x);
    hiY = Math.max(hiY, y);
  }
  const span = Math.max(hiX - loX, hiY - loY) * 1.08;
  const cx = (loX + hiX) / 2;
  const cy = (loY + hiY) / 2;
  const s = size / span;
  const screen = (p: V3): V3 => [size / 2 + (p[0] - cx) * s, size / 2 - (p[1] - cy) * s, p[2]];
  const img = createImage(size, size, [18, 20, 28]);
  const depth = new Float32Array(size * size).fill(Infinity);
  const light = norm([0.4, -0.5, 0.8]);
  const checkerRGB = (u: number, v: number): RGB =>
    (Math.floor(u * 32) + Math.floor(v * 32)) % 2 === 0 ? [230, 200, 90] : [40, 60, 110];
  // Seam edges (uv seams) keyed by vertex pair, drawn over the checker as red lines.
  const seamKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const seamSet = new Set<string>();
  for (const e of mesh.edges()) {
    if (((mesh.eFlags[e] as number) & EDGE_SEAM) === 0) continue;
    const [p, q] = mesh.edgeVertices(e);
    seamSet.add(seamKey(p, q));
  }
  for (const f of mesh.faces()) {
    const verts = mesh.faceVertices(f);
    const halves = mesh.faceHalves(f);
    const P: V3[] = verts.map((v) => {
      const p = mesh.position(v);
      return [p[0], p[1], p[2]];
    });
    const UV: [number, number][] = halves.map((h) => {
      const c = mesh.corner('uv0', h) as Float32Array | undefined;
      return c === undefined ? [0, 0] : [c[0] as number, c[1] as number];
    });
    if (P.length < 3) continue;
    const [p0, p1, p2] = [P[0], P[1], P[2]] as [V3, V3, V3];
    const n = norm(cross(sub(p1, p0), sub(p2, p0)));
    const shade = Math.max(0.25, Math.abs(dot3(n, light)));
    const S: V3[] = P.map((p) => screen(proj(p)));
    for (let t = 1; t + 1 < S.length; t++) {
      const [a, b, c] = [S[0], S[t], S[t + 1]] as [V3, V3, V3];
      const [va, vb, vc] = [verts[0], verts[t], verts[t + 1]] as [number, number, number];
      const triSeam: [boolean, boolean, boolean] = [
        seamSet.has(seamKey(vb, vc)),
        seamSet.has(seamKey(vc, va)),
        seamSet.has(seamKey(va, vb)),
      ];
      const [ua, ub, uc] = [UV[0], UV[t], UV[t + 1]] as [
        [number, number],
        [number, number],
        [number, number],
      ];
      const [ax, ay, az] = a;
      const [bx, by, bz] = b;
      const [cx3, cy3, cz] = c;
      const den = (by - cy3) * (ax - cx3) + (cx3 - bx) * (ay - cy3);
      if (Math.abs(den) < 1e-12) continue;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx3)));
      const x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx3)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy3)));
      const y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy3)));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const w1 = ((by - cy3) * (x - cx3) + (cx3 - bx) * (y - cy3)) / den;
          const w2 = ((cy3 - ay) * (x - cx3) + (ax - cx3) * (y - cy3)) / den;
          const w3 = 1 - w1 - w2;
          if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
          const z = az * w1 + bz * w2 + cz * w3;
          const k = y * size + x;
          if (z >= (depth[k] as number)) continue;
          depth[k] = z;
          const u = ua[0] * w1 + ub[0] * w2 + uc[0] * w3;
          const v = ua[1] * w1 + ub[1] * w2 + uc[1] * w3;
          const col = checkerRGB(u, v);
          const onSeam =
            (w1 < SEAM_PX && triSeam[0]) ||
            (w2 < SEAM_PX && triSeam[1]) ||
            (w3 < SEAM_PX && triSeam[2]);
          if (onSeam) {
            setPixel(img, x, y, [230, 40, 40]);
            continue;
          }
          setPixel(img, x, y, [col[0] * shade, col[1] * shade, col[2] * shade] as RGB);
        }
    }
  }
  return img;
}

// Lit path over an exported MeshAsset: the same orthographic framing for every picture (framing is fixed by the
// caller's reference bounds), Lambert shading with per-pixel normals. With a normal map the tangent frame is the
// exported tangent (xyz, handedness w) with B = cross(N, T) * w, exactly the frame the bake encodes against.
export interface LitMap {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array; // linear tangent-space normal map, level 0, row 0 = v 0
}

export interface LitMesh {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly tangent?: Float32Array;
  readonly uv?: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
}

export interface LitFrame {
  readonly min: V3;
  readonly max: V3;
}

/** Framing bounds of a mesh, used to keep several renders at the same scale. */
export function litFrame(positions: Float32Array): LitFrame {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const x = positions[i + k] as number;
      min[k] = Math.min(min[k] as number, x);
      max[k] = Math.max(max[k] as number, x);
    }
  return { min: [min[0] as number, min[1] as number, min[2] as number], max: [max[0] as number, max[1] as number, max[2] as number] };
}

export function rasterLit(
  mesh: LitMesh,
  view: View3,
  size: number,
  frame: LitFrame,
  map?: LitMap,
): Image {
  return rasterLitPicture(mesh, view, size, frame, map === undefined ? {} : { map }).image;
}

export interface LitOptions {
  readonly map?: LitMap;
  /** Linear RGB albedo per triangle (3 floats each); default one warm grey. */
  readonly albedo?: Float32Array;
}

/** A lit picture with its silhouette: mask 1 where a triangle covers the pixel. */
export interface LitPicture {
  readonly image: Image;
  readonly mask: Uint8Array;
}

/** Mean absolute RGB difference (0..255) of `other` against `reference` over the reference silhouette. */
export function meanAbsDiff(reference: LitPicture, other: LitPicture): number {
  const a = reference.image.rgba;
  const b = other.image.rgba;
  let sum = 0;
  let n = 0;
  for (let k = 0; k < reference.mask.length; k++) {
    if (reference.mask[k] === 0) continue;
    for (let c = 0; c < 3; c++) sum += Math.abs((a[k * 4 + c] as number) - (b[k * 4 + c] as number));
    n++;
  }
  return n === 0 ? 0 : sum / (3 * n);
}

export function rasterLitPicture(
  mesh: LitMesh,
  view: View3,
  size: number,
  frame: LitFrame,
  options: LitOptions,
): LitPicture {
  const map = options.map;
  const d = norm(view.dir);
  const up0: V3 = Math.abs(d[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  const right = norm(cross(up0, d));
  const up = norm(cross(d, right));
  const proj = (p: V3): V3 => [dot3(p, right), dot3(p, up), dot3(p, d)];
  // Project the fixed bounding box corners so every view of one frame shares its scale.
  const corners: V3[] = [];
  for (const x of [frame.min[0], frame.max[0]])
    for (const y of [frame.min[1], frame.max[1]])
      for (const z of [frame.min[2], frame.max[2]]) corners.push(proj([x, y, z]));
  let loX = Infinity;
  let loY = Infinity;
  let hiX = -Infinity;
  let hiY = -Infinity;
  for (const [x, y] of corners) {
    loX = Math.min(loX, x);
    loY = Math.min(loY, y);
    hiX = Math.max(hiX, x);
    hiY = Math.max(hiY, y);
  }
  const span = Math.max(hiX - loX, hiY - loY) * 1.08;
  const cx = (loX + hiX) / 2;
  const cy = (loY + hiY) / 2;
  const s = size / span;
  const screen = (p: V3): V3 => [size / 2 + (p[0] - cx) * s, size / 2 - (p[1] - cy) * s, p[2]];
  const img = createImage(size, size, [18, 20, 28]);
  // Depth is dot(p, dir toward the viewer): the nearest surface has the largest value.
  const depth = new Float32Array(size * size).fill(-Infinity);
  const light = norm([0.4, -0.5, 0.8]);
  const grey: V3 = [0.78, 0.74, 0.66];
  const mask = new Uint8Array(size * size);
  const pos = mesh.position;
  const nor = mesh.normal;
  const tan = mesh.tangent;
  const uvs = mesh.uv;
  const idx = mesh.indices;
  const vertCount = pos.length / 3;
  const S = new Float32Array(vertCount * 3);
  for (let v = 0; v < vertCount; v++) {
    const q = screen(proj([pos[v * 3] as number, pos[v * 3 + 1] as number, pos[v * 3 + 2] as number]));
    S[v * 3] = q[0];
    S[v * 3 + 1] = q[1];
    S[v * 3 + 2] = q[2];
  }
  const N = (v: number): V3 => [nor[v * 3] as number, nor[v * 3 + 1] as number, nor[v * 3 + 2] as number];
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const [ia, ib, ic] = [idx[t] as number, idx[t + 1] as number, idx[t + 2] as number];
    const ax = S[ia * 3] as number;
    const ay = S[ia * 3 + 1] as number;
    const az = S[ia * 3 + 2] as number;
    const bx = S[ib * 3] as number;
    const by = S[ib * 3 + 1] as number;
    const bz = S[ib * 3 + 2] as number;
    const cx3 = S[ic * 3] as number;
    const cy3 = S[ic * 3 + 1] as number;
    const cz = S[ic * 3 + 2] as number;
    const den = (by - cy3) * (ax - cx3) + (cx3 - bx) * (ay - cy3);
    if (Math.abs(den) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx3)));
    const x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx3)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy3)));
    const y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy3)));
    const na = N(ia);
    const nb = N(ib);
    const nc = N(ic);
    const tri = t / 3;
    const albedo: V3 =
      options.albedo === undefined
        ? grey
        : [
            options.albedo[tri * 3] as number,
            options.albedo[tri * 3 + 1] as number,
            options.albedo[tri * 3 + 2] as number,
          ];
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const w1 = ((by - cy3) * (x - cx3) + (cx3 - bx) * (y - cy3)) / den;
        const w2 = ((cy3 - ay) * (x - cx3) + (ax - cx3) * (y - cy3)) / den;
        const w3 = 1 - w1 - w2;
        if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
        const z = az * w1 + bz * w2 + cz * w3;
        const k = y * size + x;
        if (z <= (depth[k] as number)) continue;
        depth[k] = z;
        mask[k] = 1;
        let n: V3 = norm([
          na[0] * w1 + nb[0] * w2 + nc[0] * w3,
          na[1] * w1 + nb[1] * w2 + nc[1] * w3,
          na[2] * w1 + nb[2] * w2 + nc[2] * w3,
        ]);
        if (map !== undefined && tan !== undefined && uvs !== undefined) {
          // Tangent frame at the sample: interpolated tangent xyz, handedness from the first corner.
          const tw = tan[ia * 4 + 3] as number;
          const tvec = norm([
            (tan[ia * 4] as number) * w1 + (tan[ib * 4] as number) * w2 + (tan[ic * 4] as number) * w3,
            (tan[ia * 4 + 1] as number) * w1 +
              (tan[ib * 4 + 1] as number) * w2 +
              (tan[ic * 4 + 1] as number) * w3,
            (tan[ia * 4 + 2] as number) * w1 +
              (tan[ib * 4 + 2] as number) * w2 +
              (tan[ic * 4 + 2] as number) * w3,
          ]);
          const u = (uvs[ia * 2] as number) * w1 + (uvs[ib * 2] as number) * w2 + (uvs[ic * 2] as number) * w3;
          const v = (uvs[ia * 2 + 1] as number) * w1 + (uvs[ib * 2 + 1] as number) * w2 + (uvs[ic * 2 + 1] as number) * w3;
          const tx = Math.min(map.width - 1, Math.max(0, Math.floor(u * map.width)));
          const ty = Math.min(map.height - 1, Math.max(0, Math.floor(v * map.height)));
          const o = (ty * map.width + tx) * 4;
          const tsn: V3 = [
            (map.rgba[o] as number) / 127.5 - 1,
            (map.rgba[o + 1] as number) / 127.5 - 1,
            (map.rgba[o + 2] as number) / 127.5 - 1,
          ];
          // T0 = T orthogonal to N, B = cross(N, T0) * w: the bake's tangentNormal frame.
          const dtn = dot3(tvec, n);
          const t0 = norm([tvec[0] - n[0] * dtn, tvec[1] - n[1] * dtn, tvec[2] - n[2] * dtn]);
          const bvec = cross(n, t0);
          const bw = tw === 0 ? 1 : tw;
          const b: V3 = [bvec[0] * bw, bvec[1] * bw, bvec[2] * bw];
          n = norm([
            t0[0] * tsn[0] + b[0] * tsn[1] + n[0] * tsn[2],
            t0[1] * tsn[0] + b[1] * tsn[1] + n[1] * tsn[2],
            t0[2] * tsn[0] + b[2] * tsn[1] + n[2] * tsn[2],
          ]);
        }
        const lambert = Math.max(0.12, dot3(n, light));
        const c: RGB = [
          Math.min(255, albedo[0] * 255 * lambert),
          Math.min(255, albedo[1] * 255 * lambert),
          Math.min(255, albedo[2] * 255 * lambert),
        ];
        setPixel(img, x, y, c);
      }
  }
  return { image: img, mask };
}
