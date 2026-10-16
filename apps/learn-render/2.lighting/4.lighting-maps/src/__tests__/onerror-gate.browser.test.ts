import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 2.4 lighting-maps', () => import('../index.ts'));
