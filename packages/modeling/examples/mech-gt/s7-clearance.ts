import type { Pose, Rig } from '@forgeax/engine-modeling';
import type { MeshAsset } from '@forgeax/engine-types';
import { PackageId } from '@forgeax/engine-pack/guid';
import { type Affine, add, cross, dot, norm, scale, sub, type V3 } from './s7-drives.ts';

/**
 * Case C-100 stage S7 (code name mech-gt): a fast clearance probe for placing drives and
 * mechanism hardware. Every rigid part of a rig is reduced to its triangles in its joint's
 * rest frame (the rig's own part export); a candidate is a capsule (a cylinder body, a rail,
 * a hinge leaf) whose ends ride joints, and the probe reports the parts it comes closer to
 * than its radius at a set of poses (`allow` accepts a given penetration for fastened parts). It only guides the search: `model interference` on the
 * whole assembly stays the acceptance check.
 */
interface ProbePart {
  readonly name: string;
  readonly joint: string;
  /** Triangles in the joint's rest frame, 9 floats each. */
  readonly tris: Float32Array;
  readonly min: V3;
  readonly max: V3;
}

export interface Probe {
  readonly parts: readonly ProbePart[];
  /** Joint transforms of a pose by name. */
  readonly worlds: (pose: Pose) => ReadonlyMap<string, Affine>;
}

export function probeOf(r: Rig): Probe {
  const id = PackageId.parse('01900000-0000-7000-8000-0000000c10ff');
  if (!id.ok) throw id.error;
  const out = r.finish({ key: 'probe', packageId: id.value });
  if (!out.ok) throw out.error;
  const bound = r.parts();
  if (!bound.ok) throw bound.error;
  const parts: ProbePart[] = [];
  for (const p of bound.value) {
    const mesh = out.value[`mesh/probe.${p.name}`] as MeshAsset | undefined;
    if (mesh === undefined) continue;
    const pos = mesh.attributes.position as Float32Array;
    const idx = mesh.indices as Uint32Array | Uint16Array;
    const tris = new Float32Array(idx.length * 3);
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < idx.length; i++) {
      for (let k = 0; k < 3; k++) {
        const v = pos[(idx[i] as number) * 3 + k] as number;
        tris[i * 3 + k] = v;
        min[k] = Math.min(min[k] as number, v);
        max[k] = Math.max(max[k] as number, v);
      }
    }
    parts.push({ name: p.name, joint: p.joint, tris, min, max });
  }
  return {
    parts,
    worlds: (pose) => {
      const posed = r.pose(pose);
      if (!posed.ok) throw posed.error;
      return new Map(posed.value.joints.map((j) => [j.name, j.world]));
    },
  };
}

/** A world point into a joint's frame. */
function toLocal(w: Affine, p: V3): V3 {
  const d = [p[0] - (w[3] as number), p[1] - (w[7] as number), p[2] - (w[11] as number)];
  return [0, 1, 2].map((c) => (w[c] as number) * (d[0] as number) + (w[4 + c] as number) * (d[1] as number) + (w[8 + c] as number) * (d[2] as number)) as unknown as V3;
}

/** Closest points of two segments; returns the distance. */
function segmentSegment(p1: V3, q1: V3, p2: V3, q2: V3): number {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s = 0;
  let t = 0;
  if (a <= 1e-12 && e <= 1e-12) return norm(r);
  if (a <= 1e-12) t = Math.min(1, Math.max(0, f / e));
  else {
    const c = dot(d1, r);
    if (e <= 1e-12) s = Math.min(1, Math.max(0, -c / a));
    else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  return norm(sub(add(p1, scale(d1, s)), add(p2, scale(d2, t))));
}

/** Distance of a point from a triangle, or -1 when the point projects outside it. */
function pointInside(p: V3, a: V3, b: V3, c: V3): number {
  const n = cross(sub(b, a), sub(c, a));
  const l = norm(n);
  if (l < 1e-14) return -1;
  const u = scale(n, 1 / l);
  const d = dot(sub(p, a), u);
  const q = sub(p, scale(u, d));
  const inside = [[a, b], [b, c], [c, a]].every(([x, y]) => dot(cross(sub(y as V3, x as V3), sub(q, x as V3)), n) >= 0);
  return inside ? Math.abs(d) : -1;
}

/** Distance between a segment and a triangle. */
function segmentTriangle(p: V3, q: V3, a: V3, b: V3, c: V3): number {
  // Crossing: the segment pierces the triangle.
  const n = cross(sub(b, a), sub(c, a));
  const dp = dot(sub(p, a), n);
  const dq = dot(sub(q, a), n);
  if (dp * dq < 0) {
    const x = add(p, scale(sub(q, p), dp / (dp - dq)));
    if (pointInside(x, a, b, c) >= 0) return 0;
  }
  let best = Math.min(segmentSegment(p, q, a, b), segmentSegment(p, q, b, c), segmentSegment(p, q, c, a));
  for (const e of [p, q]) {
    const d = pointInside(e, a, b, c);
    if (d >= 0) best = Math.min(best, d);
  }
  return best;
}

/** A capsule between two points, each riding a joint (given in the rest pose). */
export interface Capsule {
  readonly a: V3;
  readonly aJoint: string;
  readonly b: V3;
  readonly bJoint: string;
  readonly radius: number;
}

/** Where a rest-pose point riding a joint is in a pose. */
function carried(rest: ReadonlyMap<string, Affine>, now: ReadonlyMap<string, Affine>, joint: string, p: V3): V3 {
  const l = toLocal(rest.get(joint) as Affine, p);
  const w = now.get(joint) as Affine;
  return [0, 1, 2].map((i) => (w[i * 4] as number) * l[0] + (w[i * 4 + 1] as number) * l[1] + (w[i * 4 + 2] as number) * l[2] + (w[i * 4 + 3] as number)) as unknown as V3;
}

/**
 * Parts within a capsule's radius at any of the poses (with the smallest gap found, negative
 * inside), skipping `skip`. Each pose is the joint transforms from `Probe.worlds`.
 */
export function capsuleHits(probe: Probe, rest: ReadonlyMap<string, Affine>, poses: readonly ReadonlyMap<string, Affine>[], capsules: readonly Capsule[], skip: ReadonlySet<string>, allow: ReadonlyMap<string, number> = new Map()): Map<string, number> {
  const hits = new Map<string, number>();
  for (const now of poses) {
    for (const cap of capsules) {
      const wa = carried(rest, now, cap.aJoint, cap.a);
      const wb = carried(rest, now, cap.bJoint, cap.b);
      for (const part of probe.parts) {
        if (skip.has(part.name)) continue;
        const w = now.get(part.joint) as Affine;
        const la = toLocal(w, wa);
        const lb = toLocal(w, wb);
        const r = cap.radius;
        if ([0, 1, 2].some((k) => Math.min(la[k] as number, lb[k] as number) - r > (part.max[k] as number) || Math.max(la[k] as number, lb[k] as number) + r < (part.min[k] as number))) continue;
        let best = Infinity;
        const t = part.tris;
        for (let i = 0; i < t.length && best > 0; i += 9) {
          const ta: V3 = [t[i] as number, t[i + 1] as number, t[i + 2] as number];
          const tb: V3 = [t[i + 3] as number, t[i + 4] as number, t[i + 5] as number];
          const tc: V3 = [t[i + 6] as number, t[i + 7] as number, t[i + 8] as number];
          // Triangle bounds against the capsule's.
          let skipTri = false;
          for (let k = 0; k < 3; k++) {
            const lo = Math.min(ta[k] as number, tb[k] as number, tc[k] as number);
            const hi = Math.max(ta[k] as number, tb[k] as number, tc[k] as number);
            if (lo > Math.max(la[k] as number, lb[k] as number) + r || hi < Math.min(la[k] as number, lb[k] as number) - r) skipTri = true;
          }
          if (skipTri) continue;
          best = Math.min(best, segmentTriangle(la, lb, ta, tb, tc));
        }
        const gap = best - r;
        if (gap < -(allow.get(part.name) ?? 0)) hits.set(part.name, Math.min(hits.get(part.name) ?? 0, gap));
      }
    }
  }
  return hits;
}
