import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

// Split-sum IBL creates the renderer's cubemap/prefilter resources during its
// first real frame. Headed lavapipe runners can spend longer than the shared
// 30s gate budget while a neighboring browser process is releasing a device.
// Keep the same fail-closed assertion with a bounded cold-start budget. The
// 120s ceiling covers the heavy-runner headed-lavapipe cold start while still
// failing a genuinely stalled bootstrap in finite time. The split runner
// keeps this cold owner isolated, so the larger bound cannot hide a failure
// behind a shared browser process.
onerrorGate('learn-render 6.3 ibl-specular', () => import('../index.ts'), 120_000);
