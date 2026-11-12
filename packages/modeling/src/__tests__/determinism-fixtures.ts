import { bakeMaps, type Model, model, path, sel } from '@forgeax/engine-modeling';
import type { ByteCache, MeshAsset } from '@forgeax/engine-types';
import {
  type FrozenStates,
  loadFrozenStates,
  pauldron,
  restored,
} from './fixtures/frozen-builds.ts';

/** A kernel sample touching cuts, cleanup, mirroring, lifting and every export path. */
function kernelSample(): Model {
  const part = model();
  part.cylinder({ radiusTop: 0.3, radiusBottom: 0.4, height: 1, radialSegments: 7, tag: 'body' });
  part.loopCut(sel.facing('+y').toEdges('touching'), { cuts: 2 });
  part.bisect({ point: [0, 0.1, 0], normal: [0.2, 1, 0.1] });
  part.planeCut({
    point: [0, -0.3, 0],
    normal: [0, 1, 0],
    keep: 'positive',
    fillHoles: true,
    label: 'cut',
  });
  part.inset(sel.createdBy('cut', 'cap'), { thickness: 0.05, region: 'merged', label: 'foot' });
  part.extrude(sel.createdBy('foot', 'inner'), { distance: 0.1, region: 'merged', label: 'pad' });
  part.triangulate(sel.createdBy('pad', 'top'));
  part.uv.project({ mode: 'cylinder', axis: 'y', scale: 1 });
  const lifted = part.toMesh({ normals: { mode: 'autoSmooth', angle: 30 } });
  if (!lifted.ok) throw lifted.error;
  const m = model();
  m.lift(lifted.value.mesh, { label: 'lifted', tag: 'sample' });
  m.translate(sel.all(), [0.6, 0, 0]);
  m.mirror({ axis: 'x' });
  m.markSharp(sel.edges.dihedral('>', 40));
  m.assign(sel.mirrored(), 'mirror');
  return m;
}

/** Sweeps (bent polyline, helix, morph with twist), a loft and arrays: frames, miters and resampling. */
function sweepSample(): Model {
  const ring = (r: number, n: number, phase = 0): [number, number][] =>
    Array.from({ length: n }, (_, k) => {
      const a = ((k + phase) * 2 * Math.PI) / n;
      return [Math.round(r * Math.cos(a) * 1e9) / 1e9, Math.round(r * Math.sin(a) * 1e9) / 1e9];
    });
  const m = model();
  m.sweep({
    profile: ring(0.02, 10),
    path: path.polyline(
      [
        [0, 0, 0],
        [0.4, 0.1, 0],
        [0.4, 0.1, 0.5],
      ],
      { radius: 0.1, segments: 6 },
    ),
    label: 'arm',
  });
  m.sweep({
    profile: ring(0.006, 8),
    path: path.helix({ radius: 0.05, pitch: 0.03, turns: 4.5, segments: 18, center: [0.8, 0, 0] }),
    label: 'spring',
  });
  m.sweep({
    profile: [ring(0.05, 4, 0.5), ring(0.04, 9)],
    path: path.catmullRom(
      [
        [0, 0.3, 0],
        [0.3, 0.5, 0.2],
        [0.6, 0.3, 0.4],
      ],
      6,
    ),
    twist: [0, 120],
    scale: [1, 0.7],
    segments: 2,
    label: 'horn',
  });
  m.loft({
    profiles: [
      ring(0.1, 4, 0.5).map(([x, z]) => [x, -0.3, z] as [number, number, number]),
      ring(0.08, 12).map(([x, z]) => [x, -0.1, z] as [number, number, number]),
      ring(0.05, 6).map(([x, z]) => [x, 0, z] as [number, number, number]),
    ],
    segments: 2,
    label: 'boot',
  });
  m.array(sel.createdBy('spring'), { linear: { count: 2, offset: [0, 0, 0.3] }, label: 'pair' });
  m.cylinder({
    radiusTop: 0.01,
    radiusBottom: 0.01,
    height: 0.02,
    radialSegments: 6,
    center: [0.15, -0.3, 0],
    tag: 'stud',
  });
  m.array(sel.tag('stud'), { radial: { count: 5, axis: 'y' } });
  m.uv.project({ mode: 'box', scale: 0.1, faces: sel.tag('stud') });
  return m;
}

/**
 * Voxel and remesh jobs: winding-number SDFs, smooth union, sharp Surface Nets, isotropic
 * remesh with a sharp loop, QEM with the volume constraint and corner transfer.
 */
function voxelRemeshSample(): Model {
  const m = model();
  m.torus({ radius: 0.4, tube: 0.12, radialSegments: 12, tubularSegments: 32, tag: 'ring' });
  m.box({ size: [0.3, 1, 0.3], tag: 'post' });
  m.voxel.union(undefined, { voxelSize: 0.04, radius: 0.08, smooth: 1, label: 'knot' });
  m.bisect({ point: [0, 0.2, 0], normal: [0, 1, 0] });
  m.markSharp(sel.side([0, 0.2, 0], [0, 1, 0], { by: 'centroid' }).boundary());
  m.remesh(undefined, { targetEdgeLength: 0.07, iterations: 3 });
  m.uv.project({ mode: 'box', scale: 0.5 });
  m.simplify(undefined, { targetFaces: 700, preserve: { uvSeams: false } });
  const block = model();
  block.box({ size: [0.4, 0.4, 0.4], center: [1.2, 0, 0] });
  const grid = block.voxel.fromMesh(undefined, { voxelSize: 0.05, band: 2, sign: 'parity' });
  m.voxel.toMesh(grid, { sharp: true, label: 'block' });
  m.uv.project({ mode: 'box', scale: 0.5, faces: sel.createdBy('block') });
  return m;
}

/** Subdivision plus every deformer: crease rules, Bernstein, mean value, trig and curve frames. */
function deformSample(): Model {
  const m = model();
  m.box({ size: [0.2, 1, 0.2], center: [0, 0.5, 0], segments: [2, 6, 2], tag: 'bar' });
  m.markSharp(sel.edges.parallel('y'));
  m.subdivide(undefined, { levels: 1 });
  m.twist(sel.all(), { axis: 'y', angle: 70 });
  m.taper(sel.all(), { axis: 'y', factor: 0.6, axes: ['x'] });
  m.bend(sel.all(), { axis: 'y', toward: '+x', angle: 40, range: [0.3, 1] });
  m.lattice(sel.all(), {
    resolution: [3, 3, 3],
    offsets: [{ index: [1, 2, 1], offset: [0, 0.05, 0.03] }],
  });
  const c = 2;
  m.cage(sel.all(), {
    cage: {
      points: [
        [-c, -c, -c],
        [c, -c, -c],
        [c, c, -c],
        [-c, c, -c],
        [-c, -c, c],
        [c, -c, c],
        [c, c, c],
        [-c, c, c],
      ],
      faces: [
        [0, 3, 2, 1],
        [4, 5, 6, 7],
        [0, 1, 5, 4],
        [2, 3, 7, 6],
        [1, 2, 6, 5],
        [0, 4, 7, 3],
      ],
    },
    deformed: [
      [-c, -c, -c],
      [c, -c, -c],
      [c, c, -c],
      [-c, c, -c],
      [-c, -c, c],
      [c, -c, c],
      [2.4, 2.2, 2.1],
      [-c, c, c],
    ],
  });
  m.smooth(sel.all(), { iterations: 2 });
  m.curveDeform(sel.all(), {
    path: path.arc({ radius: 1.5, angle: 60, segments: 24, axis: 'z' }),
    axis: 'y',
  });
  m.uv.project({ mode: 'box', scale: 0.2 });
  return m;
}

/** Automatic charts on a subdivided part, and a vertex-target bake (BVH rays, AO, curvature). */
export function autoBakeSample(cache?: ByteCache, rays = 16): Model {
  const base = model();
  base.sphere({ radius: 0.5, widthSegments: 12, heightSegments: 8 });
  const detail = model();
  detail.sphere({ radius: 0.5, widthSegments: 48, heightSegments: 24 });
  detail.box({ size: [0.3, 0.3, 0.3], center: [0.45, 0, 0] });
  const baked = bakeMaps({
    base,
    detail,
    maps: ['ao', 'curvature'],
    target: 'vertex',
    ao: { rays },
    ...(cache === undefined ? {} : { cache }),
  });
  if (!baked.ok) throw baked.error;
  const m = model();
  m.append(baked.value.colored as Uint8Array);
  m.uv.auto({ resolution: 512, padding: 4 });
  return m;
}

const frozen = (name: string) => (states: FrozenStates) => restored(states, name);

/**
 * Builds whose FXEM and MeshAsset bytes must not depend on the run or the realm. Frozen
 * final states prove the FXEM round trip and the export; their operators no longer run here.
 */
export const DETERMINISM_FIXTURES: Readonly<
  Record<string, (states: FrozenStates, cache?: ByteCache) => Model>
> = {
  'crate-default': frozen('crate-default'),
  'crate-variant': frozen('crate-variant'),
  'kernel-sample': kernelSample,
  'boolean-panel': frozen('panel'),
  'sweep-sample': sweepSample,
  'bevel-bracket': frozen('bracket'),
  'shell-housing': frozen('housing'),
  'subdivide-deform': deformSample,
  'subdivide-pauldron': pauldron,
  'uv-wheel': frozen('wheel'),
  'voxel-remesh': voxelRemeshSample,
  // uv.chart farthest-point patches merged by ExpMap distortion, then unwrap and pack.
  'uv-auto-pauldron': (states) => {
    const m = pauldron(states);
    m.uv.auto({ resolution: 1024, padding: 4 });
    return m;
  },
  'bake-vertex': (_states, cache) => autoBakeSample(cache),
  'arap-forearm': frozen('forearm'),
};

function meshBytes(mesh: MeshAsset): Uint8Array {
  const parts: Uint8Array[] = [];
  const text = (value: unknown) => parts.push(new TextEncoder().encode(JSON.stringify(value)));
  const attributes = mesh.attributes as unknown as Record<string, ArrayBufferView | undefined>;
  for (const key of Object.keys(attributes).sort()) {
    const data = attributes[key];
    if (data === undefined) continue;
    text(key);
    parts.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  const indices = mesh.indices as ArrayBufferView;
  text(indices.constructor.name);
  parts.push(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength));
  text({ submeshes: mesh.submeshes, slots: mesh.materialSlots, aabb: Array.from(mesh.aabb ?? []) });
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface FixtureDigest {
  readonly fxem: string;
  readonly mesh: string;
  readonly fxemBytes: number;
  readonly triangles: number;
}

/** SHA-256 of one build's FXEM snapshot and exported MeshAsset buffers. */
export async function digestOf(m: Model): Promise<FixtureDigest> {
  const exported = m.toMesh({ normals: { mode: 'weighted' } });
  if (!exported.ok) throw exported.error;
  const fxem = m.snapshot();
  return {
    fxem: await sha256(fxem),
    mesh: await sha256(meshBytes(exported.value.mesh)),
    fxemBytes: fxem.length,
    triangles: exported.value.report.triangles,
  };
}

/**
 * SHA-256 of each fixture's FXEM snapshot and exported MeshAsset buffers; `cache` is the
 * compute-job store handed to the builds that run cached jobs.
 */
export async function fixtureDigests(cache?: ByteCache): Promise<Record<string, FixtureDigest>> {
  const states = await loadFrozenStates();
  const out: Record<string, FixtureDigest> = {};
  for (const [name, build] of Object.entries(DETERMINISM_FIXTURES)) {
    out[name] = await digestOf(build(states, cache));
  }
  return out;
}
