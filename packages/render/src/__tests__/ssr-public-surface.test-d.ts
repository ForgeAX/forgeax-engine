import { expectTypeOf } from 'vitest';
import {
  ScreenSpaceReflection,
  type ScreenSpaceReflectionData,
  type SsrSpatialInspection,
  type SsrSpatialUnavailableReason,
} from '../index';

expectTypeOf<ScreenSpaceReflectionData>().toEqualTypeOf<{
  readonly maxDistance: number;
  readonly thickness: number;
  readonly maxRoughness: number;
}>();
expectTypeOf(ScreenSpaceReflection).toHaveProperty('fields');
expectTypeOf<SsrSpatialUnavailableReason>().toEqualTypeOf<
  | 'lane-unsupported'
  | 'projection-unsupported'
  | 'scene-input-unavailable'
  | 'capability-unavailable'
  | 'format-unavailable'
  | 'temporal-unavailable'
  | 'reflection-fallback-unavailable'
  | 'recovery-unavailable'
>();
expectTypeOf<SsrSpatialInspection['status']>().toEqualTypeOf<
  'not-requested' | 'requested' | 'admitted' | 'fallback-only' | 'structural-only'
>();
expectTypeOf<SsrSpatialInspection['history']['state']>().toEqualTypeOf<
  'not-owned' | 'first-frame' | 'stable' | 'reset' | 'aborted' | 'retiring' | 'retired' | 'disposed'
>();

type PublicInspectionKeys = keyof SsrSpatialInspection;
type ForbiddenKey = Extract<
  PublicInspectionKeys,
  'device' | 'encoder' | 'queue' | 'target' | 'probeTable' | 'renderGraph'
>;
expectTypeOf<ForbiddenKey>().toEqualTypeOf<never>();
