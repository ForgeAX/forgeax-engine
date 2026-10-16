import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 4.2 stencil-testing', () => import('../index.ts'));