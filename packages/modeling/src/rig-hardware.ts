import { type Affine, applyPoint, invertRigid } from './affine';
import { cos, sin } from './dmath';
import type { ModelingError } from './errors';
import { add, cross, dot, length, normalize, scale, sub, type Tuple3, windingNumber } from './geom';
import {
  closestPair,
  closestPoint,
  type PartGeometry,
  type Placement,
  partDistance,
  partGeometry,
} from './interference';
import { type Model, model } from './model';
import type { JointKind, LimitMode, Pose, Range } from './rig';

/** Settings of `rig.mountHardware` (defaults in brackets). */
export interface MountHardwareOptions {
  /** Material of joint elements: pins, knuckles, balls, rings, rails, carriages [none]. */
  readonly metal?: string;
  /** Material of arms, links, standoffs and pads [none]. */
  readonly frame?: string;
  /** Running clearance between the two halves of a joint element in meters [1e-4]. */
  readonly clearance?: number;
  /** Depth a pad sinks into the face it seats on, in meters [2e-4]. */
  readonly seat?: number;
  /**
   * Element radius as a fraction of the bounds diagonal of the parts the joint carries
   * (its subtree), clamped to [min, max] meters [0.03, 0.004, 0.02].
   */
  readonly size?: { readonly fraction?: number; readonly min?: number; readonly max?: number };
  /** Parts already touching within this gap need no standoff, in meters [5e-4]. */
  readonly gap?: number;
  /** Longest standoff post between two touch groups of one joint's parts, in meters [0.25]. */
  readonly reach?: number;
  /**
   * Which existing parts are hardware (default `mount-*`): a joint whose parts existing
   * hardware already links to its ancestor's parts at rest gets no element.
   */
  readonly hardware?: (part: string) => boolean;
  /** Seed joints as for `connectivity` (default the rig root): they and the joints above them get no element. */
  readonly roots?: readonly string[];
  /** A model-space box all hardware stays inside at rest (a car form's skin), when given. */
  readonly within?: { readonly min: Tuple3; readonly max: Tuple3 };
  /**
   * Poses besides rest in which every element, arm and post must keep clear of the parts
   * and of other joints' hardware (sample the transformation path) [none].
   */
  readonly poses?: readonly Pose[];
  /** How `poses` treat joint limits, as for `rig.pose` [`clamp`]. */
  readonly limits?: LimitMode;
}

/** The hardware family a joint kind gets: revolute and fixed `hinge`, spherical `ball`, prismatic `slide`. */
export type HardwareElement = 'hinge' | 'ball' | 'slide';

export interface MountHardwareReport {
  readonly status: 'ok' | 'failed' | 'skipped';
  readonly joints: readonly MountedJoint[];
  readonly pieces: number;
  readonly triangles: number;
  /** Elements left at their anchor because no spot near it keeps clear of the parts. */
  readonly embedded: number;
  /** What no clear route reached: those parts stay floating until their owner opens a path. */
  readonly unroutable: readonly UnroutableMount[];
  readonly error?: ModelingError;
}

export interface MountedJoint {
  readonly joint: string;
  /** The joint's own element (absent on the root). */
  readonly element?: HardwareElement;
  /** The rigid hardware part riding this joint (`mount-<joint>`). */
  readonly part: string;
  /** Pieces in that part (its element half, the parent halves of child elements, arms, posts). */
  readonly pieces: number;
  /** Arms from elements to the joint's parts or to its own element. */
  readonly arms: number;
  /** Standoffs closing the clearance between separate groups of the joint's parts. */
  readonly standoffs: number;
  /** Longest arm or standoff in meters. */
  readonly reach: number;
}

/** @internal A joint as hardware planning sees it (model space at rest). */
export interface HardwareJoint {
  readonly name: string;
  readonly parent: number;
  readonly kind: JointKind;
  /** Unit motion axis in model space (zero for fixed and spherical joints). */
  readonly axis: Tuple3;
  readonly anchor: Tuple3;
  readonly limits?: Range;
}

/** @internal One piece to build: a primitive placed by a frame, tagged for its joint's part. */
export interface HardwarePiece {
  readonly joint: number;
  /** Set on the pieces of a joint element (the joint it serves). */
  readonly element?: number;
  readonly material: 'metal' | 'frame';
  readonly shape:
    | { readonly kind: 'rod'; readonly from: Tuple3; readonly to: Tuple3; readonly radius: number }
    | {
        readonly kind: 'tube';
        readonly center: Tuple3;
        readonly axis: Tuple3;
        readonly inner: number;
        readonly outer: number;
        readonly height: number;
      }
    | { readonly kind: 'ball'; readonly center: Tuple3; readonly radius: number }
    | {
        readonly kind: 'box';
        readonly center: Tuple3;
        readonly axis: Tuple3;
        readonly across: Tuple3;
        readonly size: Tuple3;
      };
}

/** @internal The planned hardware: pieces per joint, parts each joint's hardware seats on, report rows. */
export interface HardwarePlan {
  readonly pieces: readonly HardwarePiece[];
  /** Per joint index: indices of the bound parts its hardware seats pads on. */
  /** Per joint index: the bound parts its hardware seats on, with the designed tolerance. */
  readonly seats: ReadonlyMap<number, ReadonlyMap<number, number>>;
  readonly joints: readonly (Omit<MountedJoint, 'joint' | 'part' | 'pieces'> & {
    readonly index: number;
  })[];
  /** Elements left at their anchor because no clear spot was found. */
  readonly embedded: number;
  readonly unroutable: readonly {
    readonly joint: number;
    readonly what: UnroutableMount['what'];
    readonly parts: readonly number[];
  }[];
}

const SEGMENTS = 12;
/** Alternative post ends tried when the closest pair of points is blocked. */
const POST_TRIES = 12;

function perpendicular(a: Tuple3): Tuple3 {
  return normalize(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
}

/** The part of `v` across `axis`, or a fixed perpendicular when `v` runs along it. */
function across(v: Tuple3, axis: Tuple3): Tuple3 {
  const r = sub(v, scale(axis, dot(v, axis)));
  return length(r) > 1e-9 ? normalize(r) : perpendicular(axis);
}

function elementOf(kind: JointKind): HardwareElement {
  return kind === 'spherical' ? 'ball' : kind === 'prismatic' ? 'slide' : 'hinge';
}

interface Obstacle {
  /** Joints whose own hardware may overlap it. */
  readonly owners: readonly number[];
  /** Set on an element's placement body (rods check the element's exact pieces instead). */
  readonly element?: number;
  readonly from: Tuple3;
  readonly to: Tuple3;
  readonly radius: number;
}

/** Squared distance between segments pq and rs. */
function segments2(p: Tuple3, q: Tuple3, r: Tuple3, s: Tuple3): number {
  const d1 = sub(q, p);
  const d2 = sub(s, r);
  const w = sub(p, r);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, w);
  let t1 = 0;
  let t2 = 0;
  if (a <= 1e-18 && e <= 1e-18) {
    // Both points.
  } else if (a <= 1e-18) {
    t2 = Math.min(1, Math.max(0, f / e));
  } else {
    const c = dot(d1, w);
    if (e <= 1e-18) {
      t1 = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      t1 = denom > 0 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t2 = (b * t1 + f) / e;
      if (t2 < 0) {
        t2 = 0;
        t1 = Math.min(1, Math.max(0, -c / a));
      } else if (t2 > 1) {
        t2 = 1;
        t1 = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  const x = sub(add(p, scale(d1, t1)), add(r, scale(d2, t2)));
  return dot(x, x);
}

/** A seated end: a point on a part's face with the face normal pointing toward the hardware. */
interface Seat {
  readonly part: number;
  readonly point: Tuple3;
  readonly normal: Tuple3;
  readonly distance: number;
}

/** A place the hardware could not reach without passing through a part or other hardware. */
export interface UnroutableMount {
  readonly joint: string;
  /** `element`: no clear spot for the joint element; `arm`: no clear route to the parts; `standoff`: two touch groups of one joint stayed apart. */
  readonly what: 'element' | 'arm' | 'standoff';
  /** Parts the route was meant to reach. */
  readonly parts: readonly string[];
}

/**
 * @internal Plan rigid hardware that connects every bound part to the roots at rest. Each
 * joint that needs one gets an element on its locus (a hinge anywhere on its axis, a slide
 * rail anywhere parallel to it, a ball at its anchor) where it sits closest to both sides;
 * arms seat on the nearest faces and standoff posts join separate touch groups of one
 * joint's parts (a minimum spanning tree). Every element, arm and post keeps clear of all
 * parts except the faces it seats on and of other joints' hardware; what cannot is reported.
 */
export function planHardware(
  joints: readonly HardwareJoint[],
  parts: readonly { readonly joint: number; readonly geometry: PartGeometry }[],
  placement: Placement,
  linked: ReadonlySet<number>,
  frames: readonly (readonly Affine[])[],
  options: MountHardwareOptions,
): HardwarePlan {
  const clearance = options.clearance ?? 1e-4;
  const seat = options.seat ?? 2e-4;
  const gap = options.gap ?? 5e-4;
  const postReach = options.reach ?? 0.25;
  const fraction = options.size?.fraction ?? 0.03;
  const minSize = options.size?.min ?? 0.004;
  const maxSize = options.size?.max ?? 0.02;
  const margin = 1e-3;
  const pieces: HardwarePiece[] = [];
  const seats = new Map<number, Map<number, number>>();
  const unroutable: { joint: number; what: UnroutableMount['what']; parts: number[] }[] = [];
  const geometry = parts.map((p) => p.geometry);

  // Subtree bounds per joint, and which joints carry parts in their subtree.
  const lo = joints.map(() => [Infinity, Infinity, Infinity]);
  const hi = joints.map(() => [-Infinity, -Infinity, -Infinity]);
  const carried = joints.map(() => false);
  for (const p of parts) {
    const pts = p.geometry.points;
    for (let j = p.joint; j >= 0; j = (joints[j] as HardwareJoint).parent) {
      carried[j] = true;
      for (let i = 0; i < pts.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const v = pts[i + k] as number;
          if (v < (lo[j]?.[k] as number)) (lo[j] as number[])[k] = v;
          if (v > (hi[j]?.[k] as number)) (hi[j] as number[])[k] = v;
        }
      }
    }
  }
  const radius = joints.map((_, j) => {
    const d = carried[j] ? length(sub(hi[j] as unknown as Tuple3, lo[j] as unknown as Tuple3)) : 0;
    return Math.min(maxSize, Math.max(minSize, fraction * d));
  });
  const own = joints.map((_, j) => parts.flatMap((p, i) => (p.joint === j ? [i] : [])));
  const boxes = geometry.map((g) => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.points.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = g.points[i + k] as number;
        if (v < (b[k] as number)) b[k] = v;
        if (v > (b[k + 3] as number)) b[k + 3] = v;
      }
    }
    return b;
  });
  const boxDistance = (i: number, c: Tuple3) => {
    const b = boxes[i] as number[];
    let s2 = 0;
    for (let k = 0; k < 3; k++) {
      const v = c[k] as number;
      const d =
        v < (b[k] as number)
          ? (b[k] as number) - v
          : v > (b[k + 3] as number)
            ? v - (b[k + 3] as number)
            : 0;
      s2 += d * d;
    }
    return Math.sqrt(s2);
  };

  // Clearance against the parts (but `except`), other joints' rods and placed element
  // pieces (exact geometry), and the `within` box.
  const NONE = new Set<number>();
  const obstacles: Obstacle[] = [];
  const solids: {
    owner: number;
    element: number;
    geometry: PartGeometry;
    box: number[];
    posed: number[][];
  }[] = [];
  const within = options.within;
  const inside = (c: Tuple3, reach: number) =>
    within === undefined ||
    [0, 1, 2].every(
      (k) =>
        (c[k] as number) - reach >= (within.min[k] as number) &&
        (c[k] as number) + reach <= (within.max[k] as number),
    );
  // Poses beyond rest: per pose, per joint, the rest-to-posed transform and its inverse,
  // and every part's posed bounds.
  const posed = frames.map((to) => ({ to, from: to.map(invertRigid) }));
  const boundsOf = (box: readonly number[], m: Affine): number[] => {
    const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let corner = 0; corner < 8; corner++) {
      const q = applyPoint(m, [
        box[corner & 1 ? 3 : 0] as number,
        box[corner & 2 ? 4 : 1] as number,
        box[corner & 4 ? 5 : 2] as number,
      ]);
      for (let k = 0; k < 3; k++) {
        if ((q[k] as number) < (out[k] as number)) out[k] = q[k] as number;
        if ((q[k] as number) > (out[k + 3] as number)) out[k + 3] = q[k] as number;
      }
    }
    return out;
  };
  const partBoxes = posed.map((f) =>
    boxes.map((b, i) => boundsOf(b, f.to[parts[i]?.joint as number] as Affine)),
  );
  const outside = (box: readonly number[], c: Tuple3, reach: number) => {
    for (let k = 0; k < 3; k++) {
      if (
        (c[k] as number) < (box[k] as number) - reach ||
        (c[k] as number) > (box[k + 3] as number) + reach
      ) {
        return true;
      }
    }
    return false;
  };
  /** Whether a point riding `joint` lies inside a closed part but `except`, at rest or in a pose. */
  const enclosed = (c: Tuple3, joint: number, except: ReadonlySet<number>) => {
    for (let i = 0; i < geometry.length; i++) {
      const g = geometry[i] as PartGeometry;
      if (!g.closed || except.has(i) || boxDistance(i, c) > 0) continue;
      if (windingNumber(g.mesh, g.faces, c) > 0.5) return true;
    }
    for (const [k, f] of posed.entries()) {
      const w = applyPoint(f.to[joint] as Affine, c);
      for (let i = 0; i < geometry.length; i++) {
        const g = geometry[i] as PartGeometry;
        const pj = parts[i]?.joint as number;
        if (!g.closed || except.has(i) || pj === joint) continue;
        if (outside((partBoxes[k] as number[][])[i] as number[], w, 0)) continue;
        if (windingNumber(g.mesh, g.faces, applyPoint(f.from[pj] as Affine, w)) > 0.5) return true;
      }
    }
    return false;
  };
  /** A point riding `joint` keeps `reach` from every part but `except`, at rest and in each pose. */
  const partsClear = (c: Tuple3, reach: number, except: ReadonlySet<number>, joint: number) => {
    for (let i = 0; i < geometry.length; i++) {
      if (except.has(i) || boxDistance(i, c) > reach) continue;
      const q = closestPoint(geometry[i] as PartGeometry, c);
      if (q !== undefined && q.distance <= reach) return false;
    }
    for (const [k, f] of posed.entries()) {
      const w = applyPoint(f.to[joint] as Affine, c);
      for (let i = 0; i < geometry.length; i++) {
        const pj = parts[i]?.joint as number;
        if (
          except.has(i) ||
          pj === joint ||
          outside((partBoxes[k] as number[][])[i] as number[], w, reach)
        )
          continue;
        const q = closestPoint(geometry[i] as PartGeometry, applyPoint(f.from[pj] as Affine, w));
        if (q !== undefined && q.distance <= reach) return false;
      }
    }
    return true;
  };
  const solidsClear = (c: Tuple3, reach: number, joint: number, skipElement: number) => {
    for (const s of solids) {
      if (s.owner === joint || s.element === skipElement) continue;
      if (!outside(s.box, c, reach)) {
        const q = closestPoint(s.geometry, c);
        if (q !== undefined && q.distance <= reach) return false;
      }
      for (const [k, f] of posed.entries()) {
        const w = applyPoint(f.to[joint] as Affine, c);
        if (outside(s.posed[k] as number[], w, reach)) continue;
        const q = closestPoint(s.geometry, applyPoint(f.from[s.owner] as Affine, w));
        if (q !== undefined && q.distance <= reach) return false;
      }
    }
    return true;
  };
  /**
   * Element placement: a body point keeps clear of parts (riding `frame`, the joint the
   * element's center is fixed to), the box and other elements' bodies.
   */
  const pointClear = (c: Tuple3, reach: number, joint: number, frame: number) =>
    inside(c, reach) &&
    partsClear(c, reach, NONE, frame) &&
    obstacles.every(
      (o) =>
        o.owners.includes(joint) ||
        segments2(c, c, o.from, o.to) > (o.radius + reach) * (o.radius + reach),
    );
  /**
   * A rod of radius `r` riding `joint` from `a` to `b` keeps clear at rest and in each pose
   * (sampled a quarter radius apart): of the parts (a `seated` part only away from its
   * seat point, where the end sinks in), of other joints' rods and element pieces (but those
   * of `skipElement`, which its own geometry clears by construction), and of the box at
   * rest; and its middle lies inside no closed part.
   */
  const rodClear = (
    a: Tuple3,
    b: Tuple3,
    r: number,
    joint: number,
    seated: readonly { readonly part: number; readonly point: Tuple3 }[],
    skipElement = -1,
  ) => {
    const keep = Math.min(margin, r / 4);
    const d = length(sub(b, a));
    const n = Math.max(1, Math.ceil((4 * d) / r));
    const reach = r + keep + d / n / 2;
    if (!inside(a, r) || !inside(b, r)) return false;
    const rods = obstacles.filter((o) => !o.owners.includes(joint) && o.element === undefined);
    for (const o of rods) {
      const k2 = o.radius + r + keep;
      if (segments2(a, b, o.from, o.to) <= k2 * k2) return false;
      for (const f of posed) {
        const owner = o.owners[0] as number;
        const pa = applyPoint(f.to[joint] as Affine, a);
        const pb = applyPoint(f.to[joint] as Affine, b);
        const oa = applyPoint(f.to[owner] as Affine, o.from);
        const ob = applyPoint(f.to[owner] as Affine, o.to);
        if (segments2(pa, pb, oa, ob) <= k2 * k2) return false;
      }
    }
    const all = new Set(seated.map((x) => x.part));
    if (enclosed(scale(add(a, b), 0.5), joint, all)) return false;
    for (let k = 0; k <= n; k++) {
      const c = add(a, scale(sub(b, a), k / n));
      const except = new Set(
        seated.filter((x) => length(sub(c, x.point)) <= 1.5 * r + reach).map((x) => x.part),
      );
      if (!partsClear(c, reach, except, joint) || !solidsClear(c, reach, joint, skipElement)) {
        return false;
      }
    }
    return true;
  };
  const seatOn = (targets: readonly number[], from: Tuple3): Seat[] =>
    targets
      .map((t) => {
        const q = closestPoint(geometry[t] as PartGeometry, from);
        if (q === undefined) return undefined;
        const n = dot(q.normal, sub(from, q.point)) < 0 ? scale(q.normal, -1) : q.normal;
        return { part: t, point: q.point, normal: n, distance: q.distance };
      })
      .filter((x): x is Seat => x !== undefined)
      .sort((a, b) => a.distance - b.distance || a.part - b.part);
  const distanceTo = (targets: readonly number[], c: Tuple3) => {
    let best = Infinity;
    for (const t of targets) {
      if (boxDistance(t, c) >= best) continue;
      const q = closestPoint(geometry[t] as PartGeometry, c);
      if (q !== undefined && q.distance < best) best = q.distance;
    }
    return best;
  };
  const addRod = (
    joint: number,
    from: Tuple3,
    to: Tuple3,
    r: number,
    material: 'metal' | 'frame' = 'frame',
  ) => {
    if (length(sub(to, from)) <= 1e-6) return;
    pieces.push({ joint, material, shape: { kind: 'rod', from, to, radius: r } });
    obstacles.push({ owners: [joint], from, to, radius: r });
  };
  /** A seated end: the joint's mount part becomes a designed contact of the part, up to the arm radius. */
  const addSeat = (joint: number, part: number, r: number) => {
    const m = seats.get(joint) ?? new Map<number, number>();
    m.set(part, Math.max(m.get(part) ?? 0, 1e-3, r + seat));
    seats.set(joint, m);
  };

  /**
   * Route an arm of `joint` from one of `starts` (a start and an elbow, leaving `element`)
   * to the nearest reachable face of `targets`. Returns its length, or undefined when no
   * route keeps clear.
   */
  const route = (
    joint: number,
    starts: readonly (readonly [Tuple3, Tuple3])[],
    targets: readonly number[],
    element: number,
  ): number | undefined => {
    const r = 0.4 * (sizes[joint] as number);
    for (const [start, elbow] of starts) {
      if (!rodClear(start, elbow, r, joint, [], element)) continue;
      for (const s of seatOn(targets, elbow).slice(0, 6)) {
        if (!rodClear(elbow, s.point, r, joint, [s])) continue;
        addRod(joint, start, elbow, r);
        // The arm's end sinks `seat` into the face.
        addRod(joint, elbow, add(s.point, scale(s.normal, -seat)), r);
        addSeat(joint, s.part, r);
        return length(sub(s.point, start));
      }
    }
    return undefined;
  };

  // Element placement on each joint's locus, parents first.
  const centers: (Tuple3 | undefined)[] = joints.map(() => undefined);
  const sizes = [...radius];
  const blocked = new Set<number>();
  let embedded = 0;
  const bodyOf = (j: number, c: Tuple3, r: number): [Tuple3, number][] => {
    const joint = joints[j] as HardwareJoint;
    const element = elementOf(joint.kind);
    if (element === 'hinge') return [[c, 2.3 * r + margin]];
    if (element === 'ball') return [[c, 1.7 * r + margin]];
    const [vmin, vmax] = joint.limits ?? [0, 0];
    const out: [Tuple3, number][] = [];
    for (let t = vmin - 3 * r; t <= vmax + 3 * r + 1e-12; t += r)
      out.push([add(c, scale(joint.axis, t)), 1.6 * r + margin]);
    return out;
  };
  const sideOf = (j: number): { targets: readonly number[]; point?: Tuple3 } => {
    if ((own[j] as number[]).length > 0) return { targets: own[j] as number[] };
    const c = centers[j];
    return c === undefined ? { targets: [] } : { targets: [], point: c };
  };
  const reachOf = (side: { targets: readonly number[]; point?: Tuple3 }, c: Tuple3) =>
    side.point !== undefined
      ? length(sub(side.point, c))
      : side.targets.length > 0
        ? distanceTo(side.targets, c)
        : 0;
  for (const [j, joint] of joints.entries()) {
    if (j === 0 || !carried[j] || linked.has(j)) {
      centers[j] = joint.anchor;
      continue;
    }
    const element = elementOf(joint.kind);
    const child = sideOf(j);
    const parentSide = sideOf(joint.parent);
    const r0 = radius[j] as number;
    const candidates: Tuple3[] = [joint.anchor];
    const span = Math.max(0.3, length(sub(hi[j] as unknown as Tuple3, lo[j] as unknown as Tuple3)));
    if (element === 'hinge') {
      const a = joint.kind === 'fixed' ? undefined : joint.axis;
      const dirs: Tuple3[] =
        a !== undefined
          ? [a]
          : [
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ];
      for (const d of dirs)
        for (let t = r0; t <= span; t += r0)
          candidates.push(add(joint.anchor, scale(d, t)), add(joint.anchor, scale(d, -t)));
    } else if (element === 'slide') {
      const u = perpendicular(joint.axis);
      const v = normalize(cross(joint.axis, u));
      const step = 2 * r0;
      const n = Math.ceil(Math.min(span, 0.4) / step);
      for (let x = -n; x <= n; x++)
        for (let y = -n; y <= n; y++)
          if (x !== 0 || y !== 0)
            candidates.push(add(joint.anchor, add(scale(u, x * step), scale(v, y * step))));
    }
    const scored = candidates
      .map((c) => ({ c, score: reachOf(child, c) + reachOf(parentSide, c) }))
      .sort((x, y) => x.score - y.score);
    let found: Tuple3 | undefined;
    let size = r0;
    for (const scale_ of [1, 0.5]) {
      const r = Math.max(minSize / 2, r0 * scale_);
      for (const { c } of scored) {
        if (
          !enclosed(c, joint.parent, NONE) &&
          bodyOf(j, c, r).every(([p, reach]) => pointClear(p, reach, j, joint.parent))
        ) {
          found = c;
          size = r;
          break;
        }
      }
      if (found !== undefined) break;
    }
    if (found === undefined) {
      // No clear spot: the element is reported, not built inside the parts.
      embedded++;
      blocked.add(j);
      unroutable.push({ joint: j, what: 'element', parts: [...(own[j] as number[])] });
      centers[j] = joint.anchor;
      continue;
    }
    centers[j] = found;
    sizes[j] = size;
    // The element's two halves belong to the joint and its parent: both start arms inside it.
    for (const [p, reach] of bodyOf(j, found, size)) {
      obstacles.push({
        owners: [j, joint.parent],
        element: j,
        from: p,
        to: p,
        radius: reach - margin,
      });
    }
  }

  // Build elements and arms, parents first; a joint without parts links through its own element.
  type Starts = (target: Tuple3) => (readonly [Tuple3, Tuple3])[];
  const childStarts: Starts[] = joints.map((joint) => () => [[joint.anchor, joint.anchor]]);
  const parentStarts: (Starts | undefined)[] = joints.map(() => undefined);
  let hub = false;
  const rows: (Omit<MountedJoint, 'joint' | 'part' | 'pieces'> & { index: number })[] = [];
  const turns = (out: Tuple3, axis: Tuple3) => {
    const w = normalize(cross(axis, out));
    return [0, 45, -45, 90, -90, 135, -135, 180].map((deg) => {
      const t = (deg * Math.PI) / 180;
      return normalize(add(scale(out, cos(t)), scale(w, sin(t))));
    });
  };
  // Elements first, with the starts their arms leave from.
  for (const [j, joint] of joints.entries()) {
    if (!carried[j]) continue;
    const r = sizes[j] as number;
    const e = centers[j] as Tuple3;
    const element = j === 0 || linked.has(j) || blocked.has(j) ? undefined : elementOf(joint.kind);
    const parent = joint.parent;
    let childStart: Starts = () => [[e, e]];
    let parentStart: Starts | undefined;
    if (element !== undefined && parent >= 0) {
      if (element === 'hinge') {
        const a = joint.kind === 'fixed' ? ([0, 1, 0] as Tuple3) : joint.axis;
        pieces.push({
          joint: j,
          material: 'metal',
          element: j,
          shape: {
            kind: 'rod',
            from: add(e, scale(a, -2 * r)),
            to: add(e, scale(a, 2 * r)),
            radius: 0.5 * r,
          },
        });
        for (const side of [-1, 1]) {
          pieces.push({
            joint: parent,
            material: 'metal',
            element: j,
            shape: {
              kind: 'tube',
              center: add(e, scale(a, side * 1.5 * r)),
              axis: a,
              inner: 0.5 * r + clearance,
              outer: r,
              height: r,
            },
          });
        }
        // Elbows leave the pin in the middle slab, clear of the knuckles; a short one serves
        // a part closer than the long one.
        childStart = (target) =>
          turns(across(sub(target, e), a), a).flatMap((d) =>
            [2, 1.2].map((k) => [e, add(e, scale(d, k * r))] as const),
          );
        parentStart = (target) => {
          const side = dot(sub(target, e), a) >= 0 ? 1 : -1;
          const c = add(e, scale(a, side * 1.5 * r));
          return turns(across(sub(target, c), a), a).flatMap((d) =>
            [2, 1.2].map((k) => [add(c, scale(d, 0.75 * r)), add(c, scale(d, k * r))] as const),
          );
        };
      } else if (element === 'ball') {
        const childSide = sideOf(j);
        const toward =
          childSide.targets.length > 0
            ? (seatOn(childSide.targets, e)[0]?.point ?? add(e, [0, 1, 0]))
            : add(e, [0, 1, 0]);
        const dir =
          length(sub(toward, e)) > 1e-6 ? normalize(sub(toward, e)) : ([0, 1, 0] as Tuple3);
        pieces.push({
          joint: j,
          material: 'metal',
          element: j,
          shape: { kind: 'ball', center: e, radius: r },
        });
        pieces.push({
          joint: parent,
          material: 'metal',
          element: j,
          shape: {
            kind: 'tube',
            center: e,
            axis: dir,
            inner: r + clearance,
            outer: 1.6 * r,
            height: 0.6 * r,
          },
        });
        // Along the ring's axis the arm leaves the ball clear of the ring, at any length.
        childStart = () => [2.5, 1.2, 0].map((k) => [e, add(e, scale(dir, k * r))] as const);
        parentStart = (target) =>
          turns(across(sub(target, e), dir), dir).flatMap((d) =>
            [2.5, 1.7].map((k) => [add(e, scale(d, 1.5 * r)), add(e, scale(d, k * r))] as const),
          );
      } else {
        const a = joint.axis;
        const [vmin, vmax] = joint.limits ?? [0, 0];
        const carriage = 2 * r;
        const t0 = vmin - carriage - r;
        const t1 = vmax + carriage + r;
        const side = perpendicular(a);
        const other = normalize(cross(a, side));
        pieces.push({
          joint: parent,
          material: 'metal',
          element: j,
          shape: {
            kind: 'box',
            center: add(e, scale(a, (t0 + t1) / 2)),
            axis: a,
            across: side,
            size: [r, t1 - t0, r],
          },
        });
        const gapOut = r / 2 + clearance;
        const plate = 0.3 * r;
        for (const [n, w] of [
          [side, other],
          [scale(side, -1), other],
          [other, side],
          [scale(other, -1), side],
        ] as const) {
          pieces.push({
            joint: j,
            material: 'metal',
            element: j,
            shape: {
              kind: 'box',
              center: add(e, scale(n, gapOut + plate / 2)),
              axis: a,
              across: w,
              size: [r + 2 * (clearance + plate), carriage, plate],
            },
          });
        }
        childStart = (target) =>
          turns(across(sub(target, e), a), a).flatMap((d) =>
            [2.5, 1.1].map(
              (k) => [add(e, scale(d, gapOut + plate)), add(e, scale(d, k * r))] as const,
            ),
          );
        parentStart = (target) => {
          const end = dot(sub(target, e), a) >= (t0 + t1) / 2 ? t1 : t0;
          const c = add(e, scale(a, end));
          return turns(across(sub(target, c), a), a).flatMap((d) =>
            [2.5, 1.2].map((k) => [c, add(c, scale(d, k * r))] as const),
          );
        };
      }
      parentStarts[j] = parentStart;
    }
    childStarts[j] = childStart;
  }

  // Every element piece is an exact obstacle for the other side's arms and other joints.
  for (const piece of pieces) {
    const g = pieceGeometry(piece);
    if (g === undefined) continue;
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.points.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = g.points[i + k] as number;
        if (v < (b[k] as number)) b[k] = v;
        if (v > (b[k + 3] as number)) b[k + 3] = v;
      }
    }
    solids.push({
      owner: piece.joint,
      element: piece.element ?? -1,
      geometry: g,
      box: b,
      posed: posed.map((f) => boundsOf(b, f.to[piece.joint] as Affine)),
    });
  }

  // Arms and posts, parents first; a joint without parts links through its own element.
  for (const [j, joint] of joints.entries()) {
    if (!carried[j]) continue;
    const e = centers[j] as Tuple3;
    let arms = 0;
    let reach = 0;
    const element = j === 0 || linked.has(j) || blocked.has(j) ? undefined : elementOf(joint.kind);
    const parent = joint.parent;
    const parentStart = parentStarts[j];
    if (element !== undefined && parent >= 0 && parentStart !== undefined) {
      // The parent half reaches the parent's parts, or links to the parent's own element.
      const ps = sideOf(parent);
      if (ps.targets.length > 0) {
        const target = seatOn(ps.targets, e)[0]?.point ?? e;
        const got = route(parent, parentStart(target), ps.targets, j);
        if (got === undefined) unroutable.push({ joint: j, what: 'arm', parts: [...ps.targets] });
        else reach = Math.max(reach, got);
      } else if (blocked.has(parent)) {
        unroutable.push({ joint: j, what: 'arm', parts: [] });
      } else {
        const pe = centers[parent] as Tuple3;
        const lr = 0.4 * (sizes[parent] as number);
        let done = false;
        for (const [s, elbow] of parentStart(pe)) {
          for (const [ps2, pElbow] of (childStarts[parent] as Starts)(elbow)) {
            if (
              !rodClear(s, elbow, lr, parent, [], j) ||
              !rodClear(elbow, pElbow, lr, parent, []) ||
              !rodClear(pElbow, ps2, lr, parent, [], parent)
            )
              continue;
            addRod(parent, s, elbow, lr);
            addRod(parent, elbow, pElbow, lr);
            addRod(parent, pElbow, ps2, lr);
            reach = Math.max(reach, length(sub(pe, s)));
            done = true;
            break;
          }
          if (done) break;
        }
        if (!done) unroutable.push({ joint: j, what: 'arm', parts: [] });
        if (parent === 0 && !hub) {
          hub = true;
          pieces.push({
            joint: 0,
            material: 'frame',
            shape: { kind: 'ball', center: pe, radius: sizes[0] as number },
          });
        }
      }
    }
    const mine = own[j] as number[];
    if (mine.length > 0 && element !== undefined) {
      const target = seatOn(mine, e)[0]?.point ?? e;
      const got = route(j, (childStarts[j] as Starts)(target), mine, j);
      if (got === undefined) unroutable.push({ joint: j, what: 'arm', parts: [...mine] });
      else {
        reach = Math.max(reach, got);
        arms++;
      }
    }
    const s = mine.length > 1 ? joinGroups(j, mine) : { count: 0, reach: 0 };
    rows.push({
      index: j,
      ...(element === undefined ? {} : { element }),
      arms,
      standoffs: s.count,
      reach: Math.max(reach, s.reach),
    });
  }

  /** Posts over a minimum spanning tree of the touch groups among one joint's parts. */
  function joinGroups(j: number, mine: readonly number[]): { count: number; reach: number } {
    const up = new Map(mine.map((i) => [i, i]));
    const find = (i: number): number => {
      let x = i;
      while (up.get(x) !== x) x = up.get(x) as number;
      return x;
    };
    const edges: { a: number; b: number; d: number }[] = [];
    for (let x = 0; x < mine.length; x++) {
      for (let y = x + 1; y < mine.length; y++) {
        const a = mine[x] as number;
        const b = mine[y] as number;
        const d = partDistance(geometry, a, b, placement, postReach, gap);
        if (d <= gap) up.set(find(a), find(b));
        else if (d < Infinity) edges.push({ a, b, d });
      }
    }
    edges.sort((x, y) => x.d - y.d || x.a - y.a || x.b - y.b);
    let count = 0;
    let reach = 0;
    const r = 0.4 * (sizes[j] as number);
    for (const { a, b } of edges) {
      if (find(a) === find(b)) continue;
      // The closest pair of points first, then posts from other vertices of the nearer
      // part to their closest points on the other, nearest first.
      const A = geometry[a] as PartGeometry;
      const B = geometry[b] as PartGeometry;
      const best = closestPair(A, B);
      if (best === undefined) continue;
      const clear = (c: { onA: Tuple3; onB: Tuple3 }) =>
        rodClear(c.onA, c.onB, r, j, [
          { part: a, point: c.onA },
          { part: b, point: c.onB },
        ]);
      let pair: { onA: Tuple3; onB: Tuple3; distance: number } | undefined = clear(best)
        ? best
        : undefined;
      if (pair === undefined) {
        const others: { onA: Tuple3; onB: Tuple3; distance: number }[] = [];
        for (let i = 0; i < A.points.length; i += 3) {
          const p: Tuple3 = [
            A.points[i] as number,
            A.points[i + 1] as number,
            A.points[i + 2] as number,
          ];
          if (length(sub(p, best.onA)) < r) continue;
          const q = closestPoint(B, p);
          if (q !== undefined && q.distance <= postReach) {
            others.push({ onA: p, onB: q.point, distance: q.distance });
          }
        }
        others.sort((x, y) => x.distance - y.distance);
        pair = others.slice(0, POST_TRIES).find(clear);
      }
      if (pair === undefined) continue;
      const axis =
        length(sub(pair.onB, pair.onA)) > 1e-9
          ? normalize(sub(pair.onB, pair.onA))
          : ([0, 1, 0] as Tuple3);
      // A post sunk into both faces closes the clearance.
      const from = add(pair.onA, scale(axis, -seat));
      const to = add(pair.onB, scale(axis, seat));
      up.set(find(a), find(b));
      addRod(j, from, to, r);
      addSeat(j, a, r);
      addSeat(j, b, r);
      count++;
      reach = Math.max(reach, pair.distance);
    }
    // Groups other than the largest stayed apart (no clear post within `reach`).
    const members = new Map<number, number[]>();
    for (const i of mine) members.set(find(i), [...(members.get(find(i)) ?? []), i]);
    const sorted = [...members.values()].sort(
      (x, y) => y.length - x.length || (x[0] as number) - (y[0] as number),
    );
    for (const group of sorted.slice(1))
      unroutable.push({ joint: j, what: 'standoff', parts: group });
    return { count, reach };
  }

  return {
    pieces,
    seats,
    joints: rows,
    embedded,
    unroutable,
  };
}

/** Exact geometry of one piece, for routing the other side's arms around it. */
function pieceGeometry(piece: HardwarePiece): PartGeometry | undefined {
  const m = model();
  buildPiece(m, piece, 'piece');
  if (m.poisoned !== undefined) return undefined;
  return partGeometry(m.editMesh, 'piece', m.editMesh.faces(), true);
}

/** @internal Build one planned piece into `m` with `tag` and material, placed in model space. */
export function buildPiece(m: Model, piece: HardwarePiece, tag: string, material?: string): void {
  const placement = { tag, ...(material === undefined ? {} : { material }) };
  const s = piece.shape;
  const before = new Set(m.editMesh.vertices());
  let y: Tuple3;
  let center: Tuple3;
  switch (s.kind) {
    case 'rod': {
      const d = sub(s.to, s.from);
      const h = length(d);
      m.cylinder({
        radiusTop: s.radius,
        radiusBottom: s.radius,
        height: h,
        radialSegments: SEGMENTS,
        ...placement,
      });
      y = normalize(d);
      center = scale(add(s.from, s.to), 0.5);
      break;
    }
    case 'tube':
      if (s.inner <= 0) {
        m.cylinder({
          radiusTop: s.outer,
          radiusBottom: s.outer,
          height: s.height,
          radialSegments: SEGMENTS,
          ...placement,
        });
      } else {
        const h = s.height / 2;
        // The inner faces are flat between segment vertices: place the vertices so the
        // faces themselves keep the inner radius.
        const inner = s.inner / cos(Math.PI / SEGMENTS);
        m.revolve({
          points: [
            [inner, -h],
            [s.outer, -h],
            [s.outer, h],
            [inner, h],
            [inner, -h],
          ],
          segments: SEGMENTS,
          ...placement,
        });
      }
      y = s.axis;
      center = s.center;
      break;
    case 'ball':
      m.sphere({
        radius: s.radius,
        widthSegments: SEGMENTS,
        heightSegments: SEGMENTS / 2,
        ...placement,
      });
      y = [0, 1, 0];
      center = s.center;
      break;
    case 'box':
      m.box({ size: s.size, ...placement });
      y = s.axis;
      center = s.center;
      break;
  }
  const x =
    s.kind === 'box' ? normalize(sub(s.across, scale(y, dot(s.across, y)))) : perpendicular(y);
  const z = cross(x, y);
  const mesh = m.editMesh;
  for (const v of mesh.vertices()) {
    if (before.has(v)) continue;
    const [px, py, pz] = mesh.position(v);
    mesh.setPosition(
      v,
      center[0] + x[0] * px + y[0] * py + z[0] * pz,
      center[1] + x[1] * px + y[1] * py + z[1] * pz,
      center[2] + x[2] * px + y[2] * py + z[2] * pz,
    );
  }
}
