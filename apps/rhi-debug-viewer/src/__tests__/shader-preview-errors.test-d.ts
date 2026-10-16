import type { PreviewErrorCode } from '../shader-preview/errors';

declare let code: PreviewErrorCode;
switch (code) {
  case 'preview-validation-failed':
  case 'preview-compile-failed':
  case 'preview-pipeline-incompatible':
  case 'preview-aborted':
  case 'preview-not-applicable':
    break;
  default: {
    const exhaustive: never = code;
    void exhaustive;
  }
}
