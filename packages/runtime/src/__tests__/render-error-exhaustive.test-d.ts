// feat-20260704-runtime-tier1-decomposition M2 / w13 (AC-07 c): render cluster
// exhaustive type-level regression guard. Split out of the former
// hdrp-error-exhaustive.test-d.ts, which exhaustively switched the whole
// runtime-layer code union; after the D-3 decomposition each cluster owns its own
// exhaustive assertion.
//
// If any RenderErrorCode member is missing from the switch below, the
// `const exhaustive: never = code` line stops compiling (tsc red). A `default`
// arm would defeat the exhaustiveness check, so there is none.
//
// This file is *.test-d.ts: vitest typecheck validates it; it is not executed.

import type { RenderError, RenderErrorCode } from '@forgeax/engine-render';

function exhaustiveSwitchOnRenderCode(code: RenderErrorCode): string {
  switch (code) {
    case 'projected-decal-invalid':
      return code;
    case 'render-publication-invalid':
      return code;
    case 'auto-exposure-invalid-parameter':
      return code;
    case 'auto-exposure-capability-unavailable':
      return code;
    case 'auto-exposure-stale-generation':
      return code;
    case 'auto-exposure-stage-failed':
      return code;
    case 'motion-blur-invalid-params':
      return code;
    case 'lifecycle-construction-failed':
      return code;
    case 'world-lease-invalid':
      return code;
    case 'frame-input-invalid':
      return code;
    case 'scene-projection-failed':
      return code;
    case 'asset-binding-failed':
      return code;
    case 'feature-plan-failed':
      return code;
    case 'graph-build-failed':
      return code;
    case 'frame-submit-rejected':
    case 'device-operation-failed':
      return code;
    case 'surface-unavailable':
      return code;
    case 'renderer-state-invalid':
      return code;
    case 'recovery-failed':
      return code;
    case 'cleanup-failed':
      return code;
    case 'taa-unavailable':
      return code;
    case 'standard-profile-invalid':
      return code;
    case 'frame-receipt-stale':
      return code;
    case 'renderer-contract-failed':
      return code;
    case 'observation-unavailable':
      return code;
    case 'scene-data-unavailable':
      return code;
    case 'scene-sdf-unavailable':
      return code;
    case 'shadow-invalid-config':
      return code;
    case 'environment-source-conflict':
      return code;
    case 'fog-cardinality':
      return code;
    case 'sun-cardinality':
      return code;
    case 'taa-caps-insufficient':
      return code;
    case 'dynamic-resolution-invalid-parameter':
      return code;
    case 'dynamic-resolution-requires-taa':
      return code;
    case 'dynamic-resolution-timing-unavailable':
      return code;
    case 'environment-generation-failed':
      return code;
    case 'cloud-layer-invalid-parameter':
      return code;
    case 'cloud-layer-owner-conflict':
      return code;
    case 'cloud-layer-cache-invalid':
      return code;
    case 'cloud-layer-capability-missing':
      return code;
    case 'cloud-layer-resource-failed':
      return code;
    case 'external-texture-invalid':
      return code;
    case 'external-texture-state-invalid':
      return code;
    case 'atmosphere-invalid-parameter':
      return code;
    case 'lens-effects-invalid-parameter':
    case 'lens-flare-invalid-parameter':
    case 'barrel-distortion-invalid-parameter':
    case 'outline-invalid-parameter':
      return code;
    case 'owner-stage-failed':
      return code;
    case 'equirect-projection-failed':
      return code;
    case 'standard-light-budget-exceeded':
      return code;
    case 'standard-cluster-index-overflow':
      return code;
    case 'standard-cluster-transport-unavailable':
      return code;
    case 'render-target-descriptor-invalid':
      return code;
    case 'render-target-capability-missing':
      return code;
    case 'render-target-state-invalid':
      return code;
    case 'render-target-layer-invalid':
      return code;
    case 'framebuffer-snapshot-failed':
      return code;
    case 'render-target-operation-failed':
      return code;
    case 'reflection-probe-budget-exceeded':
      return code;
    case 'planar-reflection-invalid':
      return code;
    case 'render-intent-invalid':
      return code;
    case 'point-shadow-atlas-uninitialized':
      return code;
    case 'point-shadow-atlas-bounds-violation':
      return code;
    case 'video-upload-unsupported':
      return code;
    case 'vertex-storage-buffer-unavailable':
      return code;
    case 'vertex-color-variant-conflict':
      return code;
    case 'skin-palette-overflow':
      return code;
    case 'skin-material-mismatch':
      return code;
    case 'material-skin-attr-missing':
      return code;
    case 'render-feature-registration-conflict':
      return code;
    case 'render-feature-stage-failed':
      return code;
    case 'render-feature-capability-missing':
      return code;
    case 'render-feature-pass-order-conflict':
      return code;
    case 'render-feature-preparation-failed':
      return code;
    case 'render-feature-prepared-state-mismatch':
      return code;
    case 'render-feature-draw-recording-failed':
      return code;
    case 'transmission-capability-missing':
      return code;
    case 'material-sampled-texture-budget-exceeded':
      return code;
    case 'points-lines-invalid-style':
      return code;
    case 'points-lines-topology-mismatch':
      return code;
    case 'points-lines-style-unsupported':
      return code;
    case 'points-lines-material-unsupported':
      return code;
    case 'points-lines-budget-exceeded':
      return code;
    case 'points-lines-prepare-failed':
      return code;
    case 'light-resource-unavailable':
    case 'projector-binding-failed':
      return code;
    case 'volume-owner-conflict':
      return code;
    case 'volume-density-shape-mismatch':
      return code;
    case 'volume-invalid-bounds':
      return code;
    case 'volume-invalid-parameters':
      return code;
    case 'camera-view-invalid':
      return code;
    case 'stereo-camera-invalid':
      return code;
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

function narrowRenderError(err: RenderError): void {
  switch (err.code) {
    case 'projected-decal-invalid':
      void err.detail.field;
      void err.expected;
      break;
    case 'render-publication-invalid':
      void err.detail.reason;
      void err.detail.subject;
      break;
    case 'auto-exposure-invalid-parameter':
      void err.detail.field;
      void err.detail.value;
      break;
    case 'auto-exposure-capability-unavailable':
      void err.detail.capability;
      void err.detail.generation;
      break;
    case 'auto-exposure-stale-generation':
      void err.detail.expectedGeneration;
      void err.detail.actualGeneration;
      break;
    case 'auto-exposure-stage-failed':
      void err.detail.stage;
      void err.detail.operation;
      break;
    case 'motion-blur-invalid-params':
      void err.detail.field;
      void err.detail.value;
      void err.detail.min;
      void err.detail.max;
      void err.detail.integer;
      break;
    case 'lifecycle-construction-failed':
      void err.detail.owner;
      void err.detail.generation;
      void err.detail.receipt;
      break;
    case 'world-lease-invalid':
      void err.detail.operation;
      void err.detail.cause;
      break;
    case 'frame-input-invalid':
      void err.detail.operation;
      void err.detail.cause;
      break;
    case 'scene-projection-failed':
      void err.detail.operation;
      void err.detail.cause;
      break;
    case 'asset-binding-failed':
      void err.detail.operation;
      void err.detail.cause;
      break;
    case 'feature-plan-failed':
      void err.detail.operation;
      void err.detail.cause;
      break;
    case 'graph-build-failed':
      void err.detail.operation;
      void err.detail.cause;
      break;
    case 'frame-submit-rejected':
      void err.detail.operation;
      void err.detail.stage;
      void err.detail.accepted;
      break;
    case 'device-operation-failed':
      void err.detail.operation;
      void err.detail.frameId;
      void err.detail.deviceGeneration;
      void err.detail.cause;
      break;
    case 'surface-unavailable':
      void err.detail.operation;
      void err.detail.cause;
      break;
    case 'renderer-state-invalid':
      void err.detail.operation;
      void err.detail.state;
      void err.detail.cause;
      break;
    case 'recovery-failed':
      void err.detail.operation;
      void err.detail.oldGeneration;
      void err.detail.candidateGeneration;
      void err.detail.cause;
      break;
    case 'cleanup-failed':
      void err.detail.operation;
      void err.detail.causes;
      break;
    case 'standard-profile-invalid':
      void err.detail.field;
      void err.detail.actual;
      break;
    case 'frame-receipt-stale':
      void err.detail.frameId;
      void err.detail.receiptGeneration;
      void err.detail.currentGeneration;
      break;
    case 'renderer-contract-failed':
      void err.detail.operation;
      void err.detail.cause;
      break;
    case 'observation-unavailable':
      void err.detail.reason;
      void err.detail.recovery;
      break;
    case 'scene-data-unavailable':
      void err.detail.featureIdentity;
      void err.detail.schema;
      void err.detail.lane;
      void err.detail.reason;
      void err.detail.missingContributorIds;
      void err.detail.omittedMissingContributorCount;
      void err.detail.recovery;
      break;
    case 'scene-sdf-unavailable':
      void err.detail.reason;
      void err.detail.world;
      void err.detail.entity;
      void err.detail.cause;
      break;
    case 'shadow-invalid-config':
      void err.detail.field; // string
      void err.detail.actual; // number
      void err.detail.bound;
      void err.detail.reason; // string
      break;
    case 'environment-source-conflict':
      void err.detail.owners;
      break;
    case 'fog-cardinality':
      void err.detail.count;
      break;
    case 'taa-caps-insufficient':
      void err.detail.required;
      void err.detail.available;
      break;
    case 'dynamic-resolution-invalid-parameter':
      void err.detail.field;
      void err.detail.value;
      void err.detail.expected;
      break;
    case 'dynamic-resolution-requires-taa':
      void err.detail.antialias;
      break;
    case 'dynamic-resolution-timing-unavailable':
      void err.detail.generation;
      void err.detail.operation;
      break;
    case 'environment-generation-failed':
      void err.detail.sourceKey;
      void err.detail.stage;
      break;
    case 'atmosphere-invalid-parameter':
      void err.detail.field;
      void err.detail.value;
      break;
    case 'owner-stage-failed':
      void err.detail.owner;
      void err.detail.stage;
      break;
    case 'equirect-projection-failed':
      void err.detail.handle; // number
      break;
    case 'standard-light-budget-exceeded':
      void err.detail.actual; // number
      void err.detail.budget; // number
      break;
    case 'standard-cluster-index-overflow':
      void err.detail.actual; // number
      void err.detail.capacity; // number
      break;
    case 'standard-cluster-transport-unavailable':
      void err.detail.requested; // number
      void err.detail.admitted; // 0
      break;
    case 'render-target-descriptor-invalid':
      void err.detail.field;
      void err.detail.value;
      void err.detail.expected;
      break;
    case 'render-target-capability-missing':
      void err.detail.operation;
      void err.detail.requested;
      void err.detail.capability;
      void err.detail.actual;
      break;
    case 'render-target-state-invalid':
      void err.detail.operation;
      void err.detail.reason;
      void err.detail.state;
      void err.detail.generation;
      break;
    case 'render-target-layer-invalid':
      void err.detail.operation;
      void err.detail.layer;
      void err.detail.shape;
      void err.detail.layerCount;
      break;
    case 'framebuffer-snapshot-failed':
      void err.detail.reason;
      void err.detail.expected;
      void err.detail.actual;
      void err.detail.frameId;
      break;
    case 'render-target-operation-failed':
      void err.detail.operation;
      void err.detail.stage;
      void err.detail.generation;
      void err.detail.cause;
      void err.detail.recovery;
      break;
    case 'reflection-probe-budget-exceeded':
      void err.detail.actual;
      void err.detail.budget;
      break;
    case 'planar-reflection-invalid':
      void err.detail.field;
      break;
    case 'render-intent-invalid':
      void err.detail.component;
      void err.detail.field;
      void err.detail.value;
      void err.detail.allowed;
      break;
    case 'point-shadow-atlas-uninitialized':
      // No detail on this class.
      break;
    case 'point-shadow-atlas-bounds-violation':
      void err.detail.axis; // 'layer' | 'face'
      void err.detail.value; // number
      void err.detail.max; // number
      break;
    case 'video-upload-unsupported':
      // No detail on this class.
      break;
    case 'vertex-storage-buffer-unavailable':
      // No detail on this class.
      break;
    case 'skin-palette-overflow':
      void err.detail.requestedBytes;
      void err.detail.limit;
      break;
    case 'skin-material-mismatch':
      void err.detail.entity;
      void err.detail.actualShader;
      break;
    case 'material-skin-attr-missing':
      void err.detail.entity;
      void err.detail.missing;
      break;
    case 'render-feature-registration-conflict':
      void err.detail.featureIdentity;
      void err.detail.conflictingOrder;
      break;
    case 'render-feature-stage-failed':
      void err.detail.featureIdentity;
      void err.detail.stage;
      break;
    case 'render-feature-capability-missing':
      void err.detail.featureIdentity;
      void err.detail.capability;
      break;
    case 'render-feature-pass-order-conflict':
      void err.detail.featureIdentity;
      void err.detail.passIdentity;
      break;
    case 'render-feature-preparation-failed':
      void err.detail.featureIdentity;
      void err.detail.resourceName;
      void err.detail.operation;
      break;
    case 'render-feature-prepared-state-mismatch':
      void err.detail.featureIdentity;
      void err.detail.reason;
      void err.detail.operation;
      break;
    case 'render-feature-draw-recording-failed':
      void err.detail.featureIdentity;
      void err.detail.backendReason;
      void err.detail.operation;
      break;
    case 'taa-unavailable':
      void err.detail.reason;
      break;
    case 'vertex-color-variant-conflict':
      void err.detail.authored;
      void err.detail.authoredValue;
      void err.detail.projected;
      break;
    case 'points-lines-invalid-style':
      void err.detail.component;
      void err.detail.field;
      break;
    case 'points-lines-topology-mismatch':
      void err.detail.submesh;
      void err.detail.actual;
      break;
    case 'points-lines-style-unsupported':
      void err.detail.member;
      void err.detail.supported;
      break;
    case 'points-lines-material-unsupported':
      void err.detail.material;
      void err.detail.pass;
      break;
    case 'points-lines-budget-exceeded':
      void err.detail.requested;
      void err.detail.limit;
      break;
    case 'points-lines-prepare-failed':
      void err.detail.owner;
      void err.detail.generation;
      break;
    case 'light-resource-unavailable':
      void err.detail.entity;
      void err.detail.feature;
      void err.detail.generation;
      void err.detail.sourceKey;
      void err.detail.reason;
      void err.expected;
      void err.hint;
      break;
    case 'transmission-capability-missing':
      void err.detail.material;
      void err.detail.capability;
      void err.detail.stage;
      break;
    case 'material-sampled-texture-budget-exceeded':
      void err.detail.materialHandle;
      void err.detail.limit;
      void err.detail.required;
      void err.detail.conflicts;
      break;
    case 'projector-binding-failed':
      void err.detail.guid;
      void err.detail.status;
      break;
    case 'volume-owner-conflict':
      void err.detail.ownerCount;
      break;
    case 'volume-density-shape-mismatch':
      void err.detail.guid;
      void err.detail.viewDimension;
      break;
    case 'volume-invalid-bounds':
      void err.detail.min;
      void err.detail.max;
      break;
    case 'volume-invalid-parameters':
      void err.detail.field;
      void err.detail.value;
      break;
    case 'cloud-layer-invalid-parameter':
      void err.detail.field;
      void err.detail.value;
      void err.detail.expected;
      break;
    case 'cloud-layer-owner-conflict':
      void err.detail.count;
      break;
    case 'cloud-layer-cache-invalid':
      void err.detail.sourceKey;
      void err.detail.reason;
      break;
    case 'cloud-layer-capability-missing':
      void err.detail.capability;
      break;
    case 'cloud-layer-resource-failed':
      void err.detail.stage;
      void err.detail.generation;
      void err.detail.cause;
      break;
    case 'external-texture-invalid':
      void err.detail.operation;
      void err.detail.reason;
      break;
    case 'external-texture-state-invalid':
      void err.detail.reason;
      void err.detail.generation;
      break;
    case 'lens-effects-invalid-parameter':
    case 'lens-flare-invalid-parameter':
      void err.detail.field;
      void err.detail.value;
      void err.detail.minimum;
      void err.detail.maximum;
      break;
    case 'barrel-distortion-invalid-parameter':
      void err.detail.field;
      void err.detail.value;
      void err.detail.expected;
      break;
    case 'outline-invalid-parameter':
      void err.detail.field;
      void err.detail.value;
      void err.expected;
      break;
    case 'sun-cardinality':
      void err.detail.field;
      void err.detail.value;
      break;
    case 'camera-view-invalid':
      void err.detail.field;
      void err.detail.value;
      break;
    case 'stereo-camera-invalid':
      void err.detail.field;
      void err.detail.value;
      break;
    default: {
      const exhaustive: never = err;
      void exhaustive;
    }
  }
}

export type _RenderExhaustiveChecks = {
  /** @internal forces tsc to type-check the exhaustive switch on RenderErrorCode. */
  _check: ReturnType<typeof exhaustiveSwitchOnRenderCode>;
  /** @internal forces tsc to type-check the RenderError detail narrowing. */
  _narrow: typeof narrowRenderError;
};
