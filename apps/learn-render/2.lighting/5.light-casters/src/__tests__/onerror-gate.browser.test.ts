import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 2.5 light-casters', () => import('../index.ts'));
