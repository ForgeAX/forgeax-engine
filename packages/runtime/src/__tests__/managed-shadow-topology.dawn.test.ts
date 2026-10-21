import { it } from 'vitest';
import {
  verifyManagedShadowCameraRetention,
  verifyManagedShadowTopology,
} from '../../../render/src/__tests__/managed-shadow-recording.gpu-fixture';

it(
  'excludes line and point primitives from native triangle shadow recording',
  verifyManagedShadowTopology,
  60_000,
);
it(
  'retains shadow pixels over 60 camera moves and redraws a newly accepted caster',
  verifyManagedShadowCameraRetention,
  60_000,
);
