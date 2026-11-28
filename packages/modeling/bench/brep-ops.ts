import { cone, cylinder, extrude, revolve, sphere, torus } from '../src/brep/build';
import { measure } from '../src/brep/measure';
import { countOps, OP_KINDS, type OpCounts } from '../src/brep/ops';
import { tessellate } from '../src/brep/tessellate';
import type { Shape } from '../src/brep/types';
import { validate } from '../src/brep/validate';

/**
 * Exact-stage cost by operation count: face-pair (segment-pair) tests, intersection (segment gap) calls,
 * surface/curve evaluations, quadrature evaluations and triangulations. A count depends only on the
 * inputs, never on the clock, the load or the heap, so the committed baseline gates a regression on
 * any host. Wall time stays with `perf-tiers.ts`.
 */
export interface OpsCase {
  readonly name: string;
  /** Builds the shape, then validates, measures and tessellates it; the counts cover all four. */
  run(): void;
}

export const OPS_BOUND = 1.1;

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function ring(radius: number, n: number, bump = 0): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    const r = radius * (1 + (i % 2 === 0 ? bump : 0));
    return [r * Math.cos(a), r * Math.sin(a)];
  });
}

function through(shape: Shape): void {
  must(validate(shape).ok ? { ok: true, value: 0 } : { ok: false, error: 'validate' });
  must(measure(shape));
  must(tessellate(shape));
}

export const OPS_CASES: readonly OpsCase[] = [
  { name: 'cylinder', run: () => through(must(cylinder({ radius: 1, height: 2 }))) },
  { name: 'cone', run: () => through(must(cone({ radius: 1, height: 2 }))) },
  { name: 'sphere', run: () => through(must(sphere({ radius: 1 }))) },
  { name: 'torus', run: () => through(must(torus({ major: 3, minor: 1 }))) },
  {
    name: 'extrude-gear-64',
    run: () => through(must(extrude({ profile: ring(2, 64, 0.1), depth: 1 }))),
  },
  {
    name: 'extrude-plate-3-holes',
    run: () =>
      through(
        must(
          extrude({
            profile: [
              [-6, -4],
              [6, -4],
              [6, 4],
              [-6, 4],
            ],
            holes: [
              ring(1, 24).map(([x, y]) => [x - 3, y] as [number, number]),
              ring(1, 24).map(([x, y]) => [x, y] as [number, number]),
              ring(1, 24).map(([x, y]) => [x + 3, y] as [number, number]),
            ],
            depth: 0.5,
          }),
        ),
      ),
  },
  {
    name: 'extrude-gear-256',
    run: () => through(must(extrude({ profile: ring(5, 256, 0.05), depth: 1 }))),
  },
  {
    name: 'revolve-vase',
    run: () =>
      through(
        must(
          revolve({
            profile: [
              [0, 0],
              [1, 0],
              [1.4, 0.8],
              [0.9, 1.6],
              [0.6, 2.4],
              [0.8, 3],
              [0, 3],
            ],
          }),
        ),
      ),
  },
];

export type OpsReport = Readonly<Record<string, OpCounts>>;

export function opsReport(): OpsReport {
  const out: Record<string, OpCounts> = {};
  for (const c of OPS_CASES) out[c.name] = countOps(() => c.run()).counts;
  return out;
}

/** Counts of `current` that exceed `baseline` by more than the bound; a missing baseline entry is a failure. */
export function opsRegressions(baseline: OpsReport, current: OpsReport, bound = OPS_BOUND): string[] {
  const out: string[] = [];
  for (const [name, counts] of Object.entries(current)) {
    const base = baseline[name];
    if (base === undefined) {
      out.push(`${name}: not in the baseline`);
      continue;
    }
    for (const k of OP_KINDS) {
      if (counts[k] > base[k] * bound) {
        out.push(`${name}.${k}: ${counts[k]} > ${base[k]} x ${bound}`);
      }
    }
  }
  for (const name of Object.keys(baseline)) {
    if (current[name] === undefined) out.push(`${name}: in the baseline but not measured`);
  }
  return out;
}
