import { err, ok, type Result } from '@forgeax/engine-types';
import type { Angles } from './affine';
import { cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import type { Axis } from './geom';
import type { Issue } from './report';
import type {
  Clamp,
  JointRecord,
  JointValue,
  LimitMode,
  MotionCode,
  MotionReport,
  MotionReportOptions,
  PathInterpolation,
  Pose,
  PosePath,
  Range,
  Rig,
} from './rig';

/**
 * One phase's timing (seconds on the clip): its window, and the curve its joints follow from
 * their `from` to their `to` values. The quintic ease (zero velocity and acceleration at both
 * ends) carries a sin^2 dip of `anticipate` x the travel at the start and a bump of
 * `overshoot` x the travel at the end, over the first and last 30 % of the window; `within` lets joints
 * whose name starts with a prefix move in a part of the window only (one leads, one follows).
 */
export interface Beat {
  readonly span: readonly [number, number];
  readonly anticipate?: number;
  readonly overshoot?: number;
  readonly within?: Readonly<Record<string, readonly [number, number]>>;
}

export interface ChoreographyPhase {
  readonly id: string;
  /** Joint values at the phase start and end; joints that differ are the phase's movers. */
  readonly from: Pose;
  readonly to: Pose;
  /** Movers (default: the joints whose `from` and `to` values differ). */
  readonly joints?: readonly string[];
  readonly beat: Beat;
}

export interface ChoreographyOptions {
  readonly phases: readonly ChoreographyPhase[];
  /** Clip length in seconds: keys sit at u = t / duration. */
  readonly duration: number;
  /** Key spacing inside a window in seconds (default 0.05); shaped beats get twice the keys. */
  readonly keyStep?: number;
  /** Per-group time offsets (seconds) applied to the windows of the joints a prefix names. */
  readonly stagger?: readonly { readonly joints: readonly string[]; readonly offset: number }[];
  /** Interpolation of the produced path (default 'linear'; 'hermite' keeps mid-key velocity). */
  readonly interpolation?: PathInterpolation;
  /**
   * Extra values keyed with each pose (drive members a joint solve does not cover), called
   * at every key time once per phase active there with the whole pose at that time.
   */
  readonly extra?: (pose: Pose, phase: string) => Pose;
  /**
   * Values a beat drives past a joint limit: `reject` (default) fails, `clamp` holds them at
   * the limit and reports each joint's farthest request in `clamped`.
   */
  readonly limits?: LimitMode;
}

/** A moment the viewer should read: a phase's end, held until the next phase starts. */
export interface ReadPoint {
  readonly phase: string;
  /** Seconds and path u. */
  readonly at: number;
  readonly u: number;
  /** Seconds until the next phase starts (0 while another phase still moves). */
  readonly hold: number;
}

export interface Choreography {
  readonly path: PosePath;
  readonly readPoints: readonly ReadPoint[];
  /** Each mover's smallest and largest value along the clip (degrees per axis, meters). */
  readonly extremes: Readonly<Record<string, Readonly<Record<string, readonly [number, number]>>>>;
  /** Under `limits: 'clamp'`, each joint (axis) held at a limit, with its farthest request. */
  readonly clamped: readonly Clamp[];
  /**
   * Each phase's actual window in u (its span widened by any stagger) and its movers: pass them
   * as `rig.phaseClaims` phases so a claim never misses motion a stagger moved.
   */
  readonly spans: readonly {
    readonly id: string;
    readonly u: readonly [number, number];
    readonly joints: readonly string[];
  }[];
}

/** Share of a phase's window the anticipation dip or the overshoot settle takes. */
const LEAD = 0.15;

/** Quintic ease: zero velocity and acceleration at both ends. */
function quintic(t: number): number {
  return t * t * t * (t * (6 * t - 15) + 10);
}

/** A phase's progress at window time x in [0, 1]: eased, with its dip and settle. */
function beatProgress(b: Beat, x: number): number {
  const pre = (b.anticipate ?? 0) > 0 ? LEAD : 0;
  const post = (b.overshoot ?? 0) > 0 ? LEAD : 0;
  const bump = (from: number, width: number) => {
    if (width <= 0 || x <= from || x >= from + width) return 0;
    const s = sin((Math.PI * (x - from)) / width);
    return s * s;
  };
  const main = quintic(Math.min(1, Math.max(0, (x - pre) / (1 - pre - post))));
  return (
    main -
    (b.anticipate ?? 0) * bump(0, 2 * pre) +
    (b.overshoot ?? 0) * bump(1 - 2 * post, 2 * post)
  );
}

const AXES: readonly Axis[] = ['x', 'y', 'z'];

function lerpValue(a: JointValue | undefined, b: JointValue | undefined, t: number): JointValue {
  if (typeof a === 'number' || typeof b === 'number') {
    const x = (a as number | undefined) ?? 0;
    return x + (((b as number | undefined) ?? 0) - x) * t;
  }
  const out: Partial<Record<Axis, number>> = {};
  for (const k of AXES) {
    const x = (a as Angles | undefined)?.[k] ?? 0;
    out[k] = x + (((b as Angles | undefined)?.[k] ?? 0) - x) * t;
  }
  return out;
}

function same(x: JointValue | undefined, y: JointValue | undefined): boolean {
  if (typeof x === 'number' || typeof y === 'number') {
    return Math.abs(((x as number | undefined) ?? 0) - ((y as number | undefined) ?? 0)) < 1e-9;
  }
  return AXES.every(
    (k) =>
      Math.abs(((x as Angles | undefined)?.[k] ?? 0) - ((y as Angles | undefined)?.[k] ?? 0)) <
      1e-9,
  );
}

/**
 * @internal Choreograph phases into a path; `Rig.choreograph` checks the joint names first.
 * Joints follow the latest of their phases that has started; a value a beat drives past
 * `limits` (anticipation or overshoot beyond a joint limit) is an error, or under
 * `limits: 'clamp'` a reported clamp, never a silent one.
 */
export function choreograph(
  options: ChoreographyOptions,
  limits: (joint: string) => Range | Readonly<Partial<Record<Axis, Range>>> | undefined,
): Result<Choreography, ModelingError> {
  const { phases, duration } = options;
  const keyStep = options.keyStep ?? 0.05;
  if (!(duration > 0) || !(keyStep > 0) || !Array.isArray(phases) || phases.length === 0) {
    return err(
      modelingError('model-invalid-argument', 'phases, a positive duration and key step', {
        duration,
        keyStep,
        phases: Array.isArray(phases) ? phases.length : phases,
      }),
    );
  }
  const offsetOf = (joint: string) =>
    (options.stagger ?? []).find((s) => s.joints.some((p) => joint.startsWith(p)))?.offset ?? 0;
  const windows: { phase: ChoreographyPhase; movers: string[] }[] = [];
  for (const phase of phases) {
    const [t0, t1] = phase.beat.span;
    if (!(Number.isFinite(t0) && Number.isFinite(t1) && t0 < t1 && t0 >= 0 && t1 <= duration)) {
      return err(
        modelingError('model-invalid-argument', 'a phase window [t0, t1] inside [0, duration]', {
          phase: phase.id,
          span: phase.beat.span,
          duration,
        }),
      );
    }
    const names = [...new Set([...Object.keys(phase.from), ...Object.keys(phase.to)])];
    const movers =
      phase.joints === undefined
        ? names.filter((j) => !same(phase.from[j], phase.to[j]))
        : [...phase.joints];
    windows.push({ phase, movers });
  }
  const byJoint = new Map<string, (typeof windows)[number][]>();
  for (const w of windows) for (const j of w.movers) byJoint.set(j, [...(byJoint.get(j) ?? []), w]);
  const extremes = new Map<string, Map<string, [number, number]>>();
  const beyond: { joint: string; axis?: Axis; value: number; limit: Range; phase: string }[] = [];
  const rangeOf = (joint: string, k: string): Range | undefined => {
    const lim = limits(joint);
    return lim === undefined
      ? undefined
      : Array.isArray(lim)
        ? (lim as Range)
        : (lim as Partial<Record<Axis, Range>>)[k as Axis];
  };
  const clamped = new Map<string, Clamp>();
  const hold = (joint: string, value: JointValue): JointValue => {
    if (options.limits !== 'clamp') return value;
    const one = (k: string, v: number) => {
      const r = rangeOf(joint, k);
      if (r === undefined) return v;
      const applied = Math.min(r[1], Math.max(r[0], v));
      const key = `${joint}/${k}`;
      const prior = clamped.get(key);
      if (
        applied !== v &&
        (prior === undefined || Math.abs(v - applied) > Math.abs(prior.requested - prior.applied))
      ) {
        clamped.set(key, {
          joint,
          ...(k === '' ? {} : { axis: k as Axis }),
          requested: v,
          applied,
        });
      }
      return applied;
    };
    if (typeof value === 'number') return one('', value);
    return Object.fromEntries(AXES.map((k) => [k, one(k, (value as Angles)[k] ?? 0)]));
  };
  const track = (joint: string, value: JointValue, phase: string) => {
    const entries: [string, number][] =
      typeof value === 'number' ? [['', value]] : AXES.map((k) => [k, (value as Angles)[k] ?? 0]);
    const ex = extremes.get(joint) ?? new Map<string, [number, number]>();
    for (const [k, v] of entries) {
      const range = ex.get(k) ?? [v, v];
      ex.set(k, [Math.min(range[0], v), Math.max(range[1], v)]);
      const r = rangeOf(joint, k);
      if (r !== undefined && (v < r[0] - 1e-9 || v > r[1] + 1e-9)) {
        beyond.push({ joint, ...(k === '' ? {} : { axis: k as Axis }), value: v, limit: r, phase });
      }
    }
    extremes.set(joint, ex);
  };
  const poseAt = (t: number): Pose => {
    const out: Record<string, JointValue> = {};
    for (const [j, ws] of byJoint) {
      const shift = offsetOf(j);
      const w = [...ws].reverse().find((x) => t >= x.phase.beat.span[0] + shift);
      if (w === undefined) {
        // Not started yet (a stagger delays it past a key time): it holds its first value.
        const first = ws[0];
        if (first !== undefined) out[j] = lerpValue(first.phase.from[j], first.phase.to[j], 0);
        continue;
      }
      const [t0, t1] = w.phase.beat.span;
      const x = Math.min(1, (t - t0 - shift) / (t1 - t0));
      const [a, b] = Object.entries(w.phase.beat.within ?? {}).find(([prefix]) =>
        j.startsWith(prefix),
      )?.[1] ?? [0, 1];
      out[j] = hold(
        j,
        lerpValue(
          w.phase.from[j],
          w.phase.to[j],
          beatProgress(w.phase.beat, Math.min(1, Math.max(0, (x - a) / (b - a)))),
        ),
      );
    }
    return out;
  };
  // Key times per window; at each time every window active there keys its movers, so a joint
  // of an overlapping window does not interpolate across another window's keys (where `extra`
  // keys values derived from the whole pose).
  const extents = windows.map((w) => {
    const [w0, w1] = w.phase.beat.span;
    const shifts = w.movers.map(offsetOf);
    return [w0 + Math.min(0, ...shifts), Math.min(duration, w1 + Math.max(0, ...shifts))] as const;
  });
  const times = new Set<number>();
  for (const [i, w] of windows.entries()) {
    const [t0, t1] = extents[i] as readonly [number, number];
    // A dip or a settle is a short swing of its own: twice the keys, closer toward the window
    // ends (cosine spacing), so it stays eased between keys.
    const shaped = (w.phase.beat.anticipate ?? 0) > 0 || (w.phase.beat.overshoot ?? 0) > 0;
    const n = Math.max(16, Math.ceil((t1 - t0) / keyStep)) * (shaped ? 2 : 1);
    for (let k = 0; k <= n; k++) {
      const x = shaped ? (1 - cos((Math.PI * k) / n)) / 2 : k / n;
      // Snapped to a microsecond: windows that share a boundary share its key.
      times.add(Math.round((k === n ? t1 : t0 + (t1 - t0) * x) * 1e6) / 1e6);
    }
  }
  const byT = new Map<number, Record<string, JointValue>>();
  for (const t of times) {
    const now = poseAt(t);
    const pose: Record<string, JointValue> = {};
    for (const [i, w] of windows.entries()) {
      const [t0, t1] = extents[i] as readonly [number, number];
      if (t < t0 - 1e-9 || t > t1 + 1e-9) continue;
      for (const j of w.movers) {
        const v = now[j] as JointValue;
        pose[j] = v;
        track(j, v, w.phase.id);
      }
      if (options.extra !== undefined) Object.assign(pose, options.extra(now, w.phase.id));
    }
    byT.set(t, pose);
  }
  if (beyond.length > 0) {
    return err(
      modelingError(
        'model-invalid-argument',
        'choreographed values within the joint limits',
        { beyond: beyond.slice(0, 16), count: beyond.length },
        "reduce the anticipation or overshoot, move the phase ends away from the limits, or set limits: 'clamp' to hold and report them",
      ),
    );
  }
  const timed = [...byT].sort((x, y) => x[0] - y[0]);
  const keys = timed.map(([t, pose]) => ({ u: t / duration, pose: pose as Pose }));
  if ((keys.at(-1)?.u ?? 0) < 1) keys.push({ u: 1, pose: {} });
  const readPoints = windows.map(({ phase }) => {
    const end = phase.beat.span[1];
    const busy = windows.some(
      ({ phase: o }) => o.beat.span[0] < end - 1e-9 && o.beat.span[1] > end + 1e-9,
    );
    const next = Math.min(
      duration,
      ...windows.map(({ phase: o }) => o.beat.span[0]).filter((t0) => t0 >= end - 1e-9),
    );
    return {
      phase: phase.id,
      at: end,
      u: end / duration,
      hold: busy ? 0 : Math.round((next - end) * 1e9) / 1e9,
    };
  });
  return ok({
    path: { keys, interpolation: options.interpolation ?? 'linear' },
    readPoints,
    clamped: [...clamped.values()],
    spans: windows.map((w, i) => {
      const [t0, t1] = extents[i] as readonly [number, number];
      return { id: w.phase.id, u: [t0 / duration, t1 / duration] as const, joints: w.movers };
    }),
    extremes: Object.fromEntries(
      [...extremes].map(([j, ex]) => [
        j,
        Object.fromEntries([...ex].map(([k, r]) => [k === '' ? 'value' : k, r])),
      ]),
    ),
  });
}

/** @internal The body of `Rig.motionReport`. */
export function rigMotionReport(
  r: Rig,
  path: PosePath,
  options: MotionReportOptions,
): Result<MotionReport, ModelingError> {
  const fps = options.fps ?? 24;
  const still = options.still ?? 0.02;
  if (!(options.duration > 0) || !(fps > 0) || !(still > 0)) {
    return err(
      modelingError('model-invalid-argument', 'a positive duration, fps and still speed', {
        duration: options.duration,
        fps,
        still,
      }),
    );
  }
  const frames = Math.max(1, Math.round(options.duration * fps));
  const groups = Object.entries(options.groups);
  const main = new Set(options.main ?? groups.map(([g]) => g));
  const coords = r.coordinatesOf(r._table.map((_, i) => i));
  const member = coords.map((c) => {
    const name = (r._table[c.joint] as JointRecord).name;
    return groups.flatMap(([, prefixes], k) =>
      prefixes.some((p) => name.startsWith(p)) ? [k] : [],
    );
  });
  const series: number[][] = [];
  for (let f = 0; f <= frames; f++) {
    const sampled = r.sample(path, f / frames);
    if (!sampled.ok) return sampled;
    const posed = r.pose(sampled.value);
    if (!posed.ok) return posed;
    const values = posed.value.joints.map((j) => j.value);
    series.push(coords.map((c) => r.coordinate(values, c)));
  }
  // moving[f][g]: group g moves between frames f and f + 1.
  const moving = Array.from({ length: frames }, (_, f) => {
    const speed = groups.map(() => 0);
    for (const [k, gs] of member.entries()) {
      const v =
        Math.abs(
          ((series[f + 1] as number[])[k] as number) - ((series[f] as number[])[k] as number),
        ) * fps;
      for (const g of gs) speed[g] = Math.max(speed[g] as number, v);
    }
    return speed.map((v) => v > still);
  });
  const intervals = (on: (f: number) => boolean) => {
    const out: [number, number][] = [];
    let start = -1;
    for (let f = 0; f <= frames; f++) {
      const active = f < frames && on(f);
      if (active && start < 0) start = f;
      if (!active && start >= 0) {
        out.push([start / fps, f / fps]);
        start = -1;
      }
    }
    return out;
  };
  const quiet = (f: number) => !(moving[f] as boolean[]).some(Boolean);
  let calm = 0;
  for (const m of moving) if (groups.filter(([g], k) => main.has(g) && m[k]).length <= 1) calm++;
  const concurrency = frames === 0 ? 1 : calm / frames;
  const minHold = options.hold ?? 8;
  const readPoints = (options.readPoints ?? []).map((point) => {
    // The still frames from the first frame starting at or after the read point.
    let held = 0;
    for (let k = Math.ceil(point.at * fps - 1e-9); k < frames && quiet(k); k++) held++;
    return { phase: point.phase, at: point.at, held };
  });
  const issues: Issue<MotionCode>[] = [];
  if (concurrency < 0.9) {
    issues.push({ code: 'concurrent', severity: 'warn', detail: { concurrency, threshold: 0.9 } });
  }
  const short = readPoints.filter((point) => point.held < minHold);
  if (short.length > 0) {
    issues.push({
      code: 'short-hold',
      severity: 'warn',
      detail: { readPoints: short, hold: minHold },
    });
  }
  return ok({
    fps,
    frames,
    groups: Object.fromEntries(
      groups.map(([g], k) => [g, intervals((f) => (moving[f] as boolean[])[k] === true)]),
    ),
    concurrency,
    holds: intervals(quiet),
    readPoints,
    issues,
  });
}
