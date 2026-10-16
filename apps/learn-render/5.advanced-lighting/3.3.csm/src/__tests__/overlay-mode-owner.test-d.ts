import { expectTypeOf } from 'vitest';
import { csmOverlayModeForKey, type CsmOverlayMode } from '../cascade-overlay.js';
import type { CsmMvdProfile, CsmMvdVisualExpectation } from '../main.js';

type ExpectedMode = 'off' | 'all' | 'c1' | 'c2' | 'c3' | 'c4';

expectTypeOf<CsmOverlayMode>().toEqualTypeOf<ExpectedMode>();
expectTypeOf<'c5'>().not.toExtend<CsmOverlayMode>();
expectTypeOf(csmOverlayModeForKey).parameter(0).toEqualTypeOf<string>();
expectTypeOf(csmOverlayModeForKey).returns.toEqualTypeOf<CsmOverlayMode | null>();

expectTypeOf<CsmMvdProfile>().toEqualTypeOf<
  'off' | 'pcf3' | 'pcf5' | 'pcssMedium' | 'pcssHigh'
>();
expectTypeOf<CsmMvdVisualExpectation['binding']>().toEqualTypeOf<{
  readonly profile: CsmMvdProfile;
  readonly scene:
    | 'near'
    | 'far'
    | 'seam'
    | 'motion'
    | 'alpha'
    | 'transparent'
    | 'fallback';
  readonly backend: 'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null';
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
}>();
