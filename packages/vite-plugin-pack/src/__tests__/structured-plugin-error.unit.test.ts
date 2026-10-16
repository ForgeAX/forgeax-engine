import { describe, expect, it } from 'vitest';
import { structuredPluginError } from '../structured-plugin-error.js';

describe('structuredPluginError', () => {
  it('retains the repairable source diagnostic when a bundler only prints message', () => {
    const error = structuredPluginError({
      code: 'import-internal-error',
      expected: 'a valid source build',
      hint: 'repair the authored source',
      detail: { reason: 'architecture.ts:169:1: missing closing brace' },
    });
    expect(error.message).toContain('architecture.ts:169:1');
    expect(error.message).toContain('repair the authored source');
  });
  it('preserves recovery fields across the Vite Error boundary', () => {
    const detail = { sourcePath: 'broken.pack.ts', reason: 'domain-cook' };
    const error = structuredPluginError({
      code: 'scene-cook-failed',
      expected: 'a valid scene hierarchy',
      hint: 'repair the parent relationship and rebuild',
      detail,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      code: 'scene-cook-failed',
      expected: 'a valid scene hierarchy',
      hint: 'repair the parent relationship and rebuild',
      detail,
    });
  });

  it('keeps source generation and affected GUID facts on the thrown error', () => {
    const error = structuredPluginError({
      code: 'source-package-publication-invalid',
      expected: 'a complete Pack generation',
      hint: 'repair the artifact and cold-cook the source package',
      detail: {
        sourceMeta: 'broken.pack.ts',
        generation: 'sha256:generation',
        affectedGuids: ['guid-a', 'guid-b'],
        stage: 'route-integrity',
      },
    });

    expect(error).toMatchObject({
      code: 'source-package-publication-invalid',
      expected: 'a complete Pack generation',
      hint: expect.stringMatching(/repair|cold-cook/),
      detail: {
        sourceMeta: 'broken.pack.ts',
        generation: 'sha256:generation',
        affectedGuids: ['guid-a', 'guid-b'],
        stage: 'route-integrity',
      },
    });
  });

  it('keeps detail optional without changing the structured error identity', () => {
    const error = structuredPluginError({
      code: 'source-package-ddc-failed',
      expected: 'a persistent DDC entry',
      hint: 'discard the invalid entry and cold-cook the source package',
    });

    expect(error.message).toContain('source-package-ddc-failed: a persistent DDC entry');
    expect(error.detail).toBeUndefined();
    expect(error.code).toBe('source-package-ddc-failed');
  });

  it('keeps machine-readable recovery provenance through JSON transport', () => {
    const error = structuredPluginError({
      code: 'pack-source-output-invalid',
      expected: 'producer refs and artifacts to satisfy Pack v2',
      hint: 'inspect the producer, rebuild, then refresh the Catalog LKG',
      detail: { sourceKey: 'audio', guid: 'guid-a', stage: 'artifact' },
    });
    const roundTripped = JSON.parse(
      JSON.stringify({
        code: error.code,
        expected: error.expected,
        hint: error.hint,
        detail: error.detail,
      }),
    );
    expect(roundTripped).toEqual({
      code: 'pack-source-output-invalid',
      expected: 'producer refs and artifacts to satisfy Pack v2',
      hint: 'inspect the producer, rebuild, then refresh the Catalog LKG',
      detail: { sourceKey: 'audio', guid: 'guid-a', stage: 'artifact' },
    });
  });
});
