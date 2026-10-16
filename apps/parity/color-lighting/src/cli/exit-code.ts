import type { ColorLightingParityError } from '../errors';

export function exitCodeForError(error: ColorLightingParityError): number {
  switch (error.code) {
    case 'schema-invalid':
    case 'non-finite-value':
    case 'file-read-failed':
      return 64;
    case 'provenance-conflict':
    case 'aggregate-only-input':
    case 'metric-non-finite':
    case 'budget-exceeded':
      return 65;
    case 'unsupported-capability':
      return 69;
    case 'observation-evidence-missing':
      return 74;
    case 'primary-capture-missing':
    case 'capture-envelope-invalid':
      return 74;
    case 'status-incomplete':
      return 78;
  }
}
