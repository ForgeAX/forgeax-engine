import { describe, expectTypeOf, it } from 'vitest';
import type {
  ObservationUnavailableDetail,
  ObservationUnavailableReason,
  RenderError,
  RenderErrorCode,
} from '../errors/render';
import { ObservationUnavailableError, RenderFeatureStageFailedError } from '../errors/render';
import type { RenderFeatureErrorCode, RenderFeatureStageFailedDetail } from '../features/types';
import type { RenderFeatureRecovery, RenderFeatureStage } from '../features/vocabulary';
import type {
  RenderError as PublicRenderError,
  RenderErrorCode as PublicRenderErrorCode,
} from '../index';

const expectedCodes = [
  'camera-view-invalid',
  'stereo-camera-invalid',
  'projected-decal-invalid',
  'planar-reflection-invalid',
  'render-publication-invalid',
  'auto-exposure-invalid-parameter',
  'auto-exposure-capability-unavailable',
  'auto-exposure-stale-generation',
  'auto-exposure-stage-failed',
  'lifecycle-construction-failed',
  'world-lease-invalid',
  'frame-input-invalid',
  'scene-projection-failed',
  'asset-binding-failed',
  'feature-plan-failed',
  'graph-build-failed',
  'device-operation-failed',
  'surface-unavailable',
  'renderer-state-invalid',
  'recovery-failed',
  'cleanup-failed',
  'frame-receipt-stale',
  'frame-submit-rejected',
  'renderer-contract-failed',
  'observation-unavailable',
  'scene-data-unavailable',
  'scene-sdf-unavailable',
  'taa-unavailable',
  'dynamic-resolution-invalid-parameter',
  'dynamic-resolution-requires-taa',
  'dynamic-resolution-timing-unavailable',
  'barrel-distortion-invalid-parameter',
  'lens-effects-invalid-parameter',
  'lens-flare-invalid-parameter',
  'outline-invalid-parameter',
  'motion-blur-invalid-params',

  'shadow-invalid-config',
  'equirect-projection-failed',
  'standard-light-budget-exceeded',
  'standard-cluster-index-overflow',
  'standard-cluster-transport-unavailable',
  'standard-profile-invalid',
  'point-shadow-atlas-uninitialized',
  'point-shadow-atlas-bounds-violation',
  'video-upload-unsupported',
  'vertex-storage-buffer-unavailable',
  'vertex-color-variant-conflict',
  'skin-palette-overflow',
  'skin-material-mismatch',
  'material-skin-attr-missing',
  'transmission-capability-missing',
  'material-sampled-texture-budget-exceeded',
  'render-feature-registration-conflict',
  'render-feature-stage-failed',
  'render-feature-capability-missing',
  'render-feature-pass-order-conflict',
  'render-feature-preparation-failed',
  'render-feature-prepared-state-mismatch',
  'render-feature-draw-recording-failed',
  'environment-source-conflict',
  'fog-cardinality',
  'sun-cardinality',
  'taa-caps-insufficient',
  'environment-generation-failed',
  'atmosphere-invalid-parameter',
  'owner-stage-failed',
  'points-lines-invalid-style',
  'points-lines-topology-mismatch',
  'points-lines-style-unsupported',
  'points-lines-material-unsupported',
  'points-lines-budget-exceeded',
  'points-lines-prepare-failed',
  'light-resource-unavailable',
  'render-target-descriptor-invalid',
  'render-target-capability-missing',
  'render-target-layer-invalid',
  'render-target-state-invalid',
  'render-target-operation-failed',
  'framebuffer-snapshot-failed',
  'reflection-probe-budget-exceeded',
  'render-intent-invalid',
  'volume-owner-conflict',
  'volume-density-shape-mismatch',
  'volume-invalid-bounds',
  'volume-invalid-parameters',
  'projector-binding-failed',
  'cloud-layer-invalid-parameter',
  'cloud-layer-owner-conflict',
  'cloud-layer-cache-invalid',
  'cloud-layer-capability-missing',
  'cloud-layer-resource-failed',
  'external-texture-invalid',
  'external-texture-state-invalid',
] as const satisfies readonly RenderErrorCode[];
type ExpectedCodeUnion = (typeof expectedCodes)[number];

const expectedFeatureCodes = [
  'render-feature-registration-conflict',
  'render-feature-stage-failed',
  'render-feature-capability-missing',
  'render-feature-pass-order-conflict',
  'render-feature-preparation-failed',
  'render-feature-prepared-state-mismatch',
  'render-feature-draw-recording-failed',
] as const satisfies readonly RenderFeatureErrorCode[];
type ExpectedFeatureCodeUnion = (typeof expectedFeatureCodes)[number];

describe('RenderError code owner', () => {
  it('derives the exact code union from RenderError and preserves projections', () => {
    expectTypeOf<RenderErrorCode>().toEqualTypeOf<ExpectedCodeUnion>();
    expectTypeOf<ExpectedCodeUnion>().toEqualTypeOf<RenderErrorCode>();
    expectTypeOf<RenderErrorCode>().toEqualTypeOf<RenderError['code']>();
    expectTypeOf<RenderError['code']>().toEqualTypeOf<RenderErrorCode>();
    expectTypeOf<PublicRenderErrorCode>().toEqualTypeOf<RenderErrorCode>();
    expectTypeOf<RenderErrorCode>().toEqualTypeOf<PublicRenderErrorCode>();
    expectTypeOf<PublicRenderError>().toEqualTypeOf<RenderError>();
    expectTypeOf<RenderFeatureErrorCode>().toEqualTypeOf<ExpectedFeatureCodeUnion>();
    expectTypeOf<ExpectedFeatureCodeUnion>().toEqualTypeOf<RenderFeatureErrorCode>();

    const acceptsCode = (code: RenderErrorCode): RenderErrorCode => code;
    acceptsCode(expectedCodes[0]);
    // @ts-expect-error unknown codes remain outside the closed RenderErrorCode union.
    acceptsCode('render-error-code-not-real');
    // @ts-expect-error unknown codes cannot be assigned to the public alias either.
    const unknownCode: PublicRenderErrorCode = 'render-error-code-not-real';
    void unknownCode;
  });

  it('keeps retired HDRP error namespaces out of every public code union', () => {
    type RetiredRenderCode = Extract<RenderErrorCode, `hdrp-${string}`>;
    expectTypeOf<RetiredRenderCode>().toEqualTypeOf<never>();
  });

  it('preserves correlated detail and value declarations', () => {
    type ObservationError = Extract<RenderError, { readonly code: 'observation-unavailable' }>;
    expectTypeOf<ObservationError['detail']>().toEqualTypeOf<ObservationUnavailableDetail>();
    expectTypeOf<
      ObservationError['detail']['reason']
    >().toEqualTypeOf<ObservationUnavailableReason>();
    expectTypeOf<ObservationError['detail']['recovery']>().toEqualTypeOf<
      ObservationUnavailableDetail['recovery']
    >();

    const observation = new ObservationUnavailableError('stale', 'draw a current frame');
    expectTypeOf(observation).toEqualTypeOf<ObservationError>();
    expectTypeOf(observation.code).toEqualTypeOf<'observation-unavailable'>();
    expectTypeOf(observation.detail.reason).toEqualTypeOf<ObservationUnavailableReason>();

    type StageFailedError = Extract<RenderError, { readonly code: 'render-feature-stage-failed' }>;
    expectTypeOf<StageFailedError['detail']>().toEqualTypeOf<RenderFeatureStageFailedDetail>();

    const stageFailed = new RenderFeatureStageFailedError('test.feature', 0, 'plan', 'next-frame');
    expectTypeOf(stageFailed).toEqualTypeOf<StageFailedError>();
    expectTypeOf(stageFailed.detail.stage).toEqualTypeOf<RenderFeatureStage>();
    expectTypeOf(stageFailed.detail.recovery).toEqualTypeOf<RenderFeatureRecovery>();
  });
});
