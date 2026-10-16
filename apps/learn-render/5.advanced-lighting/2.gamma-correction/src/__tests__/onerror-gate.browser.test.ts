import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 5.2 gamma-correction', () => import('../index.ts'));
