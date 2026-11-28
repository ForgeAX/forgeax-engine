import { it } from 'vitest';
import { verifyOpticalInterface } from './optical-interface-gpu.fixture';

it(
  'evaluates optical primitive statuses and physical areas in the browser GPU',
  verifyOpticalInterface,
);
