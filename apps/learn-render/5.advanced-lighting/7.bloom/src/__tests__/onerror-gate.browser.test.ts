import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 5.7 bloom', () => import('../index.ts'), 60_000);
