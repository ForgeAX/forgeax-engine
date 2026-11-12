import { expect } from 'vitest';
import type { Coverage, Issue } from '../../report';

/** The part of a gate's report every adopting gate shares. */
export interface GateResult<C extends string> {
  readonly pass: boolean;
  readonly issues: readonly Issue<C>[];
  readonly coverage: Coverage<C>;
}

/**
 * A gate is falsifiable when its clean twin passes and, for every code of its issue union, one
 * input fails with that code. The `Record<C, I>` row type makes a code without a falsifier a
 * compile error.
 */
export function expectFalsifiable<I, C extends string>(
  run: (input: I) => GateResult<C>,
  clean: I,
  falsifiers: Readonly<Record<C, I>>,
): void {
  const twin = run(clean);
  expect(twin.issues, 'the clean twin has findings').toEqual([]);
  expect(twin.pass, 'the clean twin passes').toBe(true);
  const rows = Object.keys(falsifiers);
  for (const { code } of twin.coverage.checked)
    expect(rows, `checked code ${code} has a falsifier`).toContain(code);
  for (const code of rows as C[]) {
    const result = run(falsifiers[code]);
    expect(result.pass, `the ${code} falsifier passes`).toBe(false);
    expect(
      result.issues.map((i) => i.code),
      `the ${code} falsifier does not raise ${code}`,
    ).toContain(code);
  }
}

/**
 * Every enumerated subject is accounted for: checked plus unchecked equals the independently
 * counted total per code.
 */
export function expectConserved<C extends string>(
  coverage: Coverage<C>,
  totals: Readonly<Partial<Record<C, number>>>,
): void {
  for (const code of Object.keys(totals) as C[]) {
    const checked = coverage.checked.find((c) => c.code === code)?.subjects ?? 0;
    const left = coverage.unchecked
      .filter((u) => u.code === code)
      .reduce((sum, u) => sum + u.subjects, 0);
    expect(checked + left, `subjects of ${code}`).toBe(totals[code]);
  }
}
