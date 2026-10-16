import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

// IBL setup can cold-start Chrome Beta's lavapipe WebGPU device after the
// neighboring browser groups close. Keep the gate bounded while allowing the
// same isolated startup budget used by the other multi-pass PBR demos.
onerrorGate('learn-render 6.2 ibl-irradiance', () => import('../index.ts'), 60_000);
