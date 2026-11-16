import { zoomPlotBox } from '../plot_interaction.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memorySvg } from '../memory_view.mjs';
import { allocationMemoryModel } from '../memory_model.mjs';
import {
  buildMetricReport,
  metricReportRows,
  metricRowDetail,
  metricReportSvg,
} from '../render_metric_report.mjs';

test('folder graphics expose the same node identities as their table for drilldown', () => {
  const model = allocationMemoryModel({
    head: {
      id: 1,
      callFrame: {
        functionName: 'root',
        url: 'file:///fixture.mjs',
        lineNumber: 0,
        columnNumber: 0,
      },
      selfSize: 0,
      children: [
        {
          id: 2,
          callFrame: {
            functionName: 'allocate',
            url: 'file:///fixture.mjs',
            lineNumber: 0,
            columnNumber: 0,
          },
          selfSize: 8,
          children: [],
        },
      ],
    },
    samples: [{ nodeId: 2, size: 8 }],
  });
  assert.match(memorySvg(model), /data-memory-node="allocation:2"/);
  assert.match(memorySvg(model), /tabindex="0"/);
});

test('metric bars and line samples preserve original row identities for linked selection', () => {
  const report = buildMetricReport(
    [
      { name: 'same', value: 3 },
      { name: 'other', value: null },
      { name: 'same', value: 8 },
    ],
    { labelPointer: '/name', valuePointers: ['/value'], unit: 'count' },
  );
  assert.match(metricReportSvg(report), /data-metric-row="2"/);
  report.chart = 'line';
  assert.match(metricReportSvg(report), /data-metric-row="0"/);
  assert.match(metricReportSvg(report), /data-metric-row="2"/);
});

test('interactive sorting preserves duplicate-label source rows and leaves missing values unavailable', () => {
  const report = buildMetricReport(
    {
      rows: [
        { name: 'same', value: 3, id: 'a' },
        { name: 'same', value: null, id: 'b' },
        { name: 'same', value: 8, id: 'c' },
      ],
    },
    { rowsPointer: '/rows', labelPointer: '/name', valuePointers: ['/value'], unit: 'count' },
  );
  const before = structuredClone(report);
  assert.deepEqual(
    metricReportRows(report, { sort: 'descending' }).map((p) => p.rowIndex),
    [2, 0, 1],
  );
  assert.deepEqual(
    metricReportRows(report, { sort: 'ascending' }).map((p) => p.rowIndex),
    [0, 2, 1],
  );
  assert.equal(metricRowDetail(report, 2).source.id, 'c');
  assert.deepEqual(report, before);
  report.chart = 'line';
  assert.deepEqual(
    metricReportRows(report, { sort: 'descending' }).map((p) => p.rowIndex),
    [0, 1, 2],
  );
  report.points[1].label = 'omit';
  const svg = metricReportSvg(report, { filter: 'same' });
  assert(!svg.includes('stroke-width="2"'));
});

test('view zoom keeps its anchor fixed and never changes source coordinate units', () => {
  const box = [0, 0, 100, 80],
    next = zoomPlotBox(box, 2, 25, 40);
  assert.deepEqual(next, [12.5, 20, 50, 40]);
  assert.deepEqual(zoomPlotBox(next, 0.5, 25, 40), box);
  assert.deepEqual(box, [0, 0, 100, 80]);
  assert.throws(() => zoomPlotBox(box, 0, 0, 0), /Invalid/);
});
