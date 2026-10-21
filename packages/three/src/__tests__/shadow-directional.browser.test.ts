import { it } from 'vitest';
import { verifyAuthoredShadow } from './shadow.fixture';

it(
  'projects the authored directional shadow and filter',
  {
    timeout: 240000,
  },
  () => verifyAuthoredShadow('directional'),
);
