import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type Affine,
  type Angles,
  axisAngle,
  fromAngles,
  IDENTITY,
  invertRigid,
  multiply,
  translation,
} from './affine';
import { type ModelingError, modelingError } from './errors';
import { type Axis, axisVector, type Tuple3 } from './geom';
import { FIT_TOLERANCE } from './interference';

import type {
  JointKind,
  JointRecord,
  JointSpec,
  JointValue,
  MimicLink,
  Range,
  RigSpec,
} from './rig';

export const KEY = /^[a-z0-9][a-z0-9_.-]*$/;
export const AXES: readonly Axis[] = ['x', 'y', 'z'];

/** @internal */
export function finite(...values: readonly unknown[]): boolean {
  return values.every((v) => typeof v === 'number' && Number.isFinite(v));
}

export function isRange(value: unknown): value is Range {
  return Array.isArray(value) && value.length === 2 && finite(...value) && value[0] <= value[1];
}

export function unit(axis: Axis | Tuple3): Tuple3 | undefined {
  if (typeof axis === 'string') return AXES.includes(axis) ? axisVector(axis) : undefined;
  if (!Array.isArray(axis) || axis.length !== 3 || !finite(...axis)) return undefined;
  const l = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
  return l > 1e-12 ? [axis[0] / l, axis[1] / l, axis[2] / l] : undefined;
}

export function rejectSpec(expected: string, detail: Record<string, unknown>, hint?: string) {
  return err(modelingError('model-invalid-argument', expected, detail, hint));
}

export function compileJoints(spec: RigSpec): Result<JointRecord[], ModelingError> {
  if (!Array.isArray(spec?.joints) || spec.joints.length === 0) {
    return rejectSpec('a rig has at least one joint', {});
  }
  const index = new Map<string, number>();
  const out: JointRecord[] = [];
  for (const [i, j] of spec.joints.entries()) {
    if (typeof j.name !== 'string' || !KEY.test(j.name)) {
      return rejectSpec('joint names are lowercase key segments', { joint: i, name: j.name });
    }
    if (index.has(j.name)) return rejectSpec('joint names are unique', { joint: j.name });
    let parent = -1;
    if (j.parent === null) {
      if (out.some((o) => o.parent < 0)) {
        return rejectSpec(
          'a rig has a single root joint',
          { joint: j.name },
          'parent every other joint to the root',
        );
      }
    } else {
      const p = index.get(j.parent);
      if (p === undefined) {
        return rejectSpec('a parent joint precedes its children', {
          joint: j.name,
          parent: j.parent,
        });
      }
      parent = p;
    }
    if (!Array.isArray(j.position) || j.position.length !== 3 || !finite(...j.position)) {
      return rejectSpec('a finite rest position [x, y, z]', { joint: j.name });
    }
    if (
      j.rotation !== undefined &&
      !AXES.every((a) => j.rotation?.[a] === undefined || finite(j.rotation[a]))
    ) {
      return rejectSpec('finite rest rotation angles', { joint: j.name });
    }
    const kind = j.kind ?? 'fixed';
    let axis: Tuple3 = [0, 0, 0];
    if (kind === 'revolute' || kind === 'prismatic') {
      const u = j.axis === undefined ? undefined : unit(j.axis);
      if (u === undefined) {
        return rejectSpec(`a ${kind} joint has a non-zero axis`, { joint: j.name });
      }
      axis = u;
      if (j.limits !== undefined && !isRange(j.limits)) {
        return rejectSpec(`${kind} limits are [min, max] with min <= max`, { joint: j.name });
      }
      const ends = j.stops === undefined ? [] : [j.stops.min, j.stops.max];
      if (
        ends.length > 0 &&
        (j.limits === undefined ||
          ends.every((e) => e === undefined) ||
          !ends.every(
            (e) =>
              e === undefined ||
              (typeof e.stop === 'string' &&
                KEY.test(e.stop) &&
                (e.against === undefined ||
                  (typeof e.against === 'string' && KEY.test(e.against)))),
          ))
      ) {
        return rejectSpec(
          'stops on a limited joint: { min?, max? } with stop (and against) part names',
          { joint: j.name },
        );
      }
    } else if (kind === 'spherical') {
      const limits = j.limits;
      if (
        limits !== undefined &&
        (Array.isArray(limits) ||
          !AXES.every(
            (a) =>
              (limits as Record<string, unknown>)[a] === undefined ||
              isRange((limits as Record<string, unknown>)[a]),
          ))
      ) {
        return rejectSpec('spherical limits are { x?, y?, z? } ranges in degrees', {
          joint: j.name,
        });
      }
    } else if (kind === 'fixed') {
      if (j.limits !== undefined || j.axis !== undefined || j.stops !== undefined) {
        return rejectSpec('a fixed joint has no axis or limits', { joint: j.name });
      }
    } else {
      return rejectSpec("a joint kind 'fixed' | 'revolute' | 'prismatic' | 'spherical'", {
        joint: j.name,
        kind,
      });
    }
    let mimic: MimicLink | undefined;
    if (j.mimic !== undefined) {
      const linked = linkMimic(j, kind, index, out);
      if (!linked.ok) return linked;
      mimic = linked.value;
    }
    const restWorld = multiply(translation(j.position), fromAngles(j.rotation));
    const restLocal =
      parent < 0
        ? restWorld
        : multiply(invertRigid((out[parent] as JointRecord).restWorld), restWorld);
    index.set(j.name, out.length);
    if (kind === 'spherical' && j.stops !== undefined) {
      return rejectSpec('stops on revolute and prismatic joints', { joint: j.name });
    }
    out.push({
      name: j.name,
      parent,
      kind,
      axis,
      limits: j.limits,
      stops: j.stops,
      ...(mimic === undefined ? {} : { mimic }),
      restWorld,
      restLocal,
    });
  }
  return reachOf(out);
}

function linkMimic(
  j: JointSpec,
  kind: JointKind,
  index: ReadonlyMap<string, number>,
  out: readonly JointRecord[],
): Result<MimicLink, ModelingError> {
  const m = j.mimic as NonNullable<JointSpec['mimic']>;
  const leader = typeof m?.joint === 'string' ? index.get(m.joint) : undefined;
  if (kind !== 'revolute' && kind !== 'prismatic') {
    return rejectSpec('a mimic follower is a revolute or prismatic joint', { joint: j.name, kind });
  }
  if (leader === undefined) {
    return rejectSpec(
      'a mimic joint precedes its follower',
      { joint: j.name, mimic: m?.joint },
      'declare the leader before the follower; a cycle needs a forward reference, so it cannot be written',
    );
  }
  const head = out[leader] as JointRecord;
  if (head.kind !== 'revolute' && head.kind !== 'prismatic') {
    return rejectSpec('a mimic leader is a revolute or prismatic joint', {
      joint: j.name,
      mimic: m.joint,
      kind: head.kind,
    });
  }
  const offset = m.offset ?? 0;
  if (!finite(m.ratio, offset) || m.ratio === 0) {
    return rejectSpec(
      'a finite non-zero mimic ratio and a finite offset',
      { joint: j.name, ratio: m.ratio, offset: m.offset },
      m.ratio === 0 ? "a zero ratio is a fixed joint: use kind: 'fixed'" : undefined,
    );
  }
  const above = head.mimic;
  return ok({
    leader,
    ratio: m.ratio,
    offset,
    root: above === undefined ? leader : above.root,
    rootRatio: above === undefined ? m.ratio : m.ratio * above.rootRatio,
    rootOffset: above === undefined ? offset : m.ratio * above.rootOffset + offset,
  });
}

export const near = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));

/** Combine every follower's limits onto its root leader, in declaration order. */
function reachOf(out: JointRecord[]): Result<JointRecord[], ModelingError> {
  const reach = new Map<number, Range>();
  const mapped = (f: JointRecord): Range | undefined => {
    const link = f.mimic as MimicLink;
    if (!Array.isArray(f.limits)) return undefined;
    const [lo, hi] = f.limits as Range;
    const a = (lo - link.rootOffset) / link.rootRatio;
    const b = (hi - link.rootOffset) / link.rootRatio;
    return a <= b ? [a, b] : [b, a];
  };
  for (const f of out) {
    const link = f.mimic;
    if (link === undefined) continue;
    const root = out[link.root] as JointRecord;
    const own =
      reach.get(link.root) ?? (Array.isArray(root.limits) ? (root.limits as Range) : undefined);
    const to = mapped(f);
    const next: Range | undefined =
      to === undefined
        ? own
        : own === undefined
          ? to
          : [Math.max(own[0], to[0]), Math.min(own[1], to[1])];
    if (next === undefined) continue;
    const detail = {
      joint: f.name,
      leader: root.name,
      ratio: link.rootRatio,
      leaderRange: own,
      followerRange: to,
    };
    if (next[0] > next[1]) {
      return rejectSpec(
        'follower limits that overlap the leader range',
        detail,
        `no value of '${root.name}' keeps '${f.name}' (= ${link.rootRatio} * '${root.name}' + ${link.rootOffset}) in its limits`,
      );
    }
    if (next[0] > 0 || next[1] < 0) {
      return rejectSpec(
        'an effective leader range that includes the rest value 0',
        { ...detail, effective: next },
        `widen the limits of '${f.name}' or '${root.name}' (or set the mimic offset) so the rest pose is reachable`,
      );
    }
    reach.set(link.root, next);
  }
  const held = (j: JointRecord, end: 'min' | 'max', lo: number, hi: number, r: Range) => {
    const link = j.mimic;
    const sign = link === undefined ? 1 : Math.sign(link.rootRatio);
    const own = (end === 'min') === sign > 0 ? 'min' : 'max';
    return (
      j.stops?.[own] !== undefined && near(end === 'min' ? lo : hi, end === 'min' ? r[0] : r[1])
    );
  };
  for (const [root, r] of reach) {
    const holds = { min: false, max: false };
    for (const j of out) {
      if (j.mimic === undefined ? out.indexOf(j) !== root : j.mimic.root !== root) continue;
      const to = j.mimic === undefined ? (j.limits as Range | undefined) : mapped(j);
      if (to === undefined) continue;
      holds.min ||= held(j, 'min', to[0], to[1], r);
      holds.max ||= held(j, 'max', to[0], to[1], r);
    }
    out[root] = { ...(out[root] as JointRecord), reach: r, holds };
  }
  return ok(out);
}

export function clampValue(value: number, range: Range | undefined): number {
  if (range === undefined) return value;
  return Math.min(range[1], Math.max(range[0], value));
}

/** Local motion of a joint at its value, in the joint's rest frame. */
export function motion(joint: JointRecord, value: JointValue | null): Affine {
  switch (joint.kind) {
    case 'fixed':
      return IDENTITY;
    case 'revolute':
      return axisAngle(joint.axis, value as number);
    case 'prismatic':
      return translation(joint.axis.map((c) => c * (value as number)));
    case 'spherical':
      return fromAngles(value as Angles);
  }
}

/** A distance inside a fit band, with 1 nm slack for flush faces. */
export function within(d: number, gap: readonly [number, number]): boolean {
  return d >= gap[0] - FIT_TOLERANCE && d <= gap[1] + FIT_TOLERANCE;
}

/**
 * Steffen's monotone cubic between keys s and s + 1 (of 0..last) at fraction t: tangents limited so the
 * curve never overshoots between keys; zero at the first and last key (the value holds there).
 */
export function steffen(
  u: (k: number) => number,
  v: (k: number) => number,
  last: number,
  s: number,
  t: number,
): number {
  const h = (k: number) => u(k + 1) - u(k);
  const d = (k: number) => (v(k + 1) - v(k)) / h(k);
  const tangent = (k: number) => {
    if (k <= 0 || k >= last) return 0;
    const d0 = d(k - 1);
    const d1 = d(k);
    if (d0 * d1 <= 0) return 0;
    const p = (d0 * h(k) + d1 * h(k - 1)) / (h(k - 1) + h(k));
    return (
      (Math.sign(d0) + Math.sign(d1)) * Math.min(Math.abs(d0), Math.abs(d1), 0.5 * Math.abs(p))
    );
  };
  const a = v(s);
  const b = v(s + 1);
  const span = h(s);
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * a +
    (t3 - 2 * t2 + t) * span * tangent(s) +
    (-2 * t3 + 3 * t2) * b +
    (t3 - t2) * span * tangent(s + 1)
  );
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
