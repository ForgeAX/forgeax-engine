import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

// Cube-face reflection setup can cross the ordinary software-carrier gate
// while a large headed browser group is releasing its preceding device. Keep
// the renderer-error assertion fail-closed with a bounded 60s budget.
onerrorGate('learn-render 6.4 render-target-reflection', () => import('../index.ts'), 60_000);
