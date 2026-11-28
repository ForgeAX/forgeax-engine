import * as brep from '../../brep/index';
import * as api from '../../index';

// The judging surface, derived from the built export namespaces rather than a hand-kept list.
// A name is a judge when it reads as a check, measurement, report, gauge or quality verdict.
const JUDGE =
  /^(check|measure|validate|audit)([A-Z].*)?$|^(debugValidate|lodTopologyReport|meshQuality|trimReport|sweepOverlap|uvOverlapPairs|curveFairness|shutLines|seamVisibility|phaseClaims|poseReport|stopReport|motionReport)$|(Check|Checks|Report|Quality|Overlaps?|Fairness|Continuity|Gauge|Claims)$/;

const NAMESPACES: readonly (readonly [string, Readonly<Record<string, unknown>>])[] = [
  ['', api],
  ['brep.', brep],
];

/** Every exported function or exported-class method whose name reads as a judging check. */
export function judgingSurface(): readonly string[] {
  const names = new Set<string>();
  for (const [prefix, ns] of NAMESPACES) {
    for (const [name, value] of Object.entries(ns)) {
      if (typeof value === 'function' && JUDGE.test(name)) names.add(`${prefix}${name}`);
      if (typeof value !== 'function' || !/^[A-Z]/.test(name)) continue;
      const proto = (value as { prototype?: object }).prototype;
      if (proto === undefined) continue;
      for (const method of Object.getOwnPropertyNames(proto)) {
        if (method === 'constructor' || !JUDGE.test(method)) continue;
        if (typeof (proto as Record<string, unknown>)[method] === 'function') {
          names.add(`${prefix}${name}.${method}`);
        }
      }
    }
  }
  return [...names].sort();
}
