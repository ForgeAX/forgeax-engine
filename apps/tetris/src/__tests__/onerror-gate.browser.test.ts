import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('tetris', () => import('../main.ts'));
