import { coloredMesh, curvatureShading, overlayMesh, surfaceField, zebraStripes } from '@forgeax/engine-modeling';
import type { MeshAsset } from '@forgeax/engine/types';
import { err, ok, type Result } from '@forgeax/engine/types';

/**
 * Surface views of a part mesh for the interactive pages: mean-curvature shading, zebra
 * stripes from one fixed light (baked in the part's own frame; no subdivision, so a view stays
 * interactive on large parts) and facet edges. Values come
 * from the forgeax-modeling surface analysis (mesh estimates; the cooked mesh carries no
 * NURBS patches), so they read the shape the renderer draws.
 */
export type ShowAnalysis = 'off' | 'curvature' | 'zebra' | 'edges';

export const SHOW_ANALYSES: readonly ShowAnalysis[] = ['off', 'curvature', 'zebra', 'edges'];

type Vec3 = readonly [number, number, number];

/** Light-tube frame of the zebra view, in the part's local frame. */
export interface ZebraFrame {
  readonly direction: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
}

/**
 * The analysis mesh of one part: a replacement surface (`analysis` slot, vertex colors) for
 * curvature and zebra, an extra line overlay (`Overlay` slot) for edges.
 */
export function analysisMesh(mesh: MeshAsset, mode: Exclude<ShowAnalysis, 'off'>, zebra: ZebraFrame): Result<MeshAsset, Error> {
  if (mode === 'edges') return facetEdges(mesh);
  const field = surfaceField(mesh);
  if (!field.ok) return err(new Error(field.error.code));
  const colored =
    mode === 'curvature'
      ? curvatureShading(field.value, { kind: 'mean' })
      : zebraStripes(field.value, [], { direction: [...zebra.direction], right: [...zebra.right], up: [...zebra.up], width: 6, refine: 0 });
  if (!colored.ok) return err(new Error(colored.error.code));
  const built = coloredMesh(colored.value);
  return built.ok ? ok(built.value) : err(new Error(built.error.code));
}

/** Edges between triangles whose normals differ by more than `minAngleDeg` (facets of a low-poly
 * surface, creases), plus open borders; a smooth surface's tessellation stays unmarked. */
export function facetEdges(mesh: MeshAsset, minAngleDeg = 12): Result<MeshAsset, Error> {
  const positions = mesh.attributes.position;
  if (!(positions instanceof Float32Array)) return err(new Error('mesh without float32 positions'));
  const list: number[] = [];
  for (const submesh of mesh.submeshes) {
    if (submesh.topology !== 'triangle-list') continue;
    for (let i = submesh.indexOffset; i < submesh.indexOffset + submesh.indexCount; i++)
      list.push(mesh.indices === undefined ? i : (mesh.indices[i] as number));
  }
  const indices = Uint32Array.from(list);
  // Weld by position so attribute seams do not read as edges.
  const weld = new Map<string, number>();
  const id = new Uint32Array(positions.length / 3);
  for (let v = 0; v < id.length; v++) {
    const key = `${positions[3 * v]?.toFixed(5)},${positions[3 * v + 1]?.toFixed(5)},${positions[3 * v + 2]?.toFixed(5)}`;
    let w = weld.get(key);
    if (w === undefined) {
      w = weld.size;
      weld.set(key, w);
    }
    id[v] = w;
  }
  const normal = (t: number): Vec3 => {
    const p = (k: number) => {
      const v = indices[3 * t + k] as number;
      return [positions[3 * v] as number, positions[3 * v + 1] as number, positions[3 * v + 2] as number] as const;
    };
    const a = p(0);
    const b = p(1);
    const c = p(2);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    return [n[0]! / l, n[1]! / l, n[2]! / l];
  };
  const edges = new Map<string, { a: number; b: number; faces: number[] }>();
  const triangles = indices.length / 3;
  for (let t = 0; t < triangles; t++) {
    for (let k = 0; k < 3; k++) {
      const a = indices[3 * t + k] as number;
      const b = indices[3 * t + ((k + 1) % 3)] as number;
      const ka = id[a] as number;
      const kb = id[b] as number;
      if (ka === kb) continue;
      const key = ka < kb ? `${ka}:${kb}` : `${kb}:${ka}`;
      const edge = edges.get(key);
      if (edge === undefined) edges.set(key, { a, b, faces: [t] });
      else edge.faces.push(t);
    }
  }
  const cosLimit = Math.cos((minAngleDeg * Math.PI) / 180);
  const line: number[] = [];
  for (const edge of edges.values()) {
    let crease = edge.faces.length !== 2;
    if (!crease) {
      const n0 = normal(edge.faces[0] as number);
      const n1 = normal(edge.faces[1] as number);
      crease = n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < cosLimit;
    }
    if (!crease) continue;
    for (const v of [edge.a, edge.b]) line.push(positions[3 * v] as number, positions[3 * v + 1] as number, positions[3 * v + 2] as number);
  }
  if (line.length === 0) return err(new Error('no facet edges'));
  const built = overlayMesh({ position: new Float32Array(line) }, 'line-list');
  return built.ok ? ok(built.value) : err(new Error(built.error.code));
}
