import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 4.1 depth-testing', () => import('../index.ts'));