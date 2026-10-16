import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 1.4 textures', () => import('../index.ts'));
