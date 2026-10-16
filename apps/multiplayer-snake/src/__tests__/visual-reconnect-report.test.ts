import { describe, expect, it } from 'vitest';
import {
  RECONNECT_EXPECTATIONS,
  RECONNECT_TARGET_ID,
  RECONNECT_VIEWPORT,
  validateReconnectVisualReport,
} from '../../scripts/browser-e2e.mjs';

function validReport() {
  const invocationId = 'visual-test';
  return {
    schemaVersion: 1,
    targetId: RECONNECT_TARGET_ID,
    invocationId,
    trace: { schemaVersion: 1, targetId: RECONNECT_TARGET_ID, invocationId },
    screenshot: {
      targetId: RECONNECT_TARGET_ID,
      path: '/tmp/multiplayer-snake-reconnect.png',
      bytes: 1234,
      ...RECONNECT_VIEWPORT,
    },
    visualAssessment: {
      invocationId,
      status: 'passed',
      verdict: 'pass',
      expectations: RECONNECT_EXPECTATIONS.map(({ id, statement }) => ({
        id,
        statement,
        observed: `${id} was visible in the captured PNG`,
        verdict: 'pass',
        confidence: 'high',
      })),
    },
  };
}

describe('multiplayer-snake reconnect visual report', () => {
  it('requires executor-read evidence for both visual expectations', () => {
    expect(validateReconnectVisualReport(validReport())).toEqual({ ok: true, failures: [] });
  });

  it('rejects an unread capture and identifies the failed expectation', () => {
    const report = validReport();
    report.visualAssessment.status = 'failed';
    report.visualAssessment.verdict = 'fail';
    const firstExpectation = report.visualAssessment.expectations[0];
    if (firstExpectation === undefined)
      throw new Error('visual report fixture is missing its first expectation');
    firstExpectation.verdict = 'fail';
    const result = validateReconnectVisualReport(report);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        { code: 'visual-assessment-pending' },
        { code: 'visual-expectation-failed', expectationId: 'authority-derived-convergence' },
      ]),
    );
  });

  it('rejects a screenshot outside the shared presentation budget', () => {
    const report = validReport();
    report.screenshot.width -= 1;
    const result = validateReconnectVisualReport(report);
    expect(result.failures).toContainEqual({ code: 'report-screenshot-missing' });
  });
});
