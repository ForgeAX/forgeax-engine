import { it } from 'vitest';
import { verifyAuthoredShadow } from './shadow.fixture';

it(
  'projects the authored point shadow and filter',
  {
    timeout: 240000,
  },
  () => verifyAuthoredShadow('point'),
);
