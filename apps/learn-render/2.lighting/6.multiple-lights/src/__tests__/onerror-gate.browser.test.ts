import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 2.6 multiple-lights', () => import('../index.ts'));
