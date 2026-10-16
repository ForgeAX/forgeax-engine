import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 5.4 normal-mapping', () => import('../index.ts'));
