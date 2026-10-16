import type {
  RenderError,
  RenderErrorCode,
  RenderFeatureCapabilityMissingError,
  RenderFeatureDrawRecordingFailedError,
  RenderFeaturePassOrderConflictError,
  RenderFeaturePreparationFailedError,
  RenderFeaturePreparedStateMismatchError,
  RenderFeatureRegistrationConflictError,
  RenderFeatureStageFailedError,
  VertexColorVariantConflictError,
} from '../errors/render';
import type { RenderFeatureErrorCode } from '../features/types';
import type { AutoExposureErrorCode } from '../pipeline/standard-output/auto-exposure/inspection';

function autoExposureCodeLabel(code: AutoExposureErrorCode): string {
  switch (code) {
    case 'auto-exposure-invalid-parameter':
      return code;
    case 'auto-exposure-capability-unavailable':
      return code;
    case 'auto-exposure-stale-generation':
      return code;
    case 'auto-exposure-stage-failed':
      return code;
  }
}

function renderFeatureCodeLabel(code: RenderFeatureErrorCode): string {
  switch (code) {
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
  }
}

function renderCodeLabel(code: RenderErrorCode): string {
  switch (code) {
    case 'render-feature-registration-conflict':
      return renderFeatureCodeLabel(code);
    case 'render-feature-stage-failed':
      return renderFeatureCodeLabel(code);
    case 'render-feature-capability-missing':
      return renderFeatureCodeLabel(code);
    case 'render-feature-pass-order-conflict':
      return renderFeatureCodeLabel(code);
    case 'vertex-color-variant-conflict':
      return code;
    case 'scene-data-unavailable':
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
    default:
      return code;
  }
}

function renderFeatureErrorLabel(error: RenderError): string {
  switch (error.code) {
    case 'render-feature-preparation-failed': {
      const typed: RenderFeaturePreparationFailedError = error;
      return `${typed.detail.featureIdentity}:${typed.detail.resourceName}`;
    }
    case 'render-feature-prepared-state-mismatch': {
      const typed: RenderFeaturePreparedStateMismatchError = error;
      return `${typed.detail.featureIdentity}:${typed.detail.reason}`;
    }
    case 'render-feature-draw-recording-failed': {
      const typed: RenderFeatureDrawRecordingFailedError = error;
      return `${typed.detail.featureIdentity}:${typed.detail.backendReason}`;
    }
    case 'render-feature-registration-conflict': {
      const typed: RenderFeatureRegistrationConflictError = error;
      return `${typed.detail.featureIdentity}:${typed.detail.conflictingOrder}`;
    }
    case 'render-feature-stage-failed': {
      const typed: RenderFeatureStageFailedError = error;
      return `${typed.detail.featureIdentity}:${typed.detail.stage}`;
    }
    case 'render-feature-capability-missing': {
      const typed: RenderFeatureCapabilityMissingError = error;
      return `${typed.detail.featureIdentity}:${typed.detail.capability}`;
    }
    case 'render-feature-pass-order-conflict': {
      const typed: RenderFeaturePassOrderConflictError = error;
      return `${typed.detail.featureIdentity}:${typed.detail.passIdentity}`;
    }
    case 'vertex-color-variant-conflict': {
      const typed: VertexColorVariantConflictError = error;
      return `${typed.detail.authoredValue}:${typed.detail.projected}`;
    }
    case 'points-lines-invalid-style':
    case 'points-lines-topology-mismatch':
    case 'points-lines-style-unsupported':
    case 'points-lines-material-unsupported':
    case 'points-lines-budget-exceeded':
    case 'points-lines-prepare-failed':
      return error.expected;
    default:
      return error.expected;
  }
}

const taaErrorCode: RenderErrorCode = 'taa-unavailable';
void taaErrorCode;
void renderCodeLabel;
void renderFeatureErrorLabel;
void autoExposureCodeLabel;
