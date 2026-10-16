import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 1.1 hello-window', () => import('../index.ts'));
