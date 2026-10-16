import { describe, expect, it } from 'vitest';
import { runGpuLodSilhouetteEvidence } from './gpu-lod-evidence';

const browserReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

describe.skipIf(!browserReady)('GPU LOD Browser silhouette evidence', () => {
  it('publishes distinct composite silhouettes with matching identity', () => {
    const evidence = runGpuLodSilhouetteEvidence();
    expect(evidence.status).toBe('available');
    expect(new Set(evidence.levelSignatures).size).toBe(3);
    expect(evidence.identity.view).toContain('lod-evidence-view');
  });
});
