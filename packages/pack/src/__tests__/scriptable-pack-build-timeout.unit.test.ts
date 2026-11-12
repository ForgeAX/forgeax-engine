import { describe, expect, it } from 'vitest';
import {
  SCRIPTABLE_PACK_BUILD_TIMEOUT_ENV,
  SCRIPTABLE_PACK_BUILD_TIMEOUT_MS,
  SCRIPTABLE_PACK_MAX_BUILD_TIMEOUT_MS,
  scriptablePackBuildTimeoutMs,
} from '../scriptable-pack-node';

describe('ScriptablePack build timeout', () => {
  it('keeps the finite default when the host sets no budget', () => {
    expect(scriptablePackBuildTimeoutMs({})).toBe(SCRIPTABLE_PACK_BUILD_TIMEOUT_MS);
    expect(scriptablePackBuildTimeoutMs({ [SCRIPTABLE_PACK_BUILD_TIMEOUT_ENV]: '' })).toBe(
      SCRIPTABLE_PACK_BUILD_TIMEOUT_MS,
    );
  });

  it('raises the bound for a slow host up to the finite ceiling', () => {
    expect(scriptablePackBuildTimeoutMs({ [SCRIPTABLE_PACK_BUILD_TIMEOUT_ENV]: '600000' })).toBe(
      600_000,
    );
    expect(
      scriptablePackBuildTimeoutMs({
        [SCRIPTABLE_PACK_BUILD_TIMEOUT_ENV]: String(SCRIPTABLE_PACK_MAX_BUILD_TIMEOUT_MS),
      }),
    ).toBe(SCRIPTABLE_PACK_MAX_BUILD_TIMEOUT_MS);
  });

  it.each([
    '60000',
    '1800001',
    '300000.5',
    'ten minutes',
  ])('rejects %s instead of silently building without a bound', (value) => {
    expect(() =>
      scriptablePackBuildTimeoutMs({ [SCRIPTABLE_PACK_BUILD_TIMEOUT_ENV]: value }),
    ).toThrow(SCRIPTABLE_PACK_BUILD_TIMEOUT_ENV);
  });
});
