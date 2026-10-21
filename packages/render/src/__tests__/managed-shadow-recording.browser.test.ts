import { it } from 'vitest';
import { verifyManagedShadowRecording } from './managed-shadow-recording.gpu-fixture';

it(
  'records fixed material Passes and view selections with native validation',
  verifyManagedShadowRecording,
);
