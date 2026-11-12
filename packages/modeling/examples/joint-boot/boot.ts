import { type MeshJob, type Model, model, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { MECH } from '../mech-gt/proportions.ts';

/**
 * Case C-108 (C-100 part, code name mech-gt): the flexible boot over the left knee of
 * the mech. A thigh cuff, a row of bellows folds and a shin cuff (each with a clamp
 * ring) are revolved as separate closed rings; a voxel smooth union melts them into
 * one organic corrugated sleeve (Surface Nets), two planar cuts per clamp trace clean
 * band borders that are marked sharp, an isotropic remesh evens the triangles while the
 * borders slide along themselves, the bands are offset outward as labeled steel clamps
 * with hard edges, and QEM simplification brings the
 * part to its triangle budget while the clamp label borders and hard edges stay exact.
 * A cylinder projection gives the new surface UVs, and the boot moves onto the knee.
 * Straight-line code: tools map every journal entry back to its source line.
 */
export interface BootParameters {
  /** Bellows folds between the cuffs. */
  readonly folds: number;
  /** Blend radius of the smooth union (meters). */
  readonly blend: number;
  /** Triangle budget of the finished boot. */
  readonly budget: number;
}

export const BOOT_DEFAULTS: BootParameters = { folds: 5, blend: 0.016, budget: 4000 };

/** Voxel size of the union and the remesh edge length (meters). */
export const BOOT_GRID = { voxelSize: 0.006, edge: 0.012 } as const;

/** The boot centers on the mech-gt left knee (joints.json `knee-l`). */
export const KNEE = (MECH.joints.find((j) => j.name === 'knee-l')?.position ?? [0, 0, 0]) as readonly [number, number, number];

/** Clamp bands as [bottom, top] heights about the knee (meters). */
export const CLAMPS = { thigh: [0.155, 0.175], shin: [-0.175, -0.155] } as const;

/** Closed `[radius, y]` rectangle section of a revolved ring, outward oriented. */
function band(inner: number, outer: number, y0: number, y1: number): [number, number][] {
  return [[inner, y0], [outer, y0], [outer, y1], [inner, y1], [inner, y0]];
}

/** Closed elliptical `[radius, y]` section of a fold (a ring once revolved): `wall` across, `rise` along the axis. */
function fold(radius: number, y: number, wall: number, rise: number): [number, number][] {
  const points: [number, number][] = [];
  for (let k = 0; k <= 16; k++) {
    const a = (((k % 16) - 4) * Math.PI) / 8;
    points.push([Math.round((radius + wall * Math.cos(a)) * 1e9) / 1e9, Math.round((y + rise * Math.sin(a)) * 1e9) / 1e9]);
  }
  return points;
}

export function buildBoot(p: BootParameters = BOOT_DEFAULTS, session: SessionFactory = () => model()): Model {
  const n = Math.max(2, Math.round(p.folds));
  const pitch = 0.24 / (n - 1);
  // Neighbouring folds overlap by a sixteenth of their height, so the union is one sleeve with valleys between them.
  const rise = pitch * 0.53;
  const clamps = sel.tag('clamp-thigh').or(sel.tag('clamp-shin'));
  const bands = sel.inBox([-1, CLAMPS.thigh[0], -1], [1, CLAMPS.thigh[1], 1], { by: 'centroid' }).or(sel.inBox([-1, CLAMPS.shin[0], -1], [1, CLAMPS.shin[1], 1], { by: 'centroid' }));

  // Thigh and shin cuffs with their clamp rings, then the bellows folds tapering toward the shin.
  const boot = session('boot');
  boot.revolve({ points: band(0.12, 0.15, 0.145, 0.19), segments: 48, tag: 'cuff-thigh', material: 'rubber' });
  boot.revolve({ points: band(0.14, 0.158, 0.15, 0.18), segments: 48, tag: 'clamp-thigh', material: 'rubber' });
  boot.revolve({ points: band(0.1, 0.13, -0.19, -0.145), segments: 48, tag: 'cuff-shin', material: 'rubber' });
  boot.revolve({ points: band(0.12, 0.138, -0.18, -0.15), segments: 48, tag: 'clamp-shin', material: 'rubber' });
  for (let i = 0; i < n; i++) {
    boot.revolve({ points: fold(0.144 - (0.02 * i) / (n - 1), 0.12 - i * pitch, 0.024, rise), segments: 48, tag: 'fold', material: 'rubber' });
  }

  // One organic sleeve: smooth union of the rings on a 6 mm grid, Surface Nets with two relaxation sweeps.
  boot.voxel.union(sel.all(), { voxelSize: BOOT_GRID.voxelSize, radius: p.blend, smooth: 2, label: 'boot' });
  // Clean clamp borders: planar cuts at both edges of each band, marked sharp so the remesh keeps them as curves.
  boot.bisect({ point: [0, CLAMPS.thigh[0], 0], normal: [0, 1, 0] });
  boot.bisect({ point: [0, CLAMPS.thigh[1], 0], normal: [0, 1, 0] });
  boot.bisect({ point: [0, CLAMPS.shin[0], 0], normal: [0, 1, 0] });
  boot.bisect({ point: [0, CLAMPS.shin[1], 0], normal: [0, 1, 0] });
  boot.markSharp(clamps.and(bands).boundary());
  // Even triangles of about 12 mm, reprojected onto the voxel surface; the band borders slide along themselves.
  boot.remesh(undefined, { targetEdgeLength: BOOT_GRID.edge, iterations: 6, preserve: { sharp: true } });

  // The outer band faces rise 4 mm as labeled steel clamps; their walls inherit the sharp borders.
  boot.offset(clamps.and(bands), { distance: 0.004, region: 'perIsland', label: 'clamp' });
  boot.assign(sel.createdBy('clamp'), 'steel');
  boot.markSharp(sel.createdBy('clamp').toEdges('touching').and(sel.edges.dihedral('>', 40)));

  // To the triangle budget: QEM keeps the clamp label borders and hard edges as constrained curves.
  boot.simplify(undefined, { targetFaces: p.budget, preserve: { labels: true, sharp: true, materials: true } });
  // The voxel surface carries no UVs: unroll it around the leg axis (before moving it off the axis).
  boot.uv.project({ mode: 'cylinder', axis: 'y', scale: 0.4 });
  boot.translate(sel.all(), [KNEE[0], KNEE[1], KNEE[2]]);
  return boot;
}

/**
 * The boot as a `modeling-mesh-job` (design 10.4): its voxel, remesh and simplify work
 * takes 8 to 15 s, too close to the 15 s Pack build budget, so `boot.pack.ts` emits only
 * the parameters and the cooker runs this job; register `createMeshJobCooker([BOOT_JOB])`
 * in the build plugin.
 */
export const BOOT_JOB: MeshJob<BootParameters> = {
  name: 'joint-boot',
  build: (p) => buildBoot(p),
  export: { normals: { mode: 'autoSmooth', angle: 40 } },
};
