import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { dispatchCaseReport } from '../run-all.mjs';

let root;

afterEach(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function writeCaseReport(payload) {
  root = mkdtempSync(`${tmpdir()}/forgeax-case-report-`);
  writeFileSync(resolve(root, 'case-report.json'), `${JSON.stringify(payload)}\n`, 'utf8');
}

describe('dispatchCaseReport fail-closed semantics', () => {
  it('returns unavailable when the required report is missing', () => {
    root = mkdtempSync(`${tmpdir()}/forgeax-case-report-`);

    const result = dispatchCaseReport('parity-color-lighting', root, {
      enabled: true,
      reportPath: 'case-report.json',
      required: true,
    });

    expect(result.status).toBe('unavailable');
    expect(result.details.code).toBe('case-report-missing');
  });

  it.each([
    ['failed', { status: 'failed', verdict: 'failed', required: true }],
    ['not executed', { status: 'partial', verdict: 'notRun', required: true }],
  ])('does not promote a %s required report to ok', (_label, report) => {
    writeCaseReport(report);

    const result = dispatchCaseReport('parity-color-lighting', root, {
      enabled: true,
      reportPath: 'case-report.json',
      required: true,
    });

    expect(result.status).toBe('unavailable');
    expect(result.details.code).toBe('case-report-not-passing');
  });
});
