import { it } from 'vitest';
import { verifyBufferCompatibility } from './buffer-compatibility.fixture';

it(
  'reads real GPU buffer results through the baseline native signature',
  verifyBufferCompatibility,
);
