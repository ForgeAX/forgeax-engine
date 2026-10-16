import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 2.3 materials', () => import('../index.ts'));
