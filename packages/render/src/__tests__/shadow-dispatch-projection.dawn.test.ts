import { it } from 'vitest';
import {
  verifyManagedShadowRecording,
  verifyMixedSkinPassRecording,
  verifyPagedShadowPose,
} from './managed-shadow-recording.gpu-fixture';

it(
  'records fixed material Passes and view selections into real depth',
  verifyManagedShadowRecording,
);

it(
  'records mixed Skin and rigid Shadow Passes in either order, including missing pose',
  verifyMixedSkinPassRecording,
);

it('culls and uploads moved casters from the same issued pose columns', verifyPagedShadowPose);
