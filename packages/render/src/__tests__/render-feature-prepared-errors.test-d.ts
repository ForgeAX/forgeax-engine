import type { RenderFeatureErrorDescriptor } from '../errors/render';
import type { RenderFeatureErrorCode } from '../features/types';
import type { PreparedKind, RenderFeatureRecovery } from '../features/vocabulary';

function describeGraphicsError(error: RenderFeatureErrorDescriptor): string {
  switch (error.code) {
    case 'render-feature-preparation-failed':
      return `${error.detail.operation}:${error.detail.resourceKind}:${error.detail.resourceName}`;
    case 'render-feature-prepared-state-mismatch':
      switch (error.detail.reason) {
        case 'missing-prepared-state':
          return error.detail.missingResource;
        case 'foreign-feature':
          return error.detail.actualFeatureIdentity;
        case 'foreign-kind':
          return `${error.detail.expectedKind}:${error.detail.actualKind}`;
        case 'generation-mismatch':
          return `${error.detail.expectedGeneration}:${error.detail.actualGeneration}`;
        case 'layout-mismatch':
          return `${error.detail.expectedLayout}:${error.detail.actualLayout}`;
        case 'format-mismatch':
          return `${error.detail.expectedFormat}:${error.detail.actualFormat}`;
      }
      return 'prepared-state-mismatch';
    case 'render-feature-draw-recording-failed':
      return `${error.detail.operation}:${error.detail.backendReason}`;
    case 'render-feature-registration-conflict':
      return error.detail.featureIdentity;
    case 'render-feature-stage-failed':
      return error.detail.featureIdentity;
    case 'render-feature-capability-missing':
      return error.detail.featureIdentity;
    case 'render-feature-pass-order-conflict':
      return error.detail.featureIdentity;
  }
}

function renderGraphicsCodeLabel(code: RenderFeatureErrorCode): string {
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

function describeRecovery(recovery: RenderFeatureRecovery): string {
  switch (recovery) {
    case 'next-frame':
      return recovery;
    case 'renderer-recover':
      return recovery;
    case 'registration':
      return recovery;
  }
}

const preparedKinds: readonly PreparedKind[] = [
  'pipeline',
  'bindings',
  'vertex-data',
  'index-data',
  'attachment',
];

void describeGraphicsError;
void renderGraphicsCodeLabel;
void describeRecovery;
void preparedKinds;
