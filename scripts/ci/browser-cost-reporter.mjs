import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserCostRows } from './browser-cost-report.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** Actual Vitest observations; no second browser, sampling pass or timing baseline. */
export default class BrowserCostReporter {
  rows = [];
  onTestModuleEnd(module) {
    const tests = [...module.children.allTests()];
    const { importDurations: _imports, ...diagnostic } = module.diagnostic();
    const observation = {
      file: relative(root, module.moduleId).replaceAll('\\', '/'),
      state: module.state(),
      diagnostic,
      cases: tests.map((test) => ({
        name: test.fullName,
        state: test.result().state,
        durationMs: test.diagnostic()?.duration ?? 0,
      })),
      work: module.meta().browserWork ?? null,
    };
    this.rows.push(observation);
    process.stdout.write(`[browser-cost] ${JSON.stringify(observation)}\n`);
  }
  onTestRunEnd(_modules, errors, reason) {
    if (process.env.FORGEAX_BROWSER_COST_COORDINATOR === '1' || !process.env.GITHUB_STEP_SUMMARY)
      return;
    const rows = [...this.rows].sort((a, b) => b.diagnostic.duration - a.diagnostic.duration);
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        '## Runtime browser file costs',
        '',
        `Complete: ${reason === 'passed' && errors.length === 0}. External Playwright GPU work is not counted.`,
        '',
        '| File | Tests/hooks (s) | Collect/setup (s) | Passed/skipped | Devices | Pipelines | Readback maps |',
        '| :-- | --: | --: | :-- | --: | --: | --: |',
        ...browserCostRows(rows),
        '',
      ].join('\n'),
    );
  }
}
