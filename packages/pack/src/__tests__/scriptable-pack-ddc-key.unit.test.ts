import { describe, expect, it } from 'vitest';
import {
  type ProducerSemanticIdentityInput,
  producerRelativeDdcKey,
  producerRelativeLogicalPath,
} from '../evidence/producer-identity.js';

const base = (
  overrides: Partial<ProducerSemanticIdentityInput> = {},
): ProducerSemanticIdentityInput => ({
  producerRoot: '/checkout/game-a',
  sourcePath: '/checkout/game-a/assets/vehicle.pack.ts',
  sourceDigest: 'sha256:source',
  schemaVersion: '1.0.0',
  importer: 'scriptable-pack-importer@2',
  codec: 'pack-v2',
  settings: { compression: 'basis', quality: 8 },
  producer: 'scriptable-pack@4',
  profile: 'webgpu/v1',
  declaredGuids: ['guid-vehicle'],
  ...overrides,
});

describe('producer-relative ScriptablePack DDC identity', () => {
  it('uses producer-root-relative logical path rather than absolute checkout path', () => {
    expect(
      producerRelativeLogicalPath('/checkout/game-a', '/checkout/game-a/assets/vehicle.pack.ts'),
    ).toBe('assets/vehicle.pack.ts');
    expect(
      producerRelativeDdcKey(
        base({
          producerRoot: '/checkout/game-b',
          sourcePath: '/checkout/game-b/assets/vehicle.pack.ts',
        }),
      ),
    ).toBe(producerRelativeDdcKey(base()));
  });

  it.each([
    ['source', { sourceDigest: 'sha256:changed' }],
    ['importer', { importer: 'other-importer@1' }],
    ['codec', { codec: 'other-codec' }],
    ['settings', { settings: { compression: 'raw', quality: 8 } }],
    ['producer', { producer: 'other-producer@1' }],
    ['profile', { profile: 'webgl2/fallback' }],
    ['schema', { schemaVersion: '2.0.0' }],
  ])('misses when semantic input %s changes', (_name, change) => {
    expect(producerRelativeDdcKey(base(change))).not.toBe(producerRelativeDdcKey(base()));
  });
});
