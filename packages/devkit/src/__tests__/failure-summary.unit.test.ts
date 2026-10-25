import { describe, expect, it } from 'vitest';
import { failureSummary } from '../failure-summary.js';
import { sessionOpenFailure } from '../play.js';

// H15: a Surface shader referencing a missing field made `project play` report
// `message: [object Object]`; only `project build` showed the composer error.
const shaderStartupFailure = {
  code: 'produce-failed',
  expected: 'the production task completes with a validated product',
  hint: 'inspect the source, repair the producer, rebuild, verify, and retry',
  detail: { stage: 'produce', subject: '/game/assets/planet.pack.ts' },
  cause: {
    code: 'native-cook-failed',
    expected: 'a registered native cooker to produce a complete draft',
    hint: 'register the cooker or repair its draft, then rerun recovery',
    detail: { producer: 'Composer error: invalid field accessor normalWS' },
  },
};

describe('failure summaries', () => {
  it('names the play startup failure from the structured cause, not [object Object]', () => {
    const failure = sessionOpenFailure(shaderStartupFailure);
    expect(failure.message).not.toContain('[object Object]');
    expect(failure.message).toContain('produce-failed <- native-cook-failed');
    expect(failure.message).toContain('Composer error: invalid field accessor normalWS');
    expect(failure).toMatchObject({ code: 'play-not-ready', reason: 'session-failed' });
  });

  it('keeps an uncoded Error message and stringifies other values', () => {
    expect(failureSummary(new Error('browser closed'))).toBe('browser closed');
    expect(failureSummary('plain')).toBe('plain');
    expect(failureSummary(undefined)).toBe('undefined');
  });

  it('appends the message of an uncoded tail cause', () => {
    expect(
      failureSummary({
        code: 'shader-compile-failed',
        hint: 'fix the WGSL module',
        cause: new Error('unknown identifier `normalWS`'),
      }),
    ).toBe(
      'shader-compile-failed: hint: fix the WGSL module; message: unknown identifier `normalWS`',
    );
  });

  it('keeps the code-and-hint form for a failure without a cause', () => {
    expect(
      failureSummary({ code: 'dev-server-failed', expected: 'x', hint: 'retry', detail: {} }),
    ).toBe('dev-server-failed: retry');
  });
});
