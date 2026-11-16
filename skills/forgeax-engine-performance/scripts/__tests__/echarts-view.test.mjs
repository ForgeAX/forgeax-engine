import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectMemoryTree } from '../echarts_memory.mjs';
import { metricChartData } from '../echarts_metric.mjs';
import { loadEchartsRuntime } from '../echarts_runtime.mjs';
import {
  buildMetricReport,
  metricReportRows,
  metricReportHtml,
  metricRowDetail,
} from '../render_metric_report.mjs';
import { memoryHtml } from '../memory_view.mjs';
import { allocationMemoryModel, inspectMemory } from '../memory_model.mjs';

function hierarchy() {
  const nodes = [];
  const visit = (id, depth) => {
    const node = {
      id,
      label: '<' + id + '>',
      selfBytes: 0,
      selfCount: 1,
      totalBytes: 0,
      totalCount: 1,
      children: [],
    };
    nodes.push(node);
    if (depth)
      for (let i = 0; i < 12; i++) {
        const child = visit(id + ':' + i, depth - 1);
        node.children.push(child.id);
        node.totalCount += child.totalCount;
      }
    return node;
  };
  visit('root', 3);
  return { nodes, rootId: 'root', countLabel: 'captured V8 nodes' };
}

test('ECharts projection conserves self and hidden sibling mass within a global node budget', () => {
  const model = hierarchy(),
    before = structuredClone(model);
  const tree = projectMemoryTree(model, 'root', {
    metric: 'count',
    depth: 8,
    limit: 5,
    maxNodes: 80,
  });
  let count = 0;
  const check = (node) => {
    count++;
    if (node.children) {
      assert.equal(
        node.children.reduce((sum, child) => sum + child.value, 0),
        node.value,
      );
      node.children.forEach(check);
    }
  };
  check(tree);
  assert(count <= 80);
  assert.equal(tree.value, model.nodes[0].totalCount);
  const other = tree.children.find((n) => n.aggregate);
  assert.equal(other.offset, 4);
  assert.equal(other.value, 8 * model.nodes[1].totalCount);
  assert.equal(projectMemoryTree(model, 'root', { metric: 'bytes' }).value, 0);
  assert.deepEqual(model, before);
  assert.throws(() => projectMemoryTree(model, 'root', { maxNodes: 2 }), /budget/);
});

test('ECharts bars retain duplicate source identities; filtered lines retain null gaps', () => {
  const report = buildMetricReport(
    [
      { name: 'same', value: 3, id: 'a' },
      { name: 'omit', value: 4 },
      { name: 'same', value: 8, id: 'c' },
      { name: 'same', value: null },
    ],
    { labelPointer: '/name', valuePointers: ['/value'], unit: 'count' },
  );
  const bar = metricChartData(report, metricReportRows(report, { sort: 'descending' }));
  assert.deepEqual(
    bar.series[0].data.map((p) => p.rowIndex),
    [2, 1, 0, 3],
  );
  assert.equal(metricRowDetail(report, bar.series[0].data[0].rowIndex).source.id, 'c');
  report.chart = 'line';
  const line = metricChartData(report, metricReportRows(report, { filter: 'same' }));
  assert.deepEqual(
    line.series[0].data.map((p) => p.value),
    [3, null, 8, null],
  );
  assert.equal(line.series[0].connectNulls, false);
});

test('offline ECharts HTML embeds explicit runtime and notices, while default SVG remains independent', async () => {
  await assert.rejects(() => loadEchartsRuntime(), /echarts-js/);
  const dir = await mkdtemp(join(tmpdir(), 'echarts-runtime-'));
  try {
    const file = join(dir, 'echarts.min.js');
    await writeFile(file, 'window.echarts={};');
    await writeFile(join(dir, 'LICENSE'), 'License <text>');
    await writeFile(join(dir, 'NOTICE'), 'Notice');
    const runtime = await loadEchartsRuntime(file);
    assert.equal(runtime.receipt.sha256.length, 64);
    const report = buildMetricReport([1, 2], { unit: 'count' });
    const html = metricReportHtml(report, { runtime });
    assert(html.includes('data:application/javascript;base64,'));
    assert(html.includes('License &lt;text>'));
    assert(html.includes(', mountMetricEcharts)'));
    assert(!metricReportHtml(report).includes('<script src='));
    const model = allocationMemoryModel({
      head: {
        id: 1,
        callFrame: {
          functionName: 'allocate',
          url: 'file:///fixture.mjs',
          lineNumber: 0,
          columnNumber: 0,
        },
        selfSize: 8,
        children: [],
      },
      samples: [],
    });
    const memory = memoryHtml(model, inspectMemory.toString(), undefined, { runtime });
    const payload = memory.match(/data-encoding="gzip-base64">([^<]+)</)[1];
    assert.equal(
      JSON.parse(gunzipSync(Buffer.from(payload, 'base64')).toString()).kind,
      'memory-explorer',
    );
    assert(
      memoryHtml(model, inspectMemory.toString(), undefined, { runtime }).includes(
        ', mountMemoryEcharts)',
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
