#!/usr/bin/env node
import { metricChartData, mountMetricEcharts } from './echarts_metric.mjs';
import { loadEchartsRuntime } from './echarts_runtime.mjs';
import { mountSvgControls, zoomPlotBox } from './plot_interaction.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadJson, pointer, requireFact, runCli } from './lib.mjs';

/** Display projection only: callers select the measured population and one shared unit. */
export function buildMetricReport(
  input,
  {
    rowsPointer = '',
    valuePointers = [''],
    labelPointer,
    unit,
    title = 'Performance measurements',
    chart = 'bar',
  },
) {
  requireFact(typeof unit === 'string' && unit.trim().length > 0, 'Declare the shared metric unit');
  requireFact(['bar', 'line'].includes(chart), 'chart must be bar or line');
  requireFact(valuePointers.length > 0 && valuePointers.length <= 8, 'Select 1..8 value pointers');
  const selected = pointer(input, rowsPointer),
    rows = Array.isArray(selected) ? selected : [selected];
  requireFact(rows.length > 0, 'Selected population is empty');
  const points = rows.map((row, index) => ({
    label:
      labelPointer === undefined
        ? String(index + 1)
        : String(pointer(row, labelPointer)) || `(unnamed ${index + 1})`,
    values: valuePointers.map((path) => {
      const value = pointer(row, path);
      requireFact(
        value === null || (typeof value === 'number' && Number.isFinite(value)),
        `Non-numeric metric at row ${index}, ${path}; use null for unavailable`,
      );
      return value;
    }),
  }));
  return {
    schemaVersion: 1,
    kind: 'performance-metric-report',
    title,
    unit,
    chart,
    rowsPointer,
    labelPointer,
    series: valuePointers.map((path) => path || 'value'),
    points,
    producer: {
      kind: input.kind ?? null,
      status: input.status ?? null,
      ok: input.ok ?? null,
      comparable: input.comparable ?? null,
      completeness: input.completeness ?? null,
      interpretation: input.interpretation ?? input.limitation ?? null,
    },
    sourceEvidence: input,
    interpretation:
      'Display projection of selected input values. Unit and population are caller-declared. Missing values remain unavailable. This chart establishes no comparability, significance or performance gain.',
  };
}

export function metricReportRows(report, { filter = '', sort = 'source', series = 0 } = {}) {
  if (
    !['source', 'ascending', 'descending'].includes(sort) ||
    !Number.isInteger(series) ||
    series < 0 ||
    series >= report.series.length
  )
    throw Error('Invalid metric row selection');
  const rows = report.points
    .map((p, i) => ({ ...p, rowIndex: p.rowIndex ?? i }))
    .filter((p) => p.label.toLowerCase().includes(filter.toLowerCase()));
  if (sort !== 'source' && report.chart !== 'line')
    rows.sort((a, b) => {
      const av = a.values[series],
        bv = b.values[series];
      if (av === null) return bv === null ? a.rowIndex - b.rowIndex : 1;
      if (bv === null) return -1;
      return (sort === 'ascending' ? av - bv : bv - av) || a.rowIndex - b.rowIndex;
    });
  return rows;
}

export function metricRowDetail(report, rowIndex) {
  const point = report.points[rowIndex];
  if (!point) throw Error('Unknown source row');
  let source = report.sourceEvidence;
  for (const part of report.rowsPointer.split('/').slice(1))
    source = source?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
  return {
    sourceRow: rowIndex,
    label: point.label,
    unit: report.unit,
    series: report.series,
    values: point.values,
    source: Array.isArray(source) ? source[rowIndex] : source,
  };
}

export function metricReportSvg(
  report,
  { width = 1600, filter = '', sort = 'source', series = 0 } = {},
) {
  if (!(Number.isSafeInteger(width) && width >= 800 && width <= 16000))
    throw new Error('Require width 800..16000');
  const esc = (v) =>
    String(v)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const points = metricReportRows(report, { filter, sort, series });
  const palette = [
    '#60cbbc',
    '#8999f7',
    '#e8b16b',
    '#db88ab',
    '#71b4ed',
    '#bacb72',
    '#b799dd',
    '#e69c7e',
  ];
  const left = 300,
    right = width - 60,
    top = 155;
  let min = 0,
    max = 0;
  for (const point of points)
    for (const value of point.values)
      if (value !== null) {
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
  if (min === max) max = min + 1;
  const barHeight = 20,
    groupHeight = report.series.length * 27 + 16;
  const height =
    report.chart === 'line' ? 610 : Math.max(320, top + points.length * groupHeight + 90);
  const text = (x, y, value, extra = '') => `<text x="${x}" y="${y}" ${extra}>${esc(value)}</text>`;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Performance metric chart"><style>g[data-metric-row]{cursor:pointer}g[data-metric-row]:hover rect,g[data-metric-row]:focus rect{stroke:#fff;stroke-width:2}text{font:12px ui-monospace,monospace;fill:#c6d4e6}</style><rect width="100%" height="100%" fill="#0c1421"/>`,
    text(26, 36, report.title, 'font-size="21" font-weight="700"'),
    text(
      26,
      62,
      `${points.length}/${report.points.length} rows | unit: ${report.unit} | ${report.producer.comparable === false ? 'NOT COMPARABLE' : 'display only; qualification comes from source evidence'}`,
    ),
    text(26, 85, `Input SHA256: ${report.input?.sha256 ?? 'not supplied'}`),
    text(
      26,
      108,
      `Producer: status=${JSON.stringify(report.producer.status)}, ok=${JSON.stringify(report.producer.ok)}, completeness=${JSON.stringify(report.producer.completeness)}; missing values stay unavailable.`,
    ),
  ];
  report.series.forEach((name, i) =>
    out.push(
      text(left + (i * (right - left)) / report.series.length, 135, name, `fill="${palette[i]}"`),
    ),
  );
  if (report.chart === 'bar') {
    const x = (v) => left + ((v - min) / (max - min)) * (right - left);
    out.push(`<line x1="${x(0)}" y1="${top}" x2="${x(0)}" y2="${height - 70}" stroke="#75869c"/>`);
    points.forEach((point, i) => {
      out.push(
        `<g data-metric-row="${point.rowIndex}" tabindex="0" role="button" aria-label="${esc(point.label)}">`,
        text(26, top + i * groupHeight + 15, point.label.slice(0, 36)),
      );
      point.values.forEach((value, s) => {
        const y = top + i * groupHeight + s * 27;
        if (value === null) {
          out.push(text(left + 8, y + 15, 'unavailable'));
          return;
        }
        out.push(
          `<rect x="${Math.min(x(0), x(value))}" y="${y}" width="${Math.abs(x(value) - x(0))}" height="${barHeight}" fill="${palette[s]}"><title>${esc(point.label)} | ${esc(report.series[s])}: ${value} ${esc(report.unit)}</title></rect>`,
        );
        out.push(
          text(Math.max(left, Math.min(right - 75, x(value) + 8)), y + 15, value.toPrecision(5)),
        );
      });
      out.push('</g>');
    });
  } else {
    const bottom = height - 110,
      x = (i) => left + (i / Math.max(1, points.length - 1)) * (right - left);
    const y = (v) => bottom - ((v - min) / (max - min)) * (bottom - top);
    for (let i = 0; i <= 4; i++) {
      const value = min + ((max - min) * i) / 4;
      out.push(
        `<line x1="${left}" y1="${y(value)}" x2="${right}" y2="${y(value)}" stroke="#29374b"/>`,
        text(26, y(value) + 4, `${value.toPrecision(5)} ${report.unit}`),
      );
    }
    report.series.forEach((_, s) => {
      let previous = null;
      points.forEach((point, i) => {
        const value = point.values[s];
        if (value === null) {
          previous = null;
          return;
        }
        if (previous && point.rowIndex === previous.index + 1)
          out.push(
            `<line x1="${previous.x}" y1="${previous.y}" x2="${x(i)}" y2="${y(value)}" stroke="${palette[s]}" stroke-width="2"/>`,
          );
        out.push(
          `<g data-metric-row="${point.rowIndex}" tabindex="0" role="button" aria-label="${esc(point.label)}"><circle cx="${x(i)}" cy="${y(value)}" r="4" stroke="transparent" stroke-width="8" fill="${palette[s]}"><title>${esc(point.label)}: ${value} ${esc(report.unit)}</title></circle></g>`,
        );
        previous = { x: x(i), y: y(value), index: point.rowIndex };
      });
    });
    out.push(
      text(left, bottom + 28, 'Source row order (spacing is not elapsed time)'),
      text(right, bottom + 50, points.at(-1)?.label ?? '', 'text-anchor="end"'),
    );
  }
  out.push(
    text(
      26,
      height - 25,
      'SOURCE-BASED DISPLAY | no inferred CPU/GPU clock, missing zero, confidence interval or speedup',
    ),
    '</svg>',
  );
  return out.join('');
}

export function mountMetricReport(initial, plotFactory = null) {
  document.head.insertAdjacentHTML(
    'beforeend',
    '<style>body{margin:24px;background:#0b1220;color:#dce7f7;font:14px/1.5 system-ui}button,input,select{padding:9px;background:#162b43;color:#edf5ff;border:1px solid #3a526d;border-radius:5px;margin:6px}#plot{overflow:auto;border:1px solid #2b3e59;border-radius:8px;margin-top:12px}#plot svg{width:100%;height:auto}table{border-collapse:collapse;width:100%}td,th{padding:10px;text-align:left;border-bottom:1px solid #2b3e59}tbody tr{cursor:pointer}tr[data-selected=true]{background:#23445b}pre{white-space:pre-wrap;color:#b8c9df;max-height:400px;overflow:auto}#error{color:#ffb2a6}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:16px;align-items:start}#detail-panel{position:sticky;top:12px;max-height:85vh;overflow:auto;border:1px solid #45617e;border-radius:8px;padding:16px;margin:16px 0}#plot [data-selected=true] rect,#plot [data-selected=true] circle{stroke:#fff;stroke-width:3}@media(max-width:1000px){.workspace{display:block}#detail-panel{position:static}}</style>',
  );
  document.body.innerHTML =
    '<h1>Performance evidence</h1><label>Open report JSON <input id="file" type="file" accept=".json"></label><input id="filter" placeholder="Filter row labels"><label>Sort <select id="sort"><option value="source">Source order</option><option value="descending">Largest first</option><option value="ascending">Smallest first</option></select></label><label>Sort value <select id="series"></select></label><button id="reset">Reset filters</button><button id="export">Export SVG</button><p id="error" role="alert"></p><div class="workspace"><div><div id="plot"></div></div><section id="detail-panel"><h2 id="detail-heading">Click a bar, point or table row</h2><pre id="selection">Hover for exact values. Click to keep the original source row here.</pre></section></div><pre id="facts"></pre><table id="table"></table><details><summary>Original measurement JSON</summary><pre id="source"></pre></details>';
  const el = (id) => document.getElementById(id);
  let report,
    svg,
    selected = null;
  const describe = (index) => {
    const point = report.points[index];
    return [
      point.label,
      ...report.series.map(
        (name, i) => `${name}: ${point.values[i] ?? 'unavailable'} ${report.unit}`,
      ),
      `Source row: ${index}`,
    ].join('\n');
  };
  const controls = mountSvgControls(el('plot'), {
    selector: '[data-metric-row]',
    describe: (element) => describe(Number(element.dataset.metricRow)),
  });
  const highlight = () => {
    for (const element of document.querySelectorAll('[data-metric-row]'))
      element.dataset.selected = String(Number(element.dataset.metricRow) === selected);
  };
  const select = (index) => {
    selected = index;
    el('detail-heading').textContent = report.points[index].label;
    el('selection').textContent = JSON.stringify(metricRowDetail(report, index), null, 2);
    highlight();
    plot?.select(index);
  };
  const plot = plotFactory?.(el('plot'), { rows: metricReportRows, select });
  controls.setEnabled(!plot);
  const drawTable = () => {
    const table = el('table');
    table.replaceChildren();
    const heading = table.insertRow();
    for (const label of [
      'Source row',
      ...report.series.map((name) => `${name} (${report.unit})`),
    ]) {
      const th = document.createElement('th');
      th.textContent = label;
      heading.append(th);
    }
    for (const point of metricReportRows(report, {
      filter: el('filter').value,
      sort: el('sort').value,
      series: Number(el('series').value),
    })) {
      const row = table.insertRow();
      row.dataset.metricRow = point.rowIndex;
      row.tabIndex = 0;
      for (const value of [point.label, ...point.values]) {
        const td = document.createElement('td');
        td.textContent = String(value ?? 'unavailable');
        row.append(td);
      }
      row.onclick = () => select(point.rowIndex);
      row.onkeydown = (event) => {
        if (event.key === 'Enter') select(point.rowIndex);
      };
    }
  };
  const draw = () => {
    const options = {
      filter: el('filter').value,
      sort: el('sort').value,
      series: Number(el('series').value),
    };
    if (plot) {
      plot.render(report, options);
      if (selected !== null) plot.select(selected);
    } else {
      svg = metricReportSvg(report, options);
      el('plot').innerHTML = svg;
      controls.reset();
    }
    drawTable();
    highlight();
  };
  const accept = (value) => {
    if (value?.kind !== 'performance-metric-report' || value.schemaVersion !== 1)
      throw Error('Open report.json produced by render_metric_report.mjs');
    metricReportSvg(value);
    report = value;
    selected = null;
    el('filter').value = '';
    el('sort').value = 'source';
    el('sort').disabled = report.chart === 'line';
    el('series').replaceChildren();
    report.series.forEach((name, i) => {
      const option = document.createElement('option');
      option.value = i;
      option.textContent = name;
      el('series').append(option);
    });
    el('facts').textContent = JSON.stringify(
      { input: report.input, producer: report.producer, interpretation: report.interpretation },
      null,
      2,
    );
    el('source').textContent = JSON.stringify(report.sourceEvidence, null, 2);
    el('selection').textContent = 'Click a bar, point or table row to inspect its original record.';
    el('detail-heading').textContent = 'Select a measurement';
    draw();
  };
  const guard =
    (fn) =>
    async (...args) => {
      try {
        await fn(...args);
        el('error').textContent = '';
      } catch (error) {
        el('error').textContent = error.message;
      }
    };
  el('plot').onclick = (event) => {
    const row = event.target.closest('[data-metric-row]');
    if (row) select(Number(row.dataset.metricRow));
  };
  el('filter').oninput = guard(draw);
  el('sort').onchange = guard(draw);
  el('series').onchange = guard(draw);
  el('reset').onclick = () => {
    el('filter').value = '';
    el('sort').value = 'source';
    draw();
  };
  el('file').onchange = guard(async (event) => {
    const file = event.target.files[0];
    if (file) accept(JSON.parse(await file.text()));
  });
  el('export').onclick = guard(() => {
    const url = URL.createObjectURL(
      new Blob([plot ? plot.svg() : el('plot').querySelector('svg').outerHTML], {
        type: 'image/svg+xml',
      }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'performance.svg';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  accept(initial);
}

export function metricReportHtml(report, { runtime } = {}) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Performance evidence</title><body>${runtime ? `<script src="${runtime.dataUrl}"></script><script type="text/plain" id="echarts-notices">${runtime.notices.replaceAll('<', '&lt;')}</script>` : ''}<script type="module">${zoomPlotBox.toString()}\n${mountSvgControls.toString()}\n${metricReportRows.toString()}\n${metricRowDetail.toString()}\n${metricReportSvg.toString()}\n${metricChartData.toString()}\n${mountMetricEcharts.toString()}\n${mountMetricReport.toString()}\nmountMetricReport(${JSON.stringify(report).replaceAll('<', '\\u003c')}${runtime ? ', mountMetricEcharts' : ''});</script></body></html>`;
}

runCli(import.meta.url, async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      'out-dir': { type: 'string' },
      title: { type: 'string' },
      unit: { type: 'string' },
      'rows-pointer': { type: 'string', default: '' },
      'label-pointer': { type: 'string' },
      'value-pointer': { type: 'string', multiple: true },
      chart: { type: 'string', default: 'bar' },
      width: { type: 'string', default: '1600' },
      'html-viewer': { type: 'string', default: 'svg' },
      'echarts-js': { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'Usage: node render_metric_report.mjs INPUT.json --out-dir NEW_DIRECTORY --unit UNIT [--rows-pointer /samples] [--label-pointer /name] [--value-pointer /value (repeat up to 8 series)] [--chart bar|line] [--title TITLE] [--width 1600] [--html-viewer svg|echarts --echarts-js LOCAL_RUNTIME]\nWrites report.json, report.svg and report.html exclusively. ECharts is opt-in; provide its local runtime and package LICENSE/NOTICE. JSON Pointers select rows, then labels/values relative to each row; a selected object is one row. Numeric arrays use the default empty value pointer. null remains unavailable; no zero filling or unit conversion. Line spacing means row order, not elapsed time. Preserve and inspect producer comparability/completeness separately.\n',
    );
    return;
  }
  requireFact(positionals.length === 1 && values['out-dir'], 'Require input and new --out-dir');
  requireFact(
    ['svg', 'echarts'].includes(values['html-viewer']),
    'html-viewer must be svg or echarts',
  );
  const runtime =
    values['html-viewer'] === 'echarts' ? await loadEchartsRuntime(values['echarts-js']) : null;
  const input = await loadJson(positionals[0]);
  const report = buildMetricReport(input.value, {
    rowsPointer: values['rows-pointer'],
    labelPointer: values['label-pointer'],
    valuePointers: values['value-pointer'] ?? [''],
    title: values.title,
    unit: values.unit,
    chart: values.chart,
  });
  report.input = { path: positionals[0], sha256: input.sha256 };
  report.command = process.argv.slice(1);
  if (runtime) report.viewer = { name: 'echarts', runtime: runtime.receipt };
  const svg = metricReportSvg(report, { width: Number(values.width) });
  await mkdir(values['out-dir']);
  for (const [name, body] of [
    ['report.json', JSON.stringify(report)],
    ['report.svg', svg],
    ['report.html', metricReportHtml(report, { runtime })],
  ])
    await writeFile(join(values['out-dir'], name), body, { flag: 'wx' });
  process.stdout.write(
    JSON.stringify({
      status: 'display-only',
      directory: values['out-dir'],
      rows: report.points.length,
    }) + '\n',
  );
});
