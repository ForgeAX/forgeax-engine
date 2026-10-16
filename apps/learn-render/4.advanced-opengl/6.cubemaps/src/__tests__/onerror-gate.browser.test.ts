import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 4.6 cubemaps', () => import('../index.ts'));