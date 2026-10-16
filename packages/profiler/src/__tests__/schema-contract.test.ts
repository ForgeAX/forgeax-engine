import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateProfileCapture } from '../schema.js';

type Fixture = Record<string, unknown>;

function readFixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/profile-capture/${name}`, import.meta.url), 'utf8'),
  ) as Fixture;
}

describe('ProfileCapture schema contract', () => {
  it('accepts complete and overflow self-describing captures', () => {
    for (const name of ['valid-complete.json', 'valid-overflow.json']) {
      const result = validateProfileCapture(readFixture(name));
      expect(result.ok, `${name} should be valid`).toBe(true);
    }
  });

  it('rejects every declared invalid boundary and completeness case', () => {
    const fixture = readFixture('invalid-boundary.json');
    const cases = fixture.cases as Array<{ name: string; capture: Fixture }>;

    expect(cases.length).toBeGreaterThanOrEqual(8);
    for (const testCase of cases) {
      const result = validateProfileCapture(testCase.capture);
      expect(result.ok, `${testCase.name} should be rejected`).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toMatch(/^profile-artifact-/);
    }
  });

  it('rejects an unknown phase without a second hard-coded phase list', () => {
    const capture = readFixture('valid-complete.json');
    const records = capture.records as Fixture[];
    records[0] = { ...records[0], phase: 'phase-not-in-catalog' };

    const result = validateProfileCapture(capture);
    expect(result.ok).toBe(false);
  });
});
