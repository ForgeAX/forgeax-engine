import { expectTypeOf, it } from 'vitest';
import type { AudioClipAsset } from '../index';

it('keeps AudioClipAsset realm-neutral', () => {
  const clip = null as unknown as AudioClipAsset;
  expectTypeOf(clip.sourceKey).toBeString();
  expectTypeOf(clip.bytes).toEqualTypeOf<Uint8Array | undefined>();
  // @ts-expect-error AudioBuffer belongs to the Host consumer cache
  void clip.buffer;
});
