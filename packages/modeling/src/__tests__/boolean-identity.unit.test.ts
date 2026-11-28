import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { tsBackend } from '../compute/boolean-ts';
import type { BackendOutput, ComputeBackend, ComputeJobKind } from '../compute/job';
import { decodeSnapshot, encodeSnapshot } from '../fxem';
import { model } from '../model';
import { type FuzzOp, scene } from './support/fuzz';
import { checkSeed, IDENTITY_RELATIVE, operands } from './support/identity';

const SEEDS = Number(process.env.FORGEAX_FUZZ_SEEDS ?? 200);

function mutant(change: (run: ComputeBackend['run']) => ComputeBackend['run']): ComputeBackend {
  return {
    name: 'native',
    identity: 'mutant@0',
    supports: (kind: ComputeJobKind) => kind === 'boolean',
    quality: () => 'production',
    run: change(tsBackend.run.bind(tsBackend)),
  };
}

function sweep(native?: ComputeBackend) {
  let checked = 0;
  let attempted = 0;
  const refused: string[] = [];
  const violations: string[] = [];
  const residuals: number[] = [];
  for (let seed = 0; seed < SEEDS; seed++) {
    const r = checkSeed(seed, native);
    checked += r.checked;
    attempted += 8;
    refused.push(...r.refused);
    violations.push(...r.violations);
    residuals.push(...r.residuals);
  }
  return { checked, attempted, refused, violations, residuals };
}

describe('boolean volume identities on seeded grid-snapped operands', () => {
  const base = sweep();

  it('hold within the relative bound on every seed that is not refused', () => {
    expect(base.violations, base.violations.join('\n')).toEqual([]);
    expect(base.checked).toBeGreaterThan(SEEDS * 3);
    expect(Math.max(...base.residuals)).toBeLessThanOrEqual(IDENTITY_RELATIVE);
  });

  it('are refused only through the structured partial and degenerate answers, and rarely', () => {
    const codes = new Set(base.refused.map((r) => r.split(': ')[1]));
    expect([...codes].every((c) => c === 'model-partial' || c === 'model-degenerate')).toBe(true);
    expect(base.refused.length / base.attempted).toBeLessThan(0.05);
  });

  it('falsifier: a backend that computes the intersection when asked for a difference is caught', () => {
    const wrong = mutant((run) => (request, work) => {
      const params = request.params as { operation: string };
      const swapped =
        params.operation === 'difference' ? { ...params, operation: 'intersection' } : params;
      return run({ ...request, params: swapped } as never, work);
    });
    const r = sweep(wrong);
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.violations.some((v) => v.includes('V(A-B)'))).toBe(true);
  });
});

describe('boolean locality guard', () => {
  const ops: readonly FuzzOp[] = ['union', 'difference', 'intersection'];

  it('accepts the result of every operation on a seeded operand pair', () => {
    for (let seed = 0; seed < 20; seed++) {
      for (const op of ops) {
        const o = operands(seed);
        const target = o.a();
        const report = target[op](o.b());
        expect(report.error?.detail?.guard, o.describe()).toBeUndefined();
      }
    }
  });

  it('falsifier: a result displaced by one meter is model-internal with guard locality', () => {
    const displaced = mutant((run) => (request, work) => {
      const out = run(request, work);
      if (!out.ok) return out;
      const value = out.value as BackendOutput<'boolean'>;
      const moved = value.outputs.map((bytes) => {
        const mesh = decodeSnapshot(bytes);
        if (!mesh.ok) return bytes;
        for (const v of mesh.value.vertices()) {
          const p = mesh.value.position(v);
          mesh.value.setPosition(v, p[0] + 1, p[1], p[2]);
        }
        return encodeSnapshot(mesh.value);
      });
      return ok({ ...value, outputs: moved } as never);
    });
    const m = model({ native: displaced });
    m.box({ size: [1, 1, 1] });
    const tool = model();
    tool.box({ size: [0.5, 0.5, 2], center: [0.1, 0, 0] });
    const before = m.snapshot();
    const report = m.difference(tool);
    expect(report.error?.code).toBe('model-internal');
    expect(report.error?.detail?.guard).toBe('locality');
    expect(m.snapshot()).toEqual(before);
  });
});

describe('seeded fuzz scene', () => {
  const options = { primitives: 4, ops: ['union', 'difference'] as FuzzOp[] };

  it('gives the same reproducer and the same FXEM bytes for the same seed', () => {
    const a = model();
    const b = model();
    scene(7, options).build(a);
    scene(7, options).build(b);
    expect(scene(7, options).describe()).toBe(scene(7, options).describe());
    expect(a.snapshot()).toEqual(b.snapshot());
  });

  it('differs between seeds', () => {
    expect(scene(7, options).describe()).not.toBe(scene(8, options).describe());
  });

  it('rejects a scene with tools and no operation', () => {
    expect(() => scene(1, { primitives: 2, ops: [] })).toThrow();
  });

  it('produces coplanar and tangent contacts on purpose', () => {
    let coplanar = 0;
    let tangent = 0;
    for (let seed = 0; seed < 200; seed++) {
      const [a, b] = scene(seed, {
        primitives: 2,
        grid: 1,
        ops: ['union'],
      }).primitives;
      if (a === undefined || b === undefined) continue;
      for (let k = 0; k < 3; k++) {
        const lo = (p: typeof a) => (p.center[k] as number) - (p.half[k] as number);
        const hi = (p: typeof a) => (p.center[k] as number) + (p.half[k] as number);
        if (lo(a) === lo(b) || hi(a) === hi(b)) coplanar++;
        if (hi(a) === lo(b) || hi(b) === lo(a)) tangent++;
      }
    }
    expect(coplanar).toBeGreaterThan(20);
    expect(tangent).toBeGreaterThan(5);
  });
});
