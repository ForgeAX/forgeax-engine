import { memoryMetric } from './memory_model.mjs';

/** Project a bounded visible tree; all unrendered children retain their combined mass. */
export function projectMemoryTree(
  model,
  id,
  { metric, depth = 3, limit = 40, maxNodes = 2000, getNode } = {},
) {
  if (
    !Number.isInteger(depth) ||
    depth < 1 ||
    depth > 8 ||
    !Number.isInteger(limit) ||
    limit < 2 ||
    limit > 200
  )
    throw Error('Invalid memory chart bounds');
  if (!Number.isInteger(maxNodes) || maxNodes < 4 || maxNodes > 10000)
    throw Error('Invalid memory chart node budget');
  const measure = memoryMetric(model, metric);
  const nodes = getNode ? null : new Map(model.nodes.map((n) => [n.id, n]));
  const lookup = getNode ?? ((key) => nodes.get(key));
  const visit = (key, level, budget) => {
    const n = lookup(key);
    if (!n) throw Error('Unknown chart node');
    const row = { id: n.id, nodeId: n.id, name: n.label, value: n[measure.total] };
    if (level >= depth || !n.children.length || budget < 4) return row;
    const ordered = n.children
      .map(lookup)
      .filter((c) => c[measure.total] > 0)
      .sort(
        (a, b) =>
          b[measure.total] - a[measure.total] ||
          b.totalBytes - a.totalBytes ||
          b.totalCount - a.totalCount ||
          a.id.localeCompare(b.id),
      );
    const cap = Math.min(limit, budget - 2);
    const shown = ordered.length > cap ? ordered.slice(0, cap - 1) : ordered;
    const each = Math.max(1, Math.floor((budget - 3) / Math.max(1, shown.length)));
    row.children = shown.map((c) => visit(c.id, level + 1, each));
    if (n[measure.self] > 0)
      row.children.unshift({
        id: n.id + '/self',
        nodeId: n.id,
        name: 'Self: ' + n.label,
        value: n[measure.self],
        self: true,
      });
    if (shown.length < ordered.length)
      row.children.push({
        id: n.id + '/other',
        nodeId: n.id,
        name: `Other ${ordered.length - shown.length} children`,
        value: ordered.slice(shown.length).reduce((sum, c) => sum + c[measure.total], 0),
        offset: shown.length,
        aggregate: true,
      });
    return row;
  };
  return visit(id, 0, maxNodes);
}

export function mountMemoryEcharts(host, context) {
  const caption = document.createElement('div');
  caption.className = 'plot-tools';
  caption.style.padding = '0 28px';
  caption.innerHTML =
    '<strong>Apache ECharts</strong> · wheel to zoom · drag to pan · click to drill down <button type="button">Fit</button>';
  host.before(caption);
  let chart = null,
    lastModel = null,
    lastKey = null;
  const escape = (value) =>
    String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const fit = () => {
    if (chart) {
      lastKey = null;
      context.redraw();
    }
  };
  caption.querySelector('button').onclick = fit;
  const render = (model, id, { metric, depth }) => {
    caption.hidden = false;
    const key = JSON.stringify([id, metric, depth]);
    if (chart && model === lastModel && key === lastKey) return;
    host.style.height = '760px';
    if (!chart) {
      host.replaceChildren();
      chart = echarts.init(host, 'dark', { renderer: 'svg' });
      chart.on('click', (params) => {
        const row = params.data;
        if (row?.nodeId) context.select(row.nodeId, row.offset);
      });
    }
    const measure = memoryMetric(model, metric),
      tree = projectMemoryTree(model, id, { metric, depth, getNode: context.node });
    const palette = ['#5070dd', '#2d9d8f', '#a06cc4', '#b07b38', '#417fa8', '#bc6673'];
    chart.clear();
    chart.setOption(
      {
        animation: false,
        backgroundColor: '#0c1421',
        tooltip: {
          confine: true,
          formatter: (params) => {
            const row = params.data,
              n = context.node(row.nodeId);
            if (row.aggregate)
              return (
                escape(row.name) +
                '<br>' +
                escape(row.value) +
                ' ' +
                escape(measure.label) +
                '<br>Click to browse the complete child list'
              );
            return (
              escape(row.name) +
              '<br>Self: ' +
              escape(n.selfCount) +
              ' ' +
              escape(model.countLabel) +
              ' · ' +
              escape(n.selfBytes) +
              ' bytes<br>Total: ' +
              escape(n.totalCount) +
              ' ' +
              escape(model.countLabel) +
              ' · ' +
              escape(n.totalBytes) +
              ' bytes<br>Source: ' +
              escape(
                n.source
                  ? n.source.file + ':' + n.source.line + ':' + n.source.column
                  : n.callFrame
                    ? n.callFrame.url + ':' + (n.callFrame.lineNumber + 1)
                    : n.id,
              )
            );
          },
        },
        series: [
          {
            id: 'memory',
            type: 'treemap',
            animationDuration: 0,
            animationDurationUpdate: 0,
            data: [tree],
            left: 8,
            right: 8,
            top: 8,
            bottom: 8,
            roam: true,
            nodeClick: false,
            breadcrumb: { show: false },
            visibleMin: 1,
            childrenVisibleMin: 4,
            label: {
              show: true,
              color: '#edf5ff',
              formatter: (params) =>
                params.name + '\n' + Number(params.value).toLocaleString('en-US'),
            },
            upperLabel: {
              show: true,
              height: 28,
              color: '#fff',
              formatter: (params) =>
                params.name + ' · ' + Number(params.value).toLocaleString('en-US'),
            },
            itemStyle: { borderColor: '#0c1421', borderWidth: 2, gapWidth: 2 },
            levels: [
              {
                color: palette,
                upperLabel: { show: false },
                itemStyle: { borderColor: '#68829c', borderWidth: 1, gapWidth: 3 },
              },
              { color: palette },
              { colorSaturation: [0.35, 0.7] },
            ],
          },
        ],
      },
      true,
    );
    lastModel = model;
    lastKey = key;
  };
  const hide = () => {
    caption.hidden = true;
    if (chart) {
      chart.dispose();
      chart = null;
    }
    lastKey = null;
    host.style.height = '';
  };
  window.addEventListener('resize', () => chart?.resize());
  return { render, hide, svg: () => chart.renderToSVGString() };
}
