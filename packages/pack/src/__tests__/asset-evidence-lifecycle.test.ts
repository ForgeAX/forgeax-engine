import { projectAssetEvidence } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const guid = '11111111-1111-4111-8111-111111111111';
const receipt = {
  guid,
  origin: 'sourceMeta' as const,
  status: 'succeeded' as const,
  inputFingerprint: 'fp-1',
  outputDigest: 'digest-1',
};
const descriptor = {
  path: 'artifacts/data.bin',
  mediaType: 'application/octet-stream',
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    guid,
    source: { origin: 'sourceMeta' as const, inputFingerprint: 'fp-1' },
    locator: { packageUrl: '/assets/data.pack.json' },
    artifacts: { data: descriptor },
    runtime: { status: 'unknown' as const },
    ...overrides,
  };
}

describe('AssetEvidence lifecycle', () => {
  it('distinguishes authored, uncooked, failed, current, stale, and shipped states', () => {
    const authored = projectAssetEvidence(
      input({
        source: { origin: 'authoredPack' },
        receipt: { ...receipt, origin: 'authoredPack' },
      }),
    );
    const uncooked = projectAssetEvidence(input());
    const failed = projectAssetEvidence(
      input({
        receipt: {
          ...receipt,
          status: 'failed',
          error: {
            code: 'import-failed',
            expected: 'source imports',
            hint: 'fix source and recook',
          },
        },
      }),
    );
    const current = projectAssetEvidence(input({ receipt }));
    const stale = projectAssetEvidence(
      input({
        source: { origin: 'sourceMeta', inputFingerprint: 'fp-2' },
        receipt,
      }),
    );
    const shipped = projectAssetEvidence(input({ source: undefined, receipt }));

    expect(authored.ok && authored.value.cook.status).toBe('notRequired');
    expect(uncooked.ok && uncooked.value.cook.status).toBe('notCooked');
    expect(failed.ok && failed.value.cook.status).toBe('failed');
    expect(current.ok && current.value.cook.freshness).toBe('current');
    expect(stale.ok && stale.value.cook.freshness).toBe('stale');
    expect(shipped.ok && shipped.value.cook.freshness).toBe('unknown');
  });

  it('returns a structured conflict instead of masking contradictory evidence', () => {
    const conflict = projectAssetEvidence(
      input({
        locators: [{ packageUrl: '/assets/a.pack.json' }, { packageUrl: '/assets/b.pack.json' }],
      }),
    );

    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe('asset-evidence-locator-conflict');
    expect(conflict.error.expected).toContain('one package locator');
    expect(conflict.error.hint).toBeTruthy();
    expect(conflict.error.detail).toMatchObject({ guid });
  });

  it('does not treat a failed recook as current evidence', () => {
    const failed = projectAssetEvidence(
      input({
        source: { origin: 'sourceMeta', inputFingerprint: 'fp-2' },
        receipt: {
          ...receipt,
          inputFingerprint: 'fp-1',
          status: 'failed',
          error: {
            code: 'producer-failed',
            expected: 'a validated output',
            hint: 'repair the source and recook',
          },
        },
      }),
    );

    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.cook.status).toBe('failed');
    expect(failed.value.cook.freshness).not.toBe('current');
  });
});
