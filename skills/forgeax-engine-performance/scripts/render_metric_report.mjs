#!/usr/bin/env node
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

export function metricReportSvg(report, { width = 1600, filter = '' } = {}) {
  if (!(Number.isSafeInteger(width) && width >= 800 && width <= 16000))
    throw new Error('Require width 800..16000');
  const esc = (v) =>
    String(v)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const points = report.points.filter((p) => p.label.toLowerCase().includes(filter.toLowerCase()));
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
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" role="img" aria-label="Performance metric chart"><style>text{font:12px ui-monospace,monospace;fill:#c6d4e6}</style><rect width="100%" height="100%" fill="#0c1421"/>`,
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
      out.push(text(26, top + i * groupHeight + 15, point.label.slice(0, 36)));
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
        if (previous)
          out.push(
            `<line x1="${previous.x}" y1="${previous.y}" x2="${x(i)}" y2="${y(value)}" stroke="${palette[s]}" stroke-width="2"/>`,
          );
        out.push(
          `<circle cx="${x(i)}" cy="${y(value)}" r="3" fill="${palette[s]}"><title>${esc(point.label)}: ${value} ${esc(report.unit)}</title></circle>`,
        );
        previous = { x: x(i), y: y(value) };
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

export function mountMetricReport(initial) {
  document.head.insertAdjacentHTML(
    'beforeend',
    '<style>body{margin:24px;background:#0b1220;color:#dce7f7;font:14px system-ui}button,input{padding:9px;background:#162b43;color:#edf5ff;border:1px solid #3a526d;border-radius:5px;margin:6px}#plot{overflow:auto;border:1px solid #2b3e59;border-radius:8px;margin-top:18px}table{border-collapse:collapse;width:100%}td,th{padding:10px;text-align:left;border-bottom:1px solid #2b3e59}pre{white-space:pre-wrap;color:#9fb5d0}#error{color:#ffb2a6}</style>',
  );
  document.body.innerHTML =
    '<h1>Performance evidence</h1><label>Open report JSON <input id="file" type="file" accept=".json"></label><input id="filter" placeholder="Filter row labels"><button id="export">Export SVG</button><p id="error" role="alert"></p><div id="plot"></div><pre id="facts"></pre><table id="table"></table><details><summary>Original measurement JSON</summary><pre id="source"></pre></details>';
  const el = (id) => document.getElementById(id);
  let report, svg;
  const draw = () => {
    svg = metricReportSvg(report, { filter: el('filter').value });
    el('plot').innerHTML = svg;
    el('facts').textContent = JSON.stringify(
      { input: report.input, producer: report.producer, interpretation: report.interpretation },
      null,
      2,
    );
    el('source').textContent = JSON.stringify(report.sourceEvidence, null, 2);
    const table = el('table');
    table.replaceChildren();
    const row = (values, heading = false) => {
      const tr = table.insertRow();
      for (const value of values) {
        const cell = document.createElement(heading ? 'th' : 'td');
        cell.textContent =
          typeof value === 'number' ? String(Number(value.toPrecision(6))) : String(value);
        tr.append(cell);
      }
    };
    row(['Source row', ...report.series.map((s) => `${s} (${report.unit})`)], true);
    for (const point of report.points)
      if (point.label.toLowerCase().includes(el('filter').value.toLowerCase()))
        row([point.label, ...point.values.map((v) => v ?? 'unavailable')]);
  };
  const accept = (value) => {
    if (value?.kind !== 'performance-metric-report' || value.schemaVersion !== 1)
      throw Error('Open report.json produced by render_metric_report.mjs');
    metricReportSvg(value);
    report = value;
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
  el('filter').oninput = guard(draw);
  el('file').onchange = guard(async (event) => {
    const file = event.target.files[0];
    if (file) accept(JSON.parse(await file.text()));
  });
  el('export').onclick = guard(() => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'performance.svg';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  accept(initial);
}

export function metricReportHtml(report) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Performance evidence</title><body><script type="module">${metricReportSvg.toString()}\n${mountMetricReport.toString()}\nmountMetricReport(${JSON.stringify(report).replaceAll('<', '\\u003c')});</script></body></html>`;
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
    },
  });
  if (values.help) {
    process.stdout.write(
      'Usage: node render_metric_report.mjs INPUT.json --out-dir NEW_DIRECTORY --unit UNIT [--rows-pointer /samples] [--label-pointer /name] [--value-pointer /value (repeat up to 8 series)] [--chart bar|line] [--title TITLE] [--width 1600]\nWrites report.json, report.svg and report.html exclusively. JSON Pointers select rows, then labels/values relative to each row; a selected object is one row. Numeric arrays use the default empty value pointer. null remains unavailable; no zero filling or unit conversion. Line spacing means row order, not elapsed time. Preserve and inspect producer comparability/completeness separately.\n',
    );
    return;
  }
  requireFact(positionals.length === 1 && values['out-dir'], 'Require input and new --out-dir');
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
  const svg = metricReportSvg(report, { width: Number(values.width) });
  await mkdir(values['out-dir']);
  for (const [name, body] of [
    ['report.json', JSON.stringify(report)],
    ['report.svg', svg],
    ['report.html', metricReportHtml(report)],
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
