import type { TextureAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { textureDigest } from '../render-system-extract';

it('retains exact byte digests for offset views and observes in-place edits', () => {
  const data = Uint8Array.from({ length: 4096 }, (_, i) => i * 71).subarray(17, 4000);
  const texture = { data } as TextureAsset;
  const original = () => {
    let hash = 2166136261;
    for (const byte of data) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return `fnv1a:${hash.toString(16).padStart(8, '0')}`;
  };
  const before = textureDigest(texture);
  expect(before).toBe(original());
  const edited = data[10];
  if (edited === undefined) throw new Error('missing texture mutation byte');
  data[10] = edited ^ 1;
  expect(textureDigest(texture)).toBe(original());
  expect(textureDigest(texture)).not.toBe(before);
  expect(textureDigest({ data: new Uint8Array() } as TextureAsset)).toBe('fnv1a:811c9dc5');
});
