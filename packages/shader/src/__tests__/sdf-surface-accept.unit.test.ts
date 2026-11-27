import { expect, it } from 'vitest';
import { SDF_SURFACE_TRACE_WGSL } from '../sdf-surface-trace-wgsl';
import {
  createSurfaceAcceptEvaluator,
  surfaceAcceptCases,
  surfaceAcceptKernel,
  surfaceAcceptMismatches,
  surfaceAcceptMutants,
  surfaceAcceptSource,
  surfaceAcceptWords,
} from './sdf-surface-accept.fixture';

it('executes the current accumulator against all authored ten-field tuple expectations', () => {
  const cases = surfaceAcceptCases();
  const evaluate = createSurfaceAcceptEvaluator();
  expect(cases).toHaveLength(21);
  expect(new Set(cases.map((row) => row.name)).size).toBe(cases.length);
  for (const row of cases) {
    expect(row.best).toHaveLength(10);
    expect(row.hit).toHaveLength(10);
    expect(row.expected).toHaveLength(10);
    expect(surfaceAcceptWords(row.expected)).toHaveLength(12);
    expect(
      surfaceAcceptMismatches(
        surfaceAcceptWords(evaluate(row.best, row.hit)),
        surfaceAcceptWords(row.expected),
      ),
      row.name,
    ).toEqual([]);
  }
  expect(
    surfaceAcceptCases().find((row) => row.name === 'prior-unknown-survives-nearer-hit')
      ?.expected[6],
  ).toBe(0.5);
});

it('keeps one function-local accumulator caller and the existing row/sample restoration', () => {
  expect(SDF_SURFACE_TRACE_WGSL).toContain(
    'fn sdfSurfaceAccept(best:ptr<function,SdfSurfaceTrace>,hit:SdfSurfaceTrace)',
  );
  expect(SDF_SURFACE_TRACE_WGSL.match(/sdfSurfaceAccept\(&best,hit\)/g)).toHaveLength(1);
  expect(SDF_SURFACE_TRACE_WGSL).toContain(
    'if(!sdfSurfaceAcceptAxisTie(&best,hit,packet)){sdfSurfaceAccept(&best,hit);}best.row=row;best.prefixSamples=prefix.samples',
  );
  expect(SDF_SURFACE_TRACE_WGSL.match(/sdfSurfaceCharge\(remaining\)/g)).toHaveLength(2);
  expect(surfaceAcceptKernel).not.toContain('sdfSurfaceTraceRow');
});

it('catches seven actual source mutants with the same independent tuple oracle', () => {
  const cases = surfaceAcceptCases();
  const mutants = surfaceAcceptMutants();
  expect(mutants).toHaveLength(7);
  for (const mutant of mutants) {
    const evaluate = createSurfaceAcceptEvaluator(mutant.source);
    const mismatches = cases.filter(
      (row) =>
        surfaceAcceptMismatches(
          surfaceAcceptWords(evaluate(row.best, row.hit)),
          surfaceAcceptWords(row.expected),
        ).length > 0,
    );
    expect(mismatches.length, mutant.name).toBeGreaterThan(0);
  }
});

it('retains signed zero and normal-edge payload bits without an FP rewrite', () => {
  const cases = surfaceAcceptCases();
  for (const index of [11, 12]) {
    const row = cases[index];
    if (!row) throw Error('Required zero case missing');
    expect(surfaceAcceptWords(row.expected)[4]).toBe(0x80000000);
  }
  const normal = cases[13];
  if (!normal) throw Error('Required minimum-normal case missing');
  expect(surfaceAcceptWords(normal.expected)[6]).toBe(0x00800000);
});

it('rejects unsupported source operations and inputs instead of guessing shader semantics', () => {
  for (const source of [
    surfaceAcceptSource.replace('min(', 'max('),
    surfaceAcceptSource.replace('return;', 'textureLoad();return;'),
    surfaceAcceptSource.replace('hit.lower);', 'hit.lower+1u);'),
  ])
    expect(() => createSurfaceAcceptEvaluator(source)).toThrow(/Unsupported/);
  const row = surfaceAcceptCases()[0];
  if (!row) throw Error('Required case missing');
  expect(() =>
    createSurfaceAcceptEvaluator()([1, 17, 41, 1, 1 / 3, 6, 12, 1, 1, 1], row.hit),
  ).toThrow(/normal-or-zero/);
});
