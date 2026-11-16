import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildMetricReport, metricReportHtml, metricReportSvg } from '../render_metric_report.mjs';

test('projects repeated nested selectors with null gaps and producer refusal intact', () => {
  const report = buildMetricReport(
    {
      comparable: false,
      rows: [
        { name: 'a', cost: { mean: 4, p95: 7 } },
        { name: 'b', cost: { mean: null, p95: 8 } },
      ],
    },
    {
      rowsPointer: '/rows',
      labelPointer: '/name',
      valuePointers: ['/cost/mean', '/cost/p95'],
      unit: 'ms',
    },
  );
  assert.deepEqual(
    report.points.map((p) => p.values),
    [
      [4, 7],
      [null, 8],
    ],
  );
  const svg = metricReportSvg(report);
  assert(svg.startsWith('<svg '));
  assert(svg.includes('NOT COMPARABLE'));
  assert(svg.includes('unavailable'));
});

test('raw arrays retain order and sign; missing line values break connections', () => {
  const report = buildMetricReport(
    { samples: [-2, null, 4] },
    { rowsPointer: '/samples', unit: 'ms', chart: 'line' },
  );
  assert.deepEqual(
    report.points.map((p) => p.values),
    [[-2], [null], [4]],
  );
  const svg = metricReportSvg(report);
  assert.equal((svg.match(/<circle /g) ?? []).length, 2);
  assert(!svg.includes('stroke-width="2"'));
  assert(svg.includes('spacing is not elapsed time'));
});

test('selects root summary fields without including count in same-unit timing chart', () => {
  const report = buildMetricReport(
    { baseline: { count: 20, p95: 4 }, candidate: { count: 20, p95: 3 } },
    {
      valuePointers: ['/baseline/p95', '/candidate/p95'],
      unit: 'ms',
    },
  );
  assert.deepEqual(report.points[0].values, [4, 3]);
  assert.throws(() =>
    buildMetricReport({ samples: ['4'] }, { rowsPointer: '/samples', unit: 'ms' }),
  );
  assert.throws(() => buildMetricReport([3], {}));
  assert.throws(() => buildMetricReport([], { unit: 'ms' }));
  assert.throws(() => buildMetricReport([{ a: 3 }], { unit: 'ms', valuePointers: ['/missing'] }));
});

test('escapes untrusted labels in SVG and embedded HTML data', () => {
  const report = buildMetricReport([{ name: '</script><script>unsafe()</script>', value: 2 }], {
    labelPointer: '/name',
    valuePointers: ['/value'],
    unit: 'bytes',
  });
  assert(!metricReportSvg(report).includes('<script>'));
  assert(!metricReportHtml(report).includes('</script><script>unsafe'));
});

test('CLI creates portable image, HTML and JSON with source digest and prevents overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'metric-report-'));
  try {
    const input = join(dir, 'input.json'),
      out = join(dir, 'view');
    await writeFile(input, JSON.stringify({ samples: [3, null, 5] }));
    const script = fileURLToPath(new URL('../render_metric_report.mjs', import.meta.url));
    const args = [script, input, '--rows-pointer', '/samples', '--unit', 'ms', '--out-dir', out];
    const child = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
    assert.match(result.input.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.points[1].values[0], null);
    for (const file of ['report.svg', 'report.html'])
      assert((await readFile(join(out, file))).length > 100);
    assert.equal(spawnSync(process.execPath, args).status, 1);
    assert.equal(spawnSync(process.execPath, [script, '--help']).status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
