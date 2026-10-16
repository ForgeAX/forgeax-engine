import type { RhiCaps } from '@forgeax/engine-rhi';
import { expectTypeOf } from 'vitest';
import type { VideoCapabilityDevice } from '../video-player-system';

expectTypeOf<VideoCapabilityDevice['caps']['externalTexture']>().toEqualTypeOf<
  RhiCaps['externalTexture']
>();
