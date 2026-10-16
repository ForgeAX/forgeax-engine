import type { AudioClipAsset } from '@forgeax/engine-audio';
import { expectTypeOf } from 'vitest';

declare const loadedClip: AudioClipAsset;
expectTypeOf(loadedClip.mediaType).toMatchTypeOf<`audio/${string}`>();
expectTypeOf(loadedClip.bytes).toEqualTypeOf<Uint8Array | undefined>();
