import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 5.3.3 csm', () => import('../main.ts'));
