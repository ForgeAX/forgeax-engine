import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 5.5 parallax-mapping', () => import('../index.ts'));
