import { projectAssetEvidence } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { parsePackV2 } from '../index.js';

const guid = '11111111-1111-4111-8111-111111111111';

describe('AssetEvidence pack projection schema', () => {
  it('retains a package locator and asset-local artifact facts separately', () => {
    const pack = parsePackV2({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid,
          kind: 'host-config',
          payload: { value: 1 },
          refs: [],
          artifacts: {
            source: {
              path: 'artifacts/source.json',
              mediaType: 'application/json',
              assetCodec: { name: 'json' },
            },
          },
        },
      ],
    });

    expect(pack.ok).toBe(true);
    if (!pack.ok) return;
    const asset = pack.value.assets[0];
    expect(asset).toBeDefined();
    if (asset === undefined) return;
    const evidence = projectAssetEvidence({
      guid,
      source: { origin: 'sourceMeta', sourcePath: 'assets/config.json', inputFingerprint: 'fp-1' },
      locator: { packageUrl: '/assets/config.pack.json' },
      receipt: {
        guid,
        origin: 'sourceMeta',
        status: 'succeeded',
        inputFingerprint: 'fp-1',
        outputDigest: 'digest-1',
      },
      packageVerification: { status: 'passed', digest: 'digest-1' },
      artifacts: asset.artifacts,
      runtime: { status: 'unknown' },
    });

    expect(evidence.ok).toBe(true);
    if (!evidence.ok) return;
    expect(evidence.value.packageUrl).toBe('/assets/config.pack.json');
    const sourceArtifact = evidence.value.artifacts.source;
    expect(sourceArtifact).toBeDefined();
    if (sourceArtifact === undefined) return;
    expect(sourceArtifact.verification).toBe('notChecked');
  });

  it('rejects evidence projection when receipt GUID or digest is not the product GUID', async () => {
    const { projectCookProductEvidence } = await import('@forgeax/engine-types');
    const result = projectCookProductEvidence({
      guid,
      payload: { kind: 'host-config', value: 1 },
      refs: [],
      artifacts: {
        source: {
          path: 'artifacts/source.json',
          mediaType: 'application/json',
        },
      },
      digest: 'digest-1',
      receipt: {
        guid: '22222222-2222-4222-8222-222222222222',
        origin: 'sourceMeta',
        status: 'succeeded',
        inputFingerprint: 'fp-1',
        outputDigest: 'digest-2',
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'asset-evidence-receipt-conflict' },
    });
  });
});
