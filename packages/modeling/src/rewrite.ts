import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from './errors';
import type { CornerChannelName, EditMesh } from './mesh';

/**
 * One corner of a rewritten face: vertex `v` takes its corner values from the
 * source corner `corner`, interpolates the source corners `from` -> `to` by `t`
 * (a point inserted along a face edge), or mixes source corners by `weights` (a
 * point inside the face). Corner ids refer to the mesh before the rewrite.
 */
export type CornerSource =
  | { readonly v: number; readonly corner: number }
  | { readonly v: number; readonly from: number; readonly to: number; readonly t: number }
  | { readonly v: number; readonly weights: readonly (readonly [number, number])[] };

/** Replace source face `face` by `loops`; every new face copies its attributes. */
export interface FaceRewrite {
  readonly face: number;
  readonly loops: readonly (readonly CornerSource[])[];
}

/** A source face's attributes, copied to each face that replaces it. */
interface FaceAttributes {
  readonly material: number;
  readonly label: number;
  readonly role: number;
  readonly flags: number;
  readonly tags: readonly number[];
}

const pairKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

/**
 * Rewrite faces in one step: remove the sources, add the replacement loops with
 * copied attributes and interpolated corner values, and re-apply edge intent.
 * An edge keeps the flags it had; a piece of a split edge takes the flags of the
 * edge it came from (`parent` maps an inserted vertex to its source edge ends);
 * an edge between vertex copies takes the flags of the edge between their
 * originals (`origin` maps a copy to its original); other new edges are smooth.
 */
export function rewriteFaces(
  mesh: EditMesh,
  rewrites: readonly FaceRewrite[],
  parent: ReadonlyMap<number, readonly [number, number]> = new Map(),
  origin: ReadonlyMap<number, number> = new Map(),
): Result<number[][], ModelingError> {
  const flags = new Map<string, number>();
  for (const { face } of rewrites) {
    for (const h of mesh.faceHalves(face)) {
      const f = mesh.eFlags[h >> 1] as number;
      if (f !== 0) {
        flags.set(
          pairKey(mesh.hVert[h] as number, mesh.hVert[mesh.hNext[h] as number] as number),
          f,
        );
      }
    }
  }
  // What the new faces read from the mesh before the rewrite, captured before any face id or
  // corner slot is reused: each source face's attributes and every referenced corner value
  // (a whole-mesh copy per rewrite would make many small rewrites quadratic).
  const attributes = new Map<number, FaceAttributes>();
  const before = new Map<CornerChannelName, Map<number, Float32Array | undefined>>();
  for (const name of mesh.channels.keys()) before.set(name, new Map());
  const keep = (h: number) => {
    for (const [name, values] of before) {
      if (!values.has(h)) values.set(h, mesh.corner(name, h)?.slice());
    }
  };
  for (const { face, loops } of rewrites) {
    const tags: number[] = [];
    for (let w = 0; w < mesh.tagWords; w++)
      tags.push(mesh.fTags[face * mesh.tagWords + w] as number);
    attributes.set(face, {
      material: mesh.fMaterial[face] as number,
      label: mesh.fLabel[face] as number,
      role: mesh.fRole[face] as number,
      flags: mesh.fFlags[face] as number,
      tags,
    });
    for (const loop of loops) {
      for (const c of loop) {
        if ('corner' in c) keep(c.corner);
        else if ('weights' in c) for (const [corner] of c.weights) keep(corner);
        else {
          keep(c.from);
          keep(c.to);
        }
      }
    }
  }
  const cornerOf = (name: CornerChannelName, h: number) => before.get(name)?.get(h);
  for (const { face } of rewrites) mesh.removeFace(face);
  const created: number[][] = [];
  for (const { face, loops } of rewrites) {
    const faces: number[] = [];
    for (const loop of loops) {
      const added = mesh.addFace(loop.map((c) => c.v));
      if (!added.ok) return added;
      const g = added.value;
      const a = attributes.get(face) as FaceAttributes;
      mesh.fMaterial[g] = a.material;
      mesh.fLabel[g] = a.label;
      mesh.fRole[g] = a.role;
      mesh.fFlags[g] = a.flags;
      for (const [w, word] of a.tags.entries()) mesh.fTags[g * mesh.tagWords + w] = word;
      const halves = mesh.faceHalves(g);
      for (const [i, c] of loop.entries()) {
        for (const [name, channel] of mesh.channels) {
          if (!before.has(name)) continue;
          const h = halves[i] as number;
          if ('corner' in c) {
            const value = cornerOf(name, c.corner);
            if (value !== undefined) mesh.setCorner(name, h, value);
            continue;
          }
          if ('weights' in c) {
            const value = new Float32Array(channel.dim);
            let complete = true;
            for (const [corner, w] of c.weights) {
              const source = cornerOf(name, corner);
              if (source === undefined) complete = false;
              else
                for (let k = 0; k < channel.dim; k++)
                  value[k] = (value[k] as number) + (source[k] as number) * w;
            }
            if (complete) mesh.setCorner(name, h, value);
            continue;
          }
          const from = cornerOf(name, c.from);
          const to = cornerOf(name, c.to);
          if (from === undefined || to === undefined) continue;
          const value = new Float32Array(channel.dim);
          for (let k = 0; k < channel.dim; k++) {
            value[k] = (from[k] as number) + ((to[k] as number) - (from[k] as number)) * c.t;
          }
          mesh.setCorner(name, h, value);
        }
      }
      faces.push(g);
    }
    created.push(faces);
  }
  const intent = (a: number, b: number): number => {
    const own = flags.get(pairKey(origin.get(a) ?? a, origin.get(b) ?? b));
    if (own !== undefined) return own;
    const pa = parent.get(a);
    const pb = parent.get(b);
    const source =
      pa !== undefined && (pb === undefined ? pa.includes(b) : pairKey(...pa) === pairKey(...pb))
        ? pa
        : pb?.includes(a)
          ? pb
          : undefined;
    return source === undefined ? 0 : (flags.get(pairKey(...source)) ?? 0);
  };
  for (const faces of created) {
    for (const g of faces) {
      for (const h of mesh.faceHalves(g)) {
        const f = intent(mesh.hVert[h] as number, mesh.hVert[mesh.hNext[h] as number] as number);
        if (f !== 0) mesh.eFlags[h >> 1] = f;
      }
    }
  }
  return ok(created);
}

/** A face's corners in loop order, as rewrite sources. */
export function faceCorners(mesh: EditMesh, f: number): CornerSource[] {
  return mesh.faceHalves(f).map((h) => ({ v: mesh.hVert[h] as number, corner: h }));
}
