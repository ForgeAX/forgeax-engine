import type { Result } from '@forgeax/engine-types';
import { expect } from 'vitest';
import type { ModelingError } from '../errors';
import type { RecipePart } from '../recipes';

/** Clean = ok, no error or warning issue, no warning diagnostic in the journal. */
export function expectClean(label: string, result: Result<RecipePart, ModelingError>): RecipePart {
  if (!result.ok)
    throw new Error(`${label}: ${result.error.message} ${JSON.stringify(result.error.detail)}`);
  const m = result.value.model;
  const report = m.validate();
  expect(
    report.issues.filter((i) => i.severity !== 'info'),
    label,
  ).toEqual([]);
  expect(report.closed, label).toBe(true);
  const warnings = m.journal.flatMap((e) =>
    (e.diagnostics ?? []).filter((d) => d.severity === 'warn'),
  );
  expect(warnings, label).toEqual([]);
  const exported = m.toMesh({ normals: { mode: 'weighted' } });
  expect(exported.ok, label).toBe(true);
  return result.value;
}

/** One-at-a-time corners: every parameter at its minimum and maximum, the rest at the base. */
export function corners<T extends object>(
  base: T,
  ranges: { [K in keyof T]?: readonly [T[K], T[K]] },
): T[] {
  const out: T[] = [base];
  for (const [key, pair] of Object.entries(ranges) as [
    keyof T,
    readonly [T[keyof T], T[keyof T]],
  ][]) {
    for (const value of pair) out.push({ ...base, [key]: value });
  }
  return out;
}
