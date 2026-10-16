import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 4.10 anti-aliasing-msaa', () => import('../index.ts'));