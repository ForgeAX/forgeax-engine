import { describe, expect, it } from 'vitest';
import { inspectVfxSubject } from '../domains/vfx.js';

const asset = {
  kind: 'particle-effect',
  schemaVersion: 3,
  programFingerprint: 'sha256:program',
  emitters: [{ id: 'sparks', capacity: 32 }],
  program: {
    format: 'forgeax-vfx-program-4',
    fingerprint: 'sha256:program',
    emitters: [
      {
        id: 'sparks',
        module: 'sparks.vfx.wgsl',
        capacity: 32,
        backend: { required: 'gpu' },
        space: 'world',
        schedule: { rate: 60 },
        bounds: { kind: 'sphere', center: [0, 0, 0], radius: 2 },
        renderers: [{ kind: 'billboard', enabled: true }],
        simulationWhenCulled: 'continue',
        wgsl: 'cooked',
        reflection: {
          hooks: ['vfx_spawn', 'vfx_update'],
          imports: [],
          resources: [],
          entryPoints: [],
          bindings: [],
        },
      },
    ],
  },
};

describe('VFX subject owner contract', () => {
  it('derives preview facts from the cooked ParticleEffectAsset', () => {
    const result = inspectVfxSubject({ guid: 'vfx-guid', asset });

    expect(result).toEqual({
      ok: true,
      value: {
        subjectDigest: 'sha256:program',
        programFingerprint: 'sha256:program',
        emitterDigest: '[{"id":"sparks","module":"sparks.vfx.wgsl","capacity":32}]',
        sampleDigest: '[{"id":"sparks","schedule":{"rate":60}}]',
        boundsDigest: '[{"id":"sparks","bounds":{"kind":"sphere","center":[0,0,0],"radius":2}}]',
        computeDigest: 'sha256:program',
        indirectDigest: '[{"id":"sparks","renderers":[{"kind":"billboard","enabled":true}]}]',
        authoredBounds: [-2, -2, -2, 2, 2, 2],
      },
    });
  });

  it('rejects the removed synthetic VFX asset kind', () => {
    const result = inspectVfxSubject({ guid: 'vfx-guid', asset: { kind: 'vfx' } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('resource-preview-kind-mismatch');
  });
});
