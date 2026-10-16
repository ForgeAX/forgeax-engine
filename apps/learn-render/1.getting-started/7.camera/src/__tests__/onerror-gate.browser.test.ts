import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 1.7 camera', () => import('../index.ts'));
