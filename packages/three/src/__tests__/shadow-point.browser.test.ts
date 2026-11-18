import { it } from 'vitest';
import { verifyAuthoredShadow } from './shadow.fixture';

it(
  'projects the authored point shadow and filter',
  {
    timeout: 240000,
  },
  () =>
    verifyAuthoredShadow('point', {
      coreValidation: import.meta.env.FORGEAX_CI_CORE_VALIDATION === '1',
    }),
);
