import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 5.6 hdr', () => import('../index.ts'), 60_000);
