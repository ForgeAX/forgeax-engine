import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// usage: node scripts/brep-ops-baseline.ts   (rewrites reports/brep-ops.json)
// Counts only: no wall time, no heap. Review the diff; a larger count is a regression unless the
// change is meant to trade work for something else. The kernel sources resolve extensionless
// imports, so the recording runs inside the unit test (FORGEAX_UPDATE_GOLDEN=1), the repo's golden path.
const root = fileURLToPath(new URL('..', import.meta.url));
const vitest = fileURLToPath(new URL('../../../node_modules/.bin/vitest', import.meta.url));
const run = spawnSync(
  vitest,
  ['run', 'src/brep/__tests__/brep-ops.unit.test.ts', '-t', 'records the baseline'],
  { cwd: root, stdio: 'inherit', env: { ...process.env, FORGEAX_UPDATE_GOLDEN: '1' } },
);
process.exit(run.status ?? 1);
