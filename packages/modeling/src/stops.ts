import { err, ok, type Result } from '@forgeax/engine-types';
import { minOf } from './arrays';
import { type ModelingError, modelingError } from './errors';
import { partDistance } from './interference';
import type {
  JointRecord,
  Range,
  ResolvedPart,
  Rig,
  StopCheck,
  StopFinding,
  StopReport,
  StopReportOptions,
} from './rig';
import { finite, rangeOf } from './rig';

/** @internal The body of `Rig.stopReport`. */
export function rigStopReport(
  r: Rig,
  options: StopReportOptions = {},
): Result<StopReport, ModelingError> {
  const contact = options.contact ?? 0.0005;
  if (!finite(contact) || contact < 0) {
    return err(
      modelingError('model-invalid-argument', 'a non-negative contact in meters', { contact }),
    );
  }
  const prepared = r._prepare({});
  if (!prepared.ok) return prepared;
  const { parts, geometry } = prepared.value;
  const checks: StopCheck[] = [];
  const unstopped: string[] = [];
  for (const [j, joint] of r._table.entries()) {
    if ((joint.kind !== 'revolute' && joint.kind !== 'prismatic') || !Array.isArray(joint.limits)) {
      continue;
    }
    const range = joint.limits as Range;
    const link = joint.mimic;
    const rootIndex = link?.root ?? j;
    const root = r._table[rootIndex] as JointRecord;
    const reach = rangeOf(root) as Range;
    // A follower stop is posed through its root leader: the leader takes (v - offset) / ratio.
    const lead = (v: number) => (link === undefined ? v : (v - link.rootOffset) / link.rootRatio);
    const carried = parts.flatMap((p, k) => {
      for (let i = p.joint; i >= 0; i = (r._table[i] as JointRecord).parent) {
        if (i === j) return [k];
      }
      return [];
    });
    for (const end of ['min', 'max'] as const) {
      const spec = joint.stops?.[end];
      if (spec === undefined) {
        unstopped.push(`${joint.name}/${end}`);
        continue;
      }
      const value = end === 'min' ? range[0] : range[1];
      const rootValue = lead(value);
      if (reach !== undefined && (rootValue < reach[0] - 1e-12 || rootValue > reach[1] + 1e-12)) {
        checks.push({
          joint: joint.name,
          end,
          stop: spec.stop,
          against: [],
          value,
          gap: null,
          depth: null,
          travelGap: null,
          finding: 'unreachable',
        });
        continue;
      }
      const stop = parts.findIndex((p) => p.name === spec.stop);
      const against =
        spec.against === undefined
          ? carried
          : parts.flatMap((p, k) => (p.name === spec.against ? [k] : []));
      const names = against.map((k) => (parts[k] as ResolvedPart).name);
      if (stop < 0 || against.length === 0) {
        checks.push({
          joint: joint.name,
          end,
          stop: spec.stop,
          against: names,
          value,
          gap: null,
          depth: null,
          travelGap: null,
          finding: 'missing',
        });
        continue;
      }
      const gapAt = (v: number) => {
        const posed = r.pose({ ...(options.pose ?? {}), [root.name]: lead(v) }, options);
        if (!posed.ok) return posed;
        const placed = r.placement(parts, posed.value);
        return ok(minOf(against.map((k) => partDistance(geometry, stop, k, placed, 1))));
      };
      const gap = gapAt(value);
      if (!gap.ok) return gap;
      const travelGap = gapAt((range[0] + range[1]) / 2);
      if (!travelGap.ok) return travelGap;
      // A gap is a clearance (0 once the parts overlap): the overlap depth says how far in.
      const overlap = r.interference(
        { ...(options.pose ?? {}), [root.name]: rootValue },
        {
          ...options,
          tolerance: 0,
        },
      );
      if (!overlap.ok) return overlap;
      const depth = Math.max(
        0,
        ...overlap.value.pairs
          .filter((p) => p.parts.includes(spec.stop) && p.parts.some((n) => names.includes(n)))
          .map((p) => p.depth),
      );
      const finding: StopFinding =
        gap.value > contact
          ? 'open'
          : depth > contact
            ? 'through'
            : travelGap.value <= contact
              ? 'early'
              : 'landed';
      checks.push({
        joint: joint.name,
        end,
        stop: spec.stop,
        against: names,
        value,
        gap: gap.value,
        depth,
        travelGap: travelGap.value,
        finding,
      });
    }
  }
  // Every limited end needs a stop that lands: a missing declaration fails too.
  return ok({
    checks,
    unstopped,
    pass: unstopped.length === 0 && checks.every((c) => c.finding === 'landed'),
  });
}
