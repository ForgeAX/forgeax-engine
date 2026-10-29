import { appendFileSync } from 'node:fs';
import { checkBrowserWorkBudget } from '../test/browser-work.mjs';
import budgets from './browser-work-budgets.json' with { type: 'json' };

export function readBrowserCosts(output, files) {
  const rows = output
    .split('\n')
    .filter((line) => line.startsWith('[browser-cost] '))
    .map((line) => JSON.parse(line.slice('[browser-cost] '.length)));
  const seen = new Set();
  for (const row of rows) {
    if (!files.includes(row.file) || seen.has(row.file))
      throw new Error(`Unexpected or duplicate Browser cost observation: ${row.file}`);
    seen.add(row.file);
    if (
      !['passed', 'skipped'].includes(row.state) ||
      !Array.isArray(row.cases) ||
      !Number.isFinite(row.diagnostic?.duration) ||
      row.diagnostic.duration < 0
    )
      throw new Error(`Incomplete Browser cost observation: ${row.file}`);
    if (
      row.work !== null &&
      (row.work?.realm !== 'browser-main' ||
        typeof row.work.available !== 'boolean' ||
        ['deviceRequests', 'shaderModules', 'pipelines', 'readbackMaps', 'submissions'].some(
          (counter) => !Number.isSafeInteger(row.work[counter]) || row.work[counter] < 0,
        ))
    )
      throw new Error(`Incomplete Browser work observation: ${row.file}`);
    for (const test of row.cases)
      if (
        typeof test.name !== 'string' ||
        !['passed', 'skipped'].includes(test.state) ||
        !Number.isFinite(test.durationMs) ||
        test.durationMs < 0
      )
        throw new Error(`Incomplete Browser case observation: ${row.file}`);
    checkBrowserWorkBudget(
      row.file,
      row.work,
      budgets,
      row.cases.filter((test) => test.state === 'passed').length,
    );
  }
  for (const file of files)
    if (!seen.has(file)) throw new Error(`Missing Browser cost observation: ${file}`);
  return rows;
}

export function summarizeBrowserCosts(
  groups,
  { shard, complete, summary = process.env.GITHUB_STEP_SUMMARY } = {},
) {
  const rows = groups
    .flatMap((group) => group.files)
    .sort((a, b) => b.diagnostic.duration - a.diagnostic.duration);
  const processSeconds = groups.reduce((sum, group) => sum + group.elapsedMs / 1000, 0);
  const fileSeconds = rows.reduce((sum, row) => sum + row.diagnostic.duration / 1000, 0);
  const report = [
    `## Browser test cost — shard ${shard}`,
    '',
    `Complete: ${complete}. Observed ${rows.length} files in ${groups.length} children.`,
    `Child execution: ${processSeconds.toFixed(1)}s; file tests/hooks: ${fileSeconds.toFixed(1)}s; positive startup/cleanup remainder: ${Math.max(0, processSeconds - fileSeconds).toFixed(1)}s.`,
    'Child times are cumulative across the existing concurrent slots. GPU counters cover the browser main realm; Worker and external Playwright devices are not included. Queue time is not test execution.',
    '',
    '| File | Tests/hooks (s) | Collect/setup (s) | Passed/skipped | Devices | Pipelines | Readback maps |',
    '| :-- | --: | --: | :-- | --: | --: | --: |',
    ...browserCostRows(rows),
    '',
  ].join('\n');
  if (summary) appendFileSync(summary, report);
  process.stdout.write(
    `[browser-cost-summary] ${JSON.stringify({ shard, complete, files: rows.length, children: groups.length, processSeconds, fileSeconds })}\n`,
  );
  return report;
}

export function browserCostRows(rows) {
  return rows.map((row) => {
    const passed = row.cases.filter((test) => test.state === 'passed').length;
    const skipped = row.cases.filter((test) => test.state === 'skipped').length;
    const preparation = (row.diagnostic.collectDuration ?? 0) + (row.diagnostic.setupDuration ?? 0);
    const work = row.work;
    return `| ${row.file} | ${(row.diagnostic.duration / 1000).toFixed(2)} | ${(preparation / 1000).toFixed(2)} | ${passed}/${skipped} | ${work?.deviceRequests ?? 'unobserved'} | ${work?.pipelines ?? 'unobserved'} | ${work?.readbackMaps ?? 'unobserved'} |`;
  });
}
