// Draws the placed scene as one lit picture: each placement's LOD0 mesh is transformed to world space with the
// same rotation, scale and translation the manifest reports, then rasterised with the hero example's rasteriser.
import { type LitFrame, type LitMesh, type LitPicture, litFrame, rasterLitPicture, VIEWS3 } from '../hero-asset/raster3d.ts';
import type { MeshAsset } from '@forgeax/engine-types';
import type { SceneManifest } from '../../src/scene-manifest.ts';
import type { SceneAsset } from '../../src/scene-manifest.ts';
import { type RGB } from '../brep-kit/image.ts';

export const PICTURE_SIZE = 720;

/** One colour per asset id; the scene is shaded by material slot family, not by identity. */
const PALETTE: Readonly<Record<string, RGB>> = {
  crate: [0.62, 0.42, 0.22],
  barrel: [0.5, 0.36, 0.2],
  pillar: [0.7, 0.68, 0.62],
};

function f32(a: unknown, name: string): Float32Array {
  if (a instanceof Float32Array) return a;
  throw new Error(`attribute ${name} is not float32`);
}

/** Rotates by the unit quaternion (xyzw) then scales the normal-side axes; normals use the inverse-transpose. */
function transformPoint(
  p: readonly [number, number, number],
  q: readonly [number, number, number, number],
  s: readonly [number, number, number],
  t: readonly [number, number, number],
): [number, number, number] {
  const [x, y, z] = [p[0] * s[0], p[1] * s[1], p[2] * s[2]];
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty) + t[0],
    y + qw * ty + (qz * tx - qx * tz) + t[1],
    z + qw * tz + (qx * ty - qy * tx) + t[2],
  ];
}

/** Two-sided normal transform: inverse of a non-uniform scale is the reciprocal per axis, then rotate and normalise. */
function transformNormal(
  n: readonly [number, number, number],
  q: readonly [number, number, number, number],
  s: readonly [number, number, number],
): [number, number, number] {
  const v = transformPoint([n[0] / s[0], n[1] / s[1], n[2] / s[2]], q, [1, 1, 1], [0, 0, 0]);
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Builds a LitMesh of every placement's LOD0 (the same level the manifest counts), expanded to one vertex
 * stream with per-triangle colour, mirroring winding for an odd negative-scale placement.
 */
export function worldLitMesh(
  scene: SceneManifest,
  assets: readonly SceneAsset[],
): { mesh: LitMesh; albedo: Float32Array; frame: LitFrame } {
  const byId = new Map(assets.map((a) => [a.id, a.asset.mesh as MeshAsset]));
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const colours: number[] = [];
  for (const inst of scene.instances) {
    const mesh = byId.get(inst.asset);
    if (mesh === undefined || mesh.indices === undefined) throw new Error(`no indexed mesh for ${inst.asset}`);
    const pos = f32(mesh.attributes.position, 'position');
    const nrm = f32(mesh.attributes.normal, 'normal');
    const idx = mesh.indices;
    const base = positions.length / 3;
    const colour = PALETTE[inst.asset] ?? [0.8, 0.8, 0.8];
    for (let v = 0; v < pos.length / 3; v++) {
      const p = transformPoint(
        [pos[v * 3] as number, pos[v * 3 + 1] as number, pos[v * 3 + 2] as number],
        inst.rotation,
        inst.scale,
        inst.position,
      );
      positions.push(...p);
      const n = transformNormal(
        [nrm[v * 3] as number, nrm[v * 3 + 1] as number, nrm[v * 3 + 2] as number],
        inst.rotation,
        inst.scale,
      );
      normals.push(...n);
    }
    for (let t = 0; t < idx.length; t += 3) {
      const a = base + (idx[t] as number);
      const b = base + (idx[t + 1] as number);
      const c = base + (idx[t + 2] as number);
      // A mirrored placement flips handedness; swap two corners so the lit side stays outward.
      if (inst.mirrored) indices.push(a, c, b);
      else indices.push(a, b, c);
      colours.push(...colour);
    }
  }
  const position = new Float32Array(positions);
  const mesh: LitMesh = {
    position,
    normal: new Float32Array(normals),
    indices: positions.length / 3 > 0xffff ? new Uint32Array(indices) : new Uint16Array(indices),
  };
  return { mesh, albedo: new Float32Array(colours), frame: litFrame(position) };
}

export function renderScene(
  scene: SceneManifest,
  assets: readonly SceneAsset[],
): Record<'iso' | 'top', LitPicture> {
  const { mesh, albedo, frame } = worldLitMesh(scene, assets);
  const out = {} as Record<'iso' | 'top', LitPicture>;
  for (const name of ['iso', 'top'] as const) {
    const view = VIEWS3.find((v) => v.name === name);
    if (view === undefined) throw new Error(`no view ${name}`);
    out[name] = rasterLitPicture(mesh, view, PICTURE_SIZE, frame, { albedo });
  }
  return out;
}
