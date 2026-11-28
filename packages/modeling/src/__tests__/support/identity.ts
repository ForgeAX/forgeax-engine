import type { ComputeBackend } from '../../compute/job';
import { type Model, model } from '../../model';
import { type FuzzOp, scene } from './fuzz';

export type Outcome =
  | { readonly kind: 'ok'; readonly volume: number }
  | { readonly kind: 'empty' }
  | { readonly kind: 'refused'; readonly code: string };

export interface Operands {
  readonly seed: number;
  readonly a: () => Model;
  readonly b: () => Model;
  readonly c: () => Model;
  describe(): string;
}

/** Three single-primitive operands drawn from one grid region, so overlap and contact are common. */
export function operands(seed: number, native?: ComputeBackend): Operands {
  const parts = [0, 1, 2].map((k) => scene(seed * 3 + k, { primitives: 1, grid: 0.25, ops: [] }));
  const make = (k: number) => () => {
    const m = native === undefined ? model() : model({ native });
    (parts[k] as ReturnType<typeof scene>).build(m);
    return m;
  };
  return {
    seed,
    a: make(0),
    b: make(1),
    c: make(2),
    describe: () => parts.map((p) => p.describe()).join(' | '),
  };
}

/** The volume of `target op tool`, 0 when the operands do not meet, or the structured refusal. */
export function apply(target: Model, op: FuzzOp, tool: Model): Outcome {
  const before = target.validate().volume;
  const report = target[op](tool);
  if (report.status === 'ok') return { kind: 'ok', volume: target.validate().volume };
  const code = report.error?.code ?? 'unknown';
  if (code === 'model-op-no-effect') {
    return op === 'intersection' ? { kind: 'empty' } : { kind: 'ok', volume: before };
  }
  return { kind: 'refused', code };
}

export function volumeOf(m: Model): number {
  return m.validate().volume;
}

export interface SeedReport {
  /** Identities evaluated; a refused operand set contributes none of its identities. */
  readonly checked: number;
  readonly refused: readonly string[];
  readonly violations: readonly string[];
  /** Relative residual `|actual - expected| / scale` of every identity that was evaluated. */
  readonly residuals: readonly number[];
}

/**
 * Welding moves a vertex by at most the tolerance, so a curved cut (cylinder against cylinder)
 * leaves a volume residual of order 1e-7 of the larger operand while a plane-only cut stays
 * exact; the bound sits one decade above the measured worst case and far below any wrong solid.
 */
export const IDENTITY_RELATIVE = 1e-6;

/**
 * Volume identities of one operand triple: inclusion-exclusion `V(A+B) + V(A*B) = V(A) + V(B)`,
 * the split `V(A-B) = V(A) - V(A*B)`, idempotence `A+A = A`, and the associativity of the union
 * volume. A structured refusal is a legal answer for contact the kernel cannot resolve; it
 * skips the identities that need that result and is reported, never counted as a pass.
 */
export function checkSeed(seed: number, native?: ComputeBackend): SeedReport {
  const o = operands(seed, native);
  const refused: string[] = [];
  const violations: string[] = [];
  const residuals: number[] = [];
  let checked = 0;
  const va = volumeOf(o.a());
  const vb = volumeOf(o.b());
  const vc = volumeOf(o.c());
  const run = (name: string, target: Model, op: FuzzOp, tool: Model): number | undefined => {
    const r = apply(target, op, tool);
    if (r.kind === 'refused') {
      refused.push(`${name}: ${r.code}`);
      return undefined;
    }
    return r.kind === 'empty' ? 0 : r.volume;
  };
  const near = (name: string, actual: number, expected: number, scale: number) => {
    checked++;
    residuals.push(Math.abs(actual - expected) / scale);
    if (Math.abs(actual - expected) > IDENTITY_RELATIVE * scale) {
      violations.push(`${name}: ${actual} != ${expected}`);
    }
  };
  const union = run('A+B', o.a(), 'union', o.b());
  const shared = run('A*B', o.a(), 'intersection', o.b());
  const rest = run('A-B', o.a(), 'difference', o.b());
  if (union !== undefined && shared !== undefined) {
    near('V(A+B) + V(A*B)', union + shared, va + vb, Math.max(va, vb));
  }
  if (rest !== undefined && shared !== undefined) {
    near('V(A-B)', rest, va - shared, Math.max(va, vb));
  }
  const twice = run('A+A', o.a(), 'union', o.a());
  if (twice !== undefined) near('V(A+A)', twice, va, Math.max(va, vb));
  const left = ((): number | undefined => {
    const m = o.a();
    return run('A+B', m, 'union', o.b()) === undefined
      ? undefined
      : run('(A+B)+C', m, 'union', o.c());
  })();
  const right = ((): number | undefined => {
    const bc = o.b();
    if (run('B+C', bc, 'union', o.c()) === undefined) return undefined;
    return run('A+(B+C)', o.a(), 'union', bc);
  })();
  if (left !== undefined && right !== undefined) {
    near('V((A+B)+C) vs V(A+(B+C))', left, right, Math.max(va, vb, vc));
  }
  return {
    checked,
    refused,
    residuals,
    violations: violations.map((v) => `${o.describe()}\n  ${v}`),
  };
}
