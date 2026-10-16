import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('hello-room', () => import('../index.ts'));
