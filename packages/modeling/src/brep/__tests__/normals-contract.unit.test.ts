import { describe, expect, it } from 'vitest';
import { exportMesh } from '../../finish';
import { EDGE_SHARP } from '../../mesh';
import { revolve } from '../build';
import { filletBox } from '../fillet-box';
import { filletCylinder } from '../fillet-cylinder';
import { filletPrism } from '../fillet-prism';
import { surfaceInverse, surfaceNormal } from '../surfaces';
import { tessellateSampled } from '../tessellate';
import type { Shape } from '../types';
import { primitives } from './support';

/** Contract bound: exported smooth vertex normals stay within this angle of the analytic normal. */
const CONTRACT_DEG = 2;
/** Tessellation angle step used by the contract; the default pi / 16 is measured in the test below. */
const CONTRACT_STEP = Math.PI / 64;
const DEFAULT_STEP = Math.PI / 16;
/** Vertices within this fraction of the shape diagonal of a sharp edge are on that crease. */
const SHARP_TOL = 1e-5;
/** A vertex within this fraction of the diagonal of a face is on that face. */
const FACE_TOL = 1e-6;
/** A vertex this close to an axis of a periodic surface has an undefined `u`, so it is excluded. */
const AXIS_TOL = 1e-6;
/** Exported normals must already be unit length; the angle check divides out |n| only for measurement. */
const LENGTH_TOL = 1e-6;
/**
 * A tangent break above this angle is a soft crease. Smooth export splits the difference, so a
 * break of 2 * CONTRACT_DEG would already exceed the bound; breaks below 1 deg are tessellation
 * noise (G1 corners) and stay inside the contract.
 */
const CREASE_DEG = 1;

interface NormalError {
  /** Vertices checked against the contract. */
  readonly checked: number;
  readonly maxDeg: number;
  /** Largest | |n| - 1 | over exported normals; the export must be unit length. */
  readonly lengthError: number;
  /** Exported vertices with no B-rep face within the diagonal-scaled on-surface tolerance. Must be zero. */
  readonly offSurface: number;
  /** Vertices on an EDGE_SHARP edge, each matched against its own incident faces. */
  readonly sharpChecked: number;
  /** Largest angle from the nearest incident face at a sharp vertex (split normals must match one). */
  readonly sharpMaxDeg: number;
  /** Vertices on a soft crease (below the export `crease`), smoothed by design and excluded. */
  readonly soft: number;
  /** Largest angle from the nearest crease face at a soft vertex: the smoothing the exclusion covers. */
  readonly softMaxDeg: number;
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** Perturbation of exported normals, used only by falsifiers to prove the metric catches them. */
interface Perturb {
  /** Scale every exported vector before measuring (changes its length). */
  readonly scale?: number;
  /** Tilt every exported direction by this many degrees (changes its angle). */
  readonly tiltDeg?: number;
  /** Tilt only sharp-edge vertices, as a blended or wrong split normal would. */
  readonly sharpTiltDeg?: number;
}

function cross3(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
}

/** Rotate unit `u` by `deg` about a perpendicular; the angle between input and output is exactly `deg`. */
function tilt(u: [number, number, number], deg: number): [number, number, number] {
  const t = cross3(u, [0.6, 0.64, 0.48]);
  const tl = Math.hypot(t[0], t[1], t[2]);
  if (tl === 0) return u;
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const sn = Math.sin(r);
  return [u[0] * c + (t[0] / tl) * sn, u[1] * c + (t[1] / tl) * sn, u[2] * c + (t[2] / tl) * sn];
}

/**
 * Max angle between each exported vertex normal and the analytic normal of its B-rep face.
 * Smooth vertices are checked against their face. A vertex on an EDGE_SHARP edge keeps split
 * normals, so it must match one of its incident faces (crease-aware: a blended normal fails).
 * Soft creases are excluded (smoothed by design). Tolerances scale with the shape diagonal.
 */
function smoothNormalError(shape: Shape, angle: number, perturb: Perturb = {}): NormalError {
  const sampled = must(tessellateSampled(shape, { angle }));
  const exported = must(exportMesh(sampled.mesh, { normals: { mode: 'smooth' } }));
  const pos = exported.mesh.attributes.position as Float32Array;
  const nrm = exported.mesh.attributes.normal as Float32Array;
  const diag = diagonal(pos);
  const sharpTol = SHARP_TOL * diag;
  const faceTol = FACE_TOL * diag;
  const sharp: [number, number, number][] = [];
  for (const e of sampled.mesh.edges()) {
    if (((sampled.mesh.eFlags[e] as number) & EDGE_SHARP) === 0) continue;
    for (const v of sampled.mesh.edgeVertices(e)) sharp.push(sampled.mesh.position(v));
  }
  let checked = 0;
  let maxDeg = 0;
  let sharpChecked = 0;
  let sharpMaxDeg = 0;
  let soft = 0;
  let softMaxDeg = 0;
  let lengthError = 0;
  let offSurface = 0;
  for (let i = 0; i < pos.length / 3; i++) {
    const p: [number, number, number] = [pos[3 * i] ?? 0, pos[3 * i + 1] ?? 0, pos[3 * i + 2] ?? 0];
    const k = perturb.scale ?? 1;
    const raw: [number, number, number] = [
      (nrm[3 * i] ?? 0) * k,
      (nrm[3 * i + 1] ?? 0) * k,
      (nrm[3 * i + 2] ?? 0) * k,
    ];
    const len = Math.hypot(raw[0], raw[1], raw[2]);
    lengthError = Math.max(lengthError, Math.abs(len - 1));
    const unit: [number, number, number] =
      len === 0 ? raw : [raw[0] / len, raw[1] / len, raw[2] / len];
    const faces = facesAt(shape, p, faceTol);
    if (faces.length === 0) {
      offSurface++;
      continue;
    }
    if (faces.some((f) => f.onAxis)) continue;
    if (sharp.some((q) => distance(q, p) < sharpTol)) {
      const gs = perturb.sharpTiltDeg === undefined ? unit : tilt(unit, perturb.sharpTiltDeg);
      sharpChecked++;
      sharpMaxDeg = Math.max(sharpMaxDeg, Math.min(...faces.map((f) => degBetween(gs, f.normal))));
      continue;
    }
    const gn = perturb.tiltDeg === undefined ? unit : tilt(unit, perturb.tiltDeg);
    const owner = nearestFace(shape, p);
    if (owner === undefined) continue;
    if (isSoftCrease(faces)) {
      soft++;
      softMaxDeg = Math.max(softMaxDeg, Math.min(...faces.map((f) => degBetween(gn, f.normal))));
      continue;
    }
    checked++;
    maxDeg = Math.max(maxDeg, degBetween(gn, owner.normal));
  }
  return { checked, maxDeg, sharpChecked, sharpMaxDeg, lengthError, offSurface, soft, softMaxDeg };
}

/** Bounding-box diagonal of the exported positions; the unit of every geometric tolerance. */
function diagonal(pos: Float32Array): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) {
    const c = i % 3;
    lo[c] = Math.min(lo[c] as number, pos[i] ?? 0);
    hi[c] = Math.max(hi[c] as number, pos[i] ?? 0);
  }
  return Math.hypot(
    (hi[0] as number) - (lo[0] as number),
    (hi[1] as number) - (lo[1] as number),
    (hi[2] as number) - (lo[2] as number),
  );
}

function degBetween(a: readonly number[], b: readonly number[]): number {
  const la = Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
  const dot = Math.max(-1, Math.min(1, dotN(a, b) / la));
  return (Math.acos(dot) * 180) / Math.PI;
}

interface FaceAt {
  readonly normal: [number, number, number];
  readonly onAxis: boolean;
}

/** Every B-rep face through `p` (distance within `tol`), with its outward analytic normal. */
function facesAt(shape: Shape, p: [number, number, number], tol: number): FaceAt[] {
  const out: FaceAt[] = [];
  for (const f of shape.faces) {
    const s = shape.surfaces[f.surface];
    if (s === undefined) continue;
    const inv = surfaceInverse(s, p);
    if (inv.dist > tol) continue;
    const a = surfaceNormal(s, inv.u, inv.v);
    const sign = f.reversed ? -1 : 1;
    out.push({
      normal: [sign * a[0], sign * a[1], sign * a[2]],
      onAxis: s.kind === 'cone' && Math.abs(p[0]) + Math.abs(p[1]) < AXIS_TOL,
    });
  }
  return out;
}

/**
 * A soft crease is a vertex where two faces meet at a tangent break below the export `crease`
 * (not EDGE_SHARP). Smooth export averages the two normals there by design, so the vertex is
 * outside the per-face contract; a G1 seam (tangent-continuous faces) stays inside it.
 */
function isSoftCrease(faces: readonly FaceAt[]): boolean {
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const a = faces[i]?.normal ?? [0, 0, 0];
      const b = faces[j]?.normal ?? [0, 0, 0];
      if (faces[i]?.onAxis || faces[j]?.onAxis) continue;
      if (degBetween(a, b) > CREASE_DEG) return true;
    }
  }
  return false;
}

function distance(a: readonly number[], b: readonly number[]): number {
  const dx = (a[0] ?? 0) - (b[0] ?? 0);
  const dy = (a[1] ?? 0) - (b[1] ?? 0);
  const dz = (a[2] ?? 0) - (b[2] ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function dotN(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
}

interface Owner {
  readonly distance: number;
  readonly normal: [number, number, number];
  readonly onAxis: boolean;
}

/** The B-rep face nearest to `p`, with its outward analytic normal at that point. */
function nearestFace(shape: Shape, p: [number, number, number]): Owner | undefined {
  let best: Owner | undefined;
  for (const f of shape.faces) {
    const s = shape.surfaces[f.surface];
    if (s === undefined) continue;
    const inv = surfaceInverse(s, p);
    if (best !== undefined && inv.dist >= best.distance) continue;
    const a = surfaceNormal(s, inv.u, inv.v);
    const sign = f.reversed ? -1 : 1;
    const onAxis = s.kind === 'cone' && Math.abs(p[0]) + Math.abs(p[1]) < AXIS_TOL;
    best = {
      distance: inv.dist,
      normal: [sign * a[0], sign * a[1], sign * a[2]],
      onAxis,
    };
  }
  return best;
}

function corpus(): { name: string; shape: Shape }[] {
  const out = primitives().map((p) => ({ name: p.name, shape: p.shape }));
  out.push({ name: 'fillet-box', shape: must(filletBox({ size: [2, 2, 2], radius: 0.3 })) });
  out.push({
    name: 'fillet-cylinder',
    shape: must(filletCylinder({ radius: 1, height: 2, fillet: 0.25 })),
  });
  // Ring at a 20 deg soft crease. Its faces have no interior samples, so the per-face bound is
  // vacuous here (checked = 0); the soft-crease test below is the non-vacuous claim.
  out.push({
    name: 'fillet-prism',
    shape: must(
      filletPrism({
        profile: [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
        ],
        height: 2,
        radii: [0.3, 0.3, 0.3, 0.3],
      }),
    ),
  });
  const soft = (Math.PI / 180) * 20;
  out.push({
    name: 'revolve-soft-20deg',
    shape: must(
      revolve({
        profile: [
          [0, 0],
          [2, 0],
          [2, 1],
          [2 - Math.sin(soft), 1 + Math.cos(soft)],
          [0, 1 + Math.cos(soft)],
        ],
      }),
    ),
  });
  return out;
}

/**
 * Measured floor of checked vertices per corpus shape (smooth checked + sharp checked), at
 * CONTRACT_STEP. Ruled and planar shapes contribute only through their sharp edges, so the
 * floor keeps the crease-aware check from becoming vacuous on them.
 */
const MIN_CHECKED: Record<string, number> = {
  box: 24,
  cylinder: 514,
  cone: 257,
  sphere: 8383,
  torus: 16641,
  'extrude-holed': 48,
  revolve: 772,
  'fillet-box': 9520,
  'fillet-cylinder': 9028,
  'fillet-prism': 544,
  'revolve-soft-20deg': 514,
};

/** Shapes whose curved faces have interior samples, so the bound is tested non-vacuously. */
const CURVED = new Set(['sphere', 'torus', 'fillet-box', 'fillet-cylinder']);

describe('smooth vertex normal contract (X2 / B-E0c)', () => {
  for (const { name, shape } of corpus()) {
    it(`${name}: smooth vertex normals within ${CONTRACT_DEG} deg at pi/64 away from sharp edges`, () => {
      const err = smoothNormalError(shape, CONTRACT_STEP);
      if (CURVED.has(name)) expect(err.checked).toBeGreaterThan(0);
      const floor = MIN_CHECKED[name];
      expect(floor, `no measured floor for ${name}`).toBeDefined();
      expect(err.checked + err.sharpChecked).toBeGreaterThanOrEqual(floor as number);
      expect(err.offSurface).toBe(0);
      expect(err.lengthError).toBeLessThanOrEqual(LENGTH_TOL);
      expect(err.maxDeg).toBeLessThanOrEqual(CONTRACT_DEG);
      expect(err.sharpMaxDeg).toBeLessThanOrEqual(CONTRACT_DEG);
    });
  }

  it('soft creases are excluded because smoothing averages their faces: a 20 deg ring exports ~10 deg off each face', () => {
    const soft = corpus().find((c) => c.name === 'revolve-soft-20deg');
    if (soft === undefined) throw new Error('no revolve-soft-20deg');
    const err = smoothNormalError(soft.shape, CONTRACT_STEP);
    expect(err.soft).toBeGreaterThan(0);
    expect(err.softMaxDeg).toBeGreaterThan(CONTRACT_DEG);
  });

  it('the bound is tessellation-driven: the default pi/16 step is coarser and larger on fillet-box', () => {
    const fine = smoothNormalError(
      must(filletBox({ size: [2, 2, 2], radius: 0.3 })),
      CONTRACT_STEP,
    );
    const coarse = smoothNormalError(
      must(filletBox({ size: [2, 2, 2], radius: 0.3 })),
      DEFAULT_STEP,
    );
    expect(fine.maxDeg).toBeLessThan(coarse.maxDeg);
  });
});

function primitiveShape(name: string): Shape {
  const found = primitives().find((p) => p.name === name);
  if (found === undefined) throw new Error(`no primitive ${name}`);
  return found.shape;
}

function distinctNormalsAt(
  pos: Float32Array,
  nrm: Float32Array,
  at: readonly [number, number, number],
): number {
  const seen = new Set<string>();
  for (let i = 0; i < pos.length / 3; i++) {
    const d = distance([pos[3 * i] ?? 0, pos[3 * i + 1] ?? 0, pos[3 * i + 2] ?? 0], at);
    if (d > 1e-5) continue;
    seen.add(
      [nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]].map((x) => Math.round((x ?? 0) * 1e4)).join(','),
    );
  }
  return seen.size;
}

describe('sharp edges keep split normals (X2 / B-E0c)', () => {
  it('a box corner (three 90 degree creases) exports three distinct normals', () => {
    const shape = primitiveShape('box');
    const sampled = must(tessellateSampled(shape, {}));
    const exported = must(exportMesh(sampled.mesh, { normals: { mode: 'smooth' } }));
    const pos = exported.mesh.attributes.position as Float32Array;
    const nrm = exported.mesh.attributes.normal as Float32Array;
    const corner = [pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0] as [number, number, number];
    expect(distinctNormalsAt(pos, nrm, corner)).toBe(3);
  });

  it('a smooth sphere keeps one normal per vertex position (no spurious split)', () => {
    const shape = primitiveShape('sphere');
    const sampled = must(tessellateSampled(shape, { angle: CONTRACT_STEP }));
    const exported = must(exportMesh(sampled.mesh, { normals: { mode: 'smooth' } }));
    const pos = exported.mesh.attributes.position as Float32Array;
    const nrm = exported.mesh.attributes.normal as Float32Array;
    const probe = [pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0] as [number, number, number];
    expect(distinctNormalsAt(pos, nrm, probe)).toBe(1);
  });

  it('the contract is scale-invariant: a 1000x fillet-box keeps every vertex on its surface', () => {
    const shape = must(filletBox({ size: [2000, 2000, 2000], radius: 300 }));
    const err = smoothNormalError(shape, CONTRACT_STEP);
    expect(err.offSurface).toBe(0);
    expect(err.maxDeg).toBeLessThanOrEqual(CONTRACT_DEG);
  });

  it('falsifier: a 20 deg tilt of split normals at sharp edges fails the crease check', () => {
    const box = primitiveShape('box');
    const base = smoothNormalError(box, CONTRACT_STEP);
    const tilted = smoothNormalError(box, CONTRACT_STEP, { sharpTiltDeg: 20 });
    expect(base.sharpChecked).toBeGreaterThan(0);
    expect(base.sharpMaxDeg).toBeLessThanOrEqual(CONTRACT_DEG);
    expect(tilted.sharpMaxDeg).toBeGreaterThan(CONTRACT_DEG);
  });

  it('falsifier: a 3 deg tilt of the exported normals fails the angle bound', () => {
    const shape = must(filletBox({ size: [2, 2, 2], radius: 0.3 }));
    const base = smoothNormalError(shape, CONTRACT_STEP);
    const tilted = smoothNormalError(shape, CONTRACT_STEP, { tiltDeg: 3 });
    expect(base.maxDeg).toBeLessThanOrEqual(CONTRACT_DEG);
    expect(tilted.maxDeg).toBeGreaterThan(CONTRACT_DEG);
  });

  it('falsifier: scaling the exported normals by 1.001 fails the unit-length gate', () => {
    const shape = must(filletBox({ size: [2, 2, 2], radius: 0.3 }));
    const scaled = smoothNormalError(shape, CONTRACT_STEP, { scale: 1.001 });
    expect(scaled.lengthError).toBeGreaterThan(LENGTH_TOL);
  });
});
