import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 4.4 face-culling', () => import('../index.ts'));