import { it } from 'vitest';
import {
  verifyManagedShadowRecording,
  verifyMixedSkinPassRecording,
} from './managed-shadow-recording.gpu-fixture';

it(
  'records fixed material Passes and view selections into real depth',
  verifyManagedShadowRecording,
);

it(
  'records mixed Skin and rigid Shadow Passes in either order, including missing pose',
  verifyMixedSkinPassRecording,
);
