import { afterAll } from 'vitest';
import budgets from '../scripts/ci/browser-work-budgets.json' with { type: 'json' };
import { checkBrowserWorkBudget, countBrowserWork } from '../scripts/test/browser-work.mjs';

const work = countBrowserWork();
// biome-ignore lint/correctness/noEmptyPattern: Vitest suite fixture arguments require destructuring.
afterAll(({}, suite) => {
  const file = 'filepath' in suite ? suite : suite.file;
  file.meta.browserWork = { ...work.counts };
  work.restore();
  checkBrowserWorkBudget(file.filepath, work.counts, budgets);
});
