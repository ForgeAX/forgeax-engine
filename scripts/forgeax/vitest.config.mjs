import { fileURLToPath } from 'node:url';

export default {
  root: fileURLToPath(new URL('../../', import.meta.url)),
  test: {
    environment: 'node',
    include: [
      'scripts/forgeax/__tests__/sdk-lib.test.mjs',
      'scripts/forgeax/__tests__/sdk-candidate.test.mjs',
    ],
    testTimeout: 30000,
  },
};
