import { describe, expect, it } from 'vitest';
import {
  type ProducerSemanticIdentityInput,
  producerRelativeDdcKey,
  producerRelativeLogicalPath,
} from '../evidence/producer-identity.js';

describe('source inventory DDC cold path contract', () => {
  const input: ProducerSemanticIdentityInput = {
    producerRoot: '/tmp/game',
    sourcePath: '/tmp/game/assets/tree.pack.ts',
    sourceDigest: 'sha256:tree',
    schemaVersion: '1.0.0',
    importer: 'scriptable-pack-importer@2',
    codec: 'pack-v2',
    settings: { profile: 'default' },
    producer: 'scriptable-pack@4',
    profile: 'webgpu/v1',
    declaredGuids: ['tree-guid'],
  };

  it('rejects a source outside the injected producer root instead of guessing a basename', () => {
    expect(() => producerRelativeLogicalPath('/tmp/game', '/tmp/other/tree.pack.ts')).toThrow();
  });

  it('keeps the correctness key independent from cache availability', () => {
    const key = producerRelativeDdcKey(input);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(
      producerRelativeDdcKey({
        ...input,
        producerRoot: '/tmp/another-game',
        sourcePath: '/tmp/another-game/assets/tree.pack.ts',
      }),
    ).toBe(key);
  });
});
