import { it } from 'vitest';
import { verifyOpticalInterface } from './optical-interface-gpu.fixture';

it(
  'evaluates refraction, plane hits, metric areas and concentration on the GPU',
  verifyOpticalInterface,
);
