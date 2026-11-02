import {
  coloredMesh,
  curvatureComb,
  curvatureShading,
  type FeatureLine,
  type Model,
  overlayMesh,
  projectOverlay,
  type SurfaceField,
  surfaceField,
  type Tuple3,
  zebraStripes,
} from '@forgeax/engine-modeling';
import type { MeshAsset } from '@forgeax/engine-types';

/** A perspective case camera: eye and target. */
export interface Eye {
  readonly eye: readonly number[];
  readonly target: readonly number[];
}

const sub = (a: readonly number[], b: readonly number[]): Tuple3 => [
  (a[0] as number) - (b[0] as number),
  (a[1] as number) - (b[1] as number),
  (a[2] as number) - (b[2] as number),
];
const unit = (a: Tuple3): Tuple3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: Tuple3, b: Tuple3): Tuple3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Screen axes of a level camera looking from `eye` at `target`. */
export function screen(view: Eye): { right: Tuple3; up: Tuple3 } {
  const forward = unit(sub(view.target, view.eye));
  const right = unit(cross(forward, [0, 1, 0]));
  return { right, up: cross(right, forward) };
}

/** The exact surface field of a session's final state (exported with weighted normals). */
export function fieldOf(m: Model): SurfaceField {
  const exported = m.toMesh({ normals: { mode: 'weighted' } });
  if (!exported.ok) throw exported.error;
  const field = surfaceField(
    exported.value.mesh,
    m.diagnostics().surfaces.map((s) => s.surface),
  );
  if (!field.ok) throw field.error;
  return field.value;
}

export function zebraMesh(m: Model, view: Eye, width = 3): MeshAsset {
  const stripes = zebraStripes(
    fieldOf(m),
    m.diagnostics().surfaces.map((s) => s.surface),
    { eye: [...view.eye] as Tuple3, ...screen(view), width },
  );
  if (!stripes.ok) throw stripes.error;
  const mesh = coloredMesh(stripes.value);
  if (!mesh.ok) throw mesh.error;
  return mesh.value;
}

export function curvatureMesh(m: Model, range: number): MeshAsset {
  const shaded = curvatureShading(fieldOf(m), { kind: 'mean', range });
  if (!shaded.ok) throw shaded.error;
  const mesh = coloredMesh(shaded.value);
  if (!mesh.ok) throw mesh.error;
  return mesh.value;
}

/** V-wire: the n-gon edges of the session, optionally only inside a close-up box. */
export function wireMesh(m: Model, bounds?: readonly number[]): MeshAsset {
  const overlay = projectOverlay(m.editMesh, 'edges', bounds);
  if (!overlay.ok) throw overlay.error;
  return overlay.value.mesh;
}

/** Curvature combs of feature lines, as one line-list mesh. */
export function combMesh(lines: readonly FeatureLine[], scale?: number): MeshAsset {
  const positions: number[] = [];
  const colors: number[] = [];
  for (const line of lines) {
    const comb = curvatureComb(line.curve, { samples: 96, ...(scale === undefined ? {} : { scale }) });
    if (!comb.ok) throw comb.error;
    positions.push(...comb.value.positions);
    colors.push(...comb.value.colors);
  }
  const mesh = overlayMesh(
    { position: new Float32Array(positions), color: new Float32Array(colors) },
    'line-list',
  );
  if (!mesh.ok) throw mesh.error;
  return mesh.value;
}

/**
 * Curvature roughness of the hood's middle: the mean gradient of mean curvature between
 * neighbouring vertices away from the creases (1/m^2). Fair panels vary slowly; a
 * traced, densely interpolated body ripples.
 */
export function roughness(m: Model): number {
  const field = fieldOf(m);
  const near = new Map<number, Set<number>>();
  const { indices, positions, mean } = field;
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++)
      for (let j = 0; j < 3; j++) {
        if (j === k) continue;
        const a = indices[t + k] as number;
        const b = indices[t + j] as number;
        let set = near.get(a);
        if (set === undefined) {
          set = new Set();
          near.set(a, set);
        }
        set.add(b);
      }
  let sum = 0;
  let count = 0;
  for (const [v, set] of near) {
    const x = positions[3 * v] as number;
    const y = positions[3 * v + 1] as number;
    // Hood middle: away from the ends, the centerline and the shoulder.
    if (!(x > 0.2 && x < 1 && y > 0.53)) continue;
    const z = positions[3 * v + 2] as number;
    if (!(z > 0.05 && z < 0.3)) continue;
    for (const w of set) {
      const d = Math.hypot(
        (positions[3 * w] as number) - x,
        (positions[3 * w + 1] as number) - y,
        (positions[3 * w + 2] as number) - z,
      );
      if (d === 0) continue;
      sum += Math.abs((mean[v] as number) - (mean[w] as number)) / d;
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

type V3 = [number, number, number];
const vsub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vadd = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vmul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const vdot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vunit = (a: V3): V3 => vmul(a, 1 / Math.hypot(...a));

/**
 * The B11 flange fold test: every cut vertex insets by `t` along the miter of its two
 * boundary edges (in their face planes); a face fails when the inset vertex crosses the
 * line of one of its far edges. Returns the failures and the narrowest such altitude.
 */
export function foldTest(m: Model, t: number) {
  const mesh = m.editMesh;
  const trim = mesh.tagIndex('trim', false);
  const faceN = (f: number): V3 => {
    const p = mesh.faceVertices(f).map((v) => mesh.position(v) as V3);
    let n: V3 = [0, 0, 0];
    for (let i = 0; i < p.length; i++) n = vadd(n, vcross(p[i]!, p[(i + 1) % p.length]!));
    return vunit(n);
  };
  // boundary half-edges of trim faces: inward normal in face plane
  const inward = new Map<number, V3[]>();
  for (const e of mesh.edges()) {
    if (!mesh.isBoundaryEdge(e)) continue;
    const h = (mesh.hFace[2 * e] as number) >= 0 ? 2 * e : 2 * e + 1;
    const f = mesh.hFace[h] as number;
    if (!mesh.hasTag(f, trim)) continue;
    const a = mesh.hVert[h] as number;
    const b = mesh.hVert[mesh.hNext[h] as number] as number;
    const d = vunit(vsub(mesh.position(b) as V3, mesh.position(a) as V3));
    const n = vunit(vcross(faceN(f), d)); // left of edge in face = interior
    for (const v of [a, b]) inward.set(v, [...(inward.get(v) ?? []), n]);
  }
  let fails = 0;
  let narrowest = Infinity;
  for (const [v, ns] of inward) {
    const n1 = ns[0]!;
    const n2 = ns[1] ?? n1;
    let w = vmul(vadd(n1, n2), t / (1 + vdot(n1, n2)));
    if (Math.hypot(...w) > 4 * t) w = vmul(vunit(w), 4 * t);
    const p = mesh.position(v) as V3;
    for (const f of mesh.faces()) {
      const loop = mesh.faceVertices(f);
      if (!loop.includes(v)) continue;
      const N = faceN(f);
      for (let i = 0; i < loop.length; i++) {
        const q1 = loop[i]!;
        const q2 = loop[(i + 1) % loop.length]!;
        if (q1 === v || q2 === v) continue;
        const a = mesh.position(q1) as V3;
        const e = vsub(mesh.position(q2) as V3, a);
        const l = Math.hypot(...e);
        const s = (x: V3) => vdot(vcross(e, vsub(x, a)), N) / l;
        const s0 = s(p);
        const s1 = s(vadd(p, w));
        if (Math.sign(s0) !== Math.sign(s1) || Math.abs(s1) <= 1e-6) {
          fails++;
          narrowest = Math.min(narrowest, Math.abs(s0));
        }
      }
    }
  }
  return { fails, narrowest };
}
