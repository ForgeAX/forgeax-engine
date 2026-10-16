import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 5.8 deferred-shading', () => import('../main.ts'), 60_000);
