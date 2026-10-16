import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 2.1 colors', () => import('../index.ts'));
