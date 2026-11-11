import {
  projectPackGenerationModules,
  readPackAuthoringDeclaration,
} from '@forgeax/engine-pack/build';
import { describe, expect, it } from 'vitest';
import { failureSummary } from '../failure-summary.js';
import { type PlayReport, playFailureError, sessionOpenFailure } from '../play.js';

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

  it('keeps the rejected live generation import and the allowed list in the compact play error', () => {
    const path = '/game/project/assets/a-long-feature-folder/scene.pack.ts';
    const source = `import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { Fog, createRenderer } from '@forgeax/engine/render';
export default definePack({ schemaVersion: '2.0.0', packageId: definePackageId('01900000-0000-7000-8000-000000000078'), build: () => [Fog, createRenderer] });`;
    const declaration = readPackAuthoringDeclaration(path, source);
    if (!declaration.ok) throw new Error('fixture declaration must parse');
    let rejection: unknown;
    try {
      projectPackGenerationModules(path, { [path]: source }, declaration.value);
    } catch (error) {
      rejection = error;
    }
    const failure = sessionOpenFailure({
      code: 'pack-malformed-meta',
      expected: 'a valid Pack meta sidecar',
      hint: 'repair detail.path using detail.ajvErrors',
      detail: { path },
      cause: rejection,
    });
    const report = {
      root: '/game/project',
      report: '/game/project/artifacts/play/scripts/smoke/play.json',
      errors: { console: [], page: [], inputWarnings: 0 },
      log: [],
      failure,
    } as unknown as PlayReport;
    const message = (playFailureError(report)?.detail as { message?: string }).message;
    expect(message).toContain(
      'createRenderer from @forgeax/engine/render: not on the live generation list; allowed: Materials',
    );
    expect(message).not.toContain('Fog from');
  });
});
