import { describe, expect, it } from 'vitest';
import { projectFailureCause } from '../errors.js';

describe('definition diagnostic projection', () => {
  it('preserves bounded module-load diagnostics and rejects arbitrary diagnostic objects', () => {
    expect(
      projectFailureCause({
        detail: {
          sourcePath: 'assets/scene.pack.ts',
          phase: 'module-load',
          diagnostic: 'AssetGuidParser is not defined'.repeat(100),
          token: 'private',
        },
      }),
    ).toEqual({
      detail: {
        sourcePath: 'assets/scene.pack.ts',
        phase: 'module-load',
        diagnostic: 'AssetGuidParser is not defined'.repeat(100).slice(0, 2000),
      },
    });
    expect(
      projectFailureCause({
        code: 'failed',
        detail: {
          diagnostic: { secret: 'private' },
          phase: ['private'],
        },
      }),
    ).toEqual({ code: 'failed' });
  });
  it('preserves bounded definition fields without arbitrary values or stack', () => {
    const detail = {
      propertyPath: 'x'.repeat(2100),
      actual: 'undefined',
      sourcePath: 'scene.pack.ts',
      password: 'private-value',
      stack: 'private-stack',
      token: 'private-token',
    };
    const cause = { code: 'pack-source-definition-invalid', detail, stack: 'private-stack' };
    const projected = projectFailureCause(cause);
    expect(projected).toEqual({
      code: cause.code,
      detail: { propertyPath: 'x'.repeat(2000), actual: 'undefined', sourcePath: 'scene.pack.ts' },
    });
    expect(
      projectFailureCause({
        code: cause.code,
        detail: {
          propertyPath: { token: 'private-value' },
          actual: new Error('private-value'),
        },
      }),
    ).toEqual({ code: cause.code });
    expect(
      projectFailureCause({
        code: cause.code,
        detail: {
          propertyPath: ['private-value'],
          actual: ['private-value'],
        },
      }),
    ).toEqual({ code: cause.code });
    expect(JSON.stringify(projected)).not.toContain('private-');
  });
});
