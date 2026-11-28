// Closed case registry for the L4 quad evaluator. Every id here is part of the shared yardstick that
// L2 (B-rep quads) and L3 (triangle remesh) report against; changing a reference changes their scores.

import { box, cylinder, sphere, tessellate, torus } from '@forgeax/engine-modeling/brep';
import { FEATURE_CASES } from './cases-feature.ts';
import { cross, dot, type EvalMesh, type Vec3 } from './mesh.ts';

export interface CaseMeshes {
  /** Reference surface the producer is judged against. */
  readonly reference: EvalMesh;
  /** Identity producer output: the case's own canonical mesh. */
  readonly identity: EvalMesh;
  /** Stated limits for the report (never silent). */
  readonly notes: readonly string[];
}

export interface ReadyCase {
  readonly status: 'ready';
  readonly id: string;
  readonly title: string;
  readonly build: () => CaseMeshes;
}

export interface PendingCase {
  readonly status: 'pending';
  readonly id: string;
  readonly title: string;
  readonly pendingOn: string;
  readonly reason: string;
}

export type CaseEntry = ReadyCase | PendingCase;

/** Minimal structural view of the kernel EditMesh read API used here. */
interface EditMeshLike {
  faces(): number[];
  faceVertices(face: number): number[];
  position(vertex: number): [number, number, number];
}

function must<T>(r: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!r.ok) throw new Error('kernel primitive rejected its fixed options');
  return r.value;
}

function fromEdit(mesh: EditMeshLike): EvalMesh {
  const index = new Map<number, number>();
  const positions: Vec3[] = [];
  const faces: number[][] = mesh.faces().map((f) =>
    mesh.faceVertices(f).map((v) => {
      let i = index.get(v);
      if (i === undefined) {
        i = positions.length;
        index.set(v, i);
        positions.push(mesh.position(v));
      }
      return i;
    }),
  );
  return { positions, faces };
}

/** Kernel primitive tessellated with explicit or default options. */
function brepMesh(build: () => unknown, angle?: number): EvalMesh {
  const shape = build();
  const options = angle === undefined ? undefined : { angle };
  return fromEdit(must(tessellate(shape as never, options)) as unknown as EditMeshLike);
}

/** mulberry32: small, seeded, and identical on every platform. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reverse a loop when its Newell normal points inward; valid for closed star-shaped bodies around the origin. */
function orientOutward(positions: readonly Vec3[], loop: number[]): number[] {
  let n: Vec3 = [0, 0, 0];
  let centre: Vec3 = [0, 0, 0];
  for (let i = 0; i < loop.length; i++) {
    const p = positions[loop[i] as number] as [number, number, number];
    const q = positions[loop[(i + 1) % loop.length] as number] as [number, number, number];
    const c = cross(p, q);
    n = [n[0] + c[0], n[1] + c[1], n[2] + c[2]];
    centre = [centre[0] + p[0], centre[1] + p[1], centre[2] + p[2]];
  }
  return dot(n, centre) < 0 ? [...loop].reverse() : loop;
}

/**
 * Unit cube (side 1, centred) as an n x n quad grid per face. `jitter` moves interior face vertices
 * in their face plane by `amount` cell widths, using a seeded stream; boundary vertices stay put.
 */
export function gridCube(
  n: number,
  jitter: { readonly seed: number; readonly amount: number } | null,
): EvalMesh {
  const rng = seeded(jitter?.seed ?? 1);
  const cell = 1 / n;
  const index = new Map<string, number>();
  const positions: Vec3[] = [];
  const vertex = (p: Vec3): number => {
    const key = p.map((c) => Math.round(c * 1e9)).join(',');
    let i = index.get(key);
    if (i === undefined) {
      i = positions.length;
      index.set(key, i);
      positions.push(p);
    }
    return i;
  };
  const faces: number[][] = [];
  for (let axis = 0; axis < 3; axis++)
    for (const sign of [-1, 1]) {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      const grid: number[][] = [];
      for (let i = 0; i <= n; i++) {
        const row: number[] = [];
        for (let j = 0; j <= n; j++) {
          const p: [number, number, number] = [0, 0, 0];
          p[axis] = sign * 0.5;
          p[u] = -0.5 + i * cell;
          p[v] = -0.5 + j * cell;
          if (jitter !== null && i > 0 && i < n && j > 0 && j < n) {
            p[u] = (p[u] as number) + jitter.amount * cell * (rng() * 2 - 1);
            p[v] = (p[v] as number) + jitter.amount * cell * (rng() * 2 - 1);
          }
          row.push(vertex(p));
        }
        grid.push(row);
      }
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          const loop = [
            (grid[i] as number[])[j] as number,
            (grid[i + 1] as number[])[j] as number,
            (grid[i + 1] as number[])[j + 1] as number,
            (grid[i] as number[])[j + 1] as number,
          ];
          faces.push(orientOutward(positions, loop));
        }
    }
  return { positions, faces };
}

/** Triangulate every quad by its first diagonal (0,1,2) and (0,2,3). */
export function triangulate(mesh: EvalMesh): EvalMesh {
  const faces: number[][] = [];
  for (const loop of mesh.faces) {
    if (loop.length === 3) {
      faces.push([...loop]);
      continue;
    }
    faces.push([loop[0] as number, loop[1] as number, loop[2] as number]);
    faces.push([loop[0] as number, loop[2] as number, loop[3] as number]);
  }
  return { positions: mesh.positions, faces };
}

/** UV sphere with a seeded radial displacement (stand-in for a scan; the repo has no Stanford model). */
export function lumpySphere(segments: number, rings: number, seed: number): EvalMesh {
  const rng = seeded(seed);
  const phase = rng() * Math.PI * 2;
  const positions: Vec3[] = [];
  const ringIndex = (r: number, s: number): number => {
    if (r === 0) return 0;
    if (r === rings) return 1;
    return 2 + (r - 1) * segments + (((s % segments) + segments) % segments);
  };
  const radius = (theta: number, phi: number): number =>
    0.5 * (1 + 0.06 * Math.sin(3 * theta + phase) * Math.cos(4 * phi + 2 * phase));
  const point = (theta: number, phi: number): Vec3 => {
    const R = radius(theta, phi);
    return [
      R * Math.sin(theta) * Math.cos(phi),
      R * Math.cos(theta),
      R * Math.sin(theta) * Math.sin(phi),
    ];
  };
  positions.push(point(0, 0), point(Math.PI, 0));
  for (let r = 1; r < rings; r++)
    for (let s = 0; s < segments; s++)
      positions.push(point((Math.PI * r) / rings, (2 * Math.PI * s) / segments));
  const faces: number[][] = [];
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const a = ringIndex(r, s);
      const b = ringIndex(r + 1, s);
      const c = ringIndex(r + 1, s + 1);
      const d = ringIndex(r, s + 1);
      const loop = r === 0 ? [a, b, c] : r + 1 === rings ? [a, b, d] : [a, b, c, d];
      faces.push(orientOutward(positions, loop));
    }
  return { positions, faces };
}

/** Two-face test mesh: one coincident-corner (degenerate) quad and one self-crossing (inverted) quad. */
function brokenQuads(): EvalMesh {
  const positions: Vec3[] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 0, 0],
    [3, 0, 0],
    [5, 2, 0],
    [5, 0, 0],
    [3, 1.5, 0],
  ];
  return {
    positions,
    faces: [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ],
  };
}

const unitSquare = (): EvalMesh => ({
  positions: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ],
  faces: [[0, 1, 2, 3]],
});

export const CASES: readonly CaseEntry[] = [
  {
    status: 'ready',
    id: 'brep-box-quad',
    title: 'Box 1 x 1 x 1 m, B-rep tessellation (one face per side)',
    build: () => {
      const mesh = brepMesh(() => must(box({ size: [1, 1, 1] })));
      return {
        reference: mesh,
        identity: mesh,
        notes: ['reference and producer are the same tessellation'],
      };
    },
  },
  {
    status: 'ready',
    id: 'grid-cube-4',
    title: 'Unit cube, regular 4 x 4 quad grid per side',
    build: () => {
      const identity = gridCube(4, null);
      return {
        reference: gridCube(1, null),
        identity,
        notes: ['reference: unit cube, one quad per side'],
      };
    },
  },
  {
    status: 'ready',
    id: 'distorted-cube-4',
    title: 'Unit cube, 4 x 4 grid with seeded interior jitter (0.3 cell)',
    build: () => {
      const identity = gridCube(4, { seed: 7, amount: 0.3 });
      return {
        reference: gridCube(1, null),
        identity,
        notes: ['jitter seed 7, interior vertices only'],
      };
    },
  },
  {
    status: 'ready',
    id: 'broken-quad',
    title: 'Degenerate and inverted quads (must be reported, not accepted)',
    build: () => ({
      reference: unitSquare(),
      identity: brokenQuads(),
      notes: ['face 0 coincident corners (degenerate), face 1 self-crossing (inverted)'],
    }),
  },
  {
    status: 'ready',
    id: 'brep-sphere-quad',
    title: 'Sphere radius 0.5, default tessellation against a pi/64 reference',
    build: () => {
      const reference = brepMesh(() => must(sphere({ radius: 0.5 })), Math.PI / 64);
      const identity = brepMesh(() => must(sphere({ radius: 0.5 })));
      return {
        reference,
        identity,
        notes: ['reference: tessellate angle pi/64; producer: default angle'],
      };
    },
  },
  {
    status: 'ready',
    id: 'brep-torus',
    title: 'Torus major 1, minor 0.3, default tessellation against a pi/64 reference',
    build: () => {
      const reference = brepMesh(() => must(torus({ major: 1, minor: 0.3 })), Math.PI / 64);
      const identity = brepMesh(() => must(torus({ major: 1, minor: 0.3 })));
      return { reference, identity, notes: ['genus 1: chi = 0'] };
    },
  },
  {
    status: 'ready',
    id: 'brep-cylinder-sharp',
    title: 'Cylinder radius 0.5, height 1, sharp rim creases',
    build: () => {
      const reference = brepMesh(() => must(cylinder({ radius: 0.5, height: 1 })), Math.PI / 64);
      const identity = brepMesh(() => must(cylinder({ radius: 0.5, height: 1 })));
      return {
        reference,
        identity,
        notes: [
          'rim edges are 90 deg dihedral feature edges (256 = 2 rims x 128 segments)',
          'producer rims use 32 segments against 128: sharp coverage below the gate is chord sagitta r(1-cos(pi/32)) = 0.0024, above the 1e-3 diag tolerance; not a missing edge',
          'attribution: the 32-gon caps are excluded from the sJ gate (sJ is defined for triangles and quads only); a regular 32-gon corner is sin(2 pi / 32) = 0.195 by construction, so an n-gon cap is a metric defect, not a quality finding. Caps are still counted in ngons and checked for inversion.',
          'sJ min over triangles and quads is 1.0 for the identity; the verdict now rests on the rim tessellation, not the cap',
        ],
      };
    },
  },
  {
    status: 'ready',
    id: 'cube-tri-sharp',
    title: 'Unit cube, two triangles per side, 12 sharp edges',
    build: () => {
      const reference = gridCube(1, null);
      return {
        reference,
        identity: triangulate(reference),
        notes: ['right isosceles triangles: corner sJ = sin 45 deg = 0.707 (not 0.866)'],
      };
    },
  },
  {
    status: 'ready',
    id: 'lumpy-sphere-tri',
    title: 'Seeded lumpy UV sphere, triangles, against a 2x resolution reference',
    build: () => ({
      reference: triangulate(lumpySphere(64, 32, 11)),
      identity: triangulate(lumpySphere(32, 16, 11)),
      notes: ['procedural stand-in for a stanford-style scan: no scan asset exists in the repo'],
    }),
  },
  {
    status: 'pending',
    id: 'brep-trimmed-face',
    title: 'Non-rectangular analytic face with a trim loop',
    pendingOn: 'L1 nurbs-trim',
    reason: 'needs trimmed analytic faces from L1',
  },
  {
    status: 'pending',
    id: 'nurbs-face',
    title: 'NURBS surface shell',
    pendingOn: 'L1 nurbs-trim',
    reason: 'needs NURBS face support from L1',
  },
  {
    status: 'pending',
    id: 'boolean-cut-plate',
    title: 'Boolean cut on a plate',
    pendingOn: 'E1c',
    reason: 'needs boolean output to measure quad layout after booleans',
  },
  ...FEATURE_CASES,
];

export function findCase(id: string): CaseEntry | undefined {
  return CASES.find((c) => c.id === id);
}
