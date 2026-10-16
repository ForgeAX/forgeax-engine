import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 1.3 shaders', () => import('../index.ts'));
