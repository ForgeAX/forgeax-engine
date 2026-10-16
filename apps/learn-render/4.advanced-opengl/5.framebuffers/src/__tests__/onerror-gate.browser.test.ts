import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 4.5 framebuffers', () => import('../index.ts'));
