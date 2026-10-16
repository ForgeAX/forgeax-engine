import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 6.4 transmission-refraction', () => import('../index.ts'), 60_000);
