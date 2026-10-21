import { describe, expect, it } from 'vitest';
import {
  appendPluginPackCleanup,
  createPluginPackFailure,
  PLUGIN_PACK_FAILURE_STAGES,
} from '../errors.js';

describe('PluginPackFailure', () => {
  it('provides a closed, deterministic contract for every failure stage', () => {
    for (const stage of PLUGIN_PACK_FAILURE_STAGES) {
      const code = `${stage}-failed` as const;
      const failure = createPluginPackFailure({
        code,
        expected: `the ${stage} stage completes`,
        hint: `inspect ${stage} inputs, repair the owner, and retry`,
        detail: { stage, subject: 'source-a' },
        cause: new Error(`${stage} cause`),
      });

      expect(failure).toMatchObject({
        code,
        expected: `the ${stage} stage completes`,
        hint: `inspect ${stage} inputs, repair the owner, and retry`,
        detail: { stage, subject: 'source-a' },
      });
      expect(failure.cause).toBeInstanceOf(Error);
    }
  });

  it('appends cleanup failures without replacing the primary cause', () => {
    const primary = createPluginPackFailure({
      code: 'produce-failed',
      expected: 'the producer returns a complete product',
      hint: 'inspect the source, repair the producer, rebuild, and retry',
      detail: { stage: 'produce', subject: 'source-a' },
      cause: new Error('primary'),
    });
    const cleanup = createPluginPackFailure({
      code: 'cleanup-failed',
      expected: 'the candidate is discarded',
      hint: 'inspect the candidate lease and retry cleanup',
      detail: { stage: 'cleanup', subject: 'source-a' },
      cause: new Error('cleanup'),
    });

    const combined = appendPluginPackCleanup(primary, cleanup);

    expect(combined.code).toBe('produce-failed');
    expect(combined.cause).toBe(primary.cause);
    expect(combined.cleanup).toEqual([cleanup]);
  });
});
