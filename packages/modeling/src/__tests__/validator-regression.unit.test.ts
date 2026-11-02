import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runValidatorRegression, VALIDATOR_CASES } from './validator-cases';

const REPORT = new URL('../../reports/validator-regression.json', import.meta.url);

// 34 builds (C-011 among them) and their validations take a few seconds under a full run.
describe('validator regression set (design 15)', { timeout: 60_000 }, () => {
  it('builds every case without a modeling failure', () => {
    for (const c of VALIDATOR_CASES) {
      expect([c.name, c.build().poisoned?.code]).toEqual([c.name, undefined]);
    }
  });

  it('detects every planted defect and leaves every legal counterexample clean', () => {
    const report = runValidatorRegression((m, options) => m.validate(options).issues);
    const misses = report.cases.filter(
      (c) =>
        c.detected.length !== (c.expected === null ? 0 : 1) ||
        (c.expected !== null && c.detected[0] !== c.expected),
    );
    expect(misses).toEqual([]);
    expect(report.precision).toBe(1);
    expect(report.recall).toBe(1);
    // The committed report is the test artifact; regenerate with FORGEAX_UPDATE_GOLDEN=1.
    if (process.env.FORGEAX_UPDATE_GOLDEN === '1') {
      writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
    }
    expect(report).toEqual(JSON.parse(readFileSync(REPORT, 'utf8')));
  });
});
