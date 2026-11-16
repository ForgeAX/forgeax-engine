/** Keep source row identities and absent/filter gaps while projecting ECharts series. */
export function metricChartData(report, rows) {
  const visible = new Set(rows.map((row) => row.rowIndex));
  const points =
    report.chart === 'line'
      ? report.points.map((point, rowIndex) => ({ ...point, rowIndex }))
      : rows;
  return {
    labels: points.map((point) => point.label),
    series: report.series.map((name, seriesIndex) => ({
      name,
      type: report.chart,
      connectNulls: false,
      data: points.map((point) => ({
        value: visible.has(point.rowIndex) ? point.values[seriesIndex] : null,
        rowIndex: point.rowIndex,
        name: point.label,
      })),
    })),
  };
}

export function mountMetricEcharts(host, context) {
  host.style.height = '640px';
  const chart = echarts.init(host, 'dark', { renderer: 'svg' });
  let current = null,
    last = null,
    lastKey = null;
  const escape = (value) =>
    String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  chart.on('click', (params) => {
    if (Number.isInteger(params.data?.rowIndex)) context.select(params.data.rowIndex);
  });
  const select = (rowIndex) => {
    chart.dispatchAction({ type: 'downplay' });
    if (!current) return;
    current.series.forEach((series, seriesIndex) => {
      const dataIndex = series.data.findIndex(
        (item) => item.rowIndex === rowIndex && item.value !== null,
      );
      if (dataIndex >= 0) chart.dispatchAction({ type: 'highlight', seriesIndex, dataIndex });
    });
  };
  const render = (report, options) => {
    const key = JSON.stringify(options);
    if (last === report && lastKey === key) return;
    // Preserve zoom on a pure re-sort, reset it when the population changes.
    const zoom =
      last === report && JSON.parse(lastKey).filter === options.filter
        ? chart.getOption().dataZoom?.[0]
        : null;
    const rows = context.rows(report, options);
    current = metricChartData(report, rows);
    const line = report.chart === 'line';
    chart.setOption(
      {
        animation: false,
        backgroundColor: '#0b1220',
        textStyle: { color: '#dce7f7' },
        title: { text: report.title, left: 16, textStyle: { color: '#edf5ff', fontSize: 17 } },
        legend: { top: 36, textStyle: { color: '#c7d7e8' } },
        grid: { left: line ? 90 : 290, right: 115, top: 90, bottom: 80 },
        tooltip: {
          confine: true,
          formatter: (params) =>
            escape(params.data.name) +
            '<br>' +
            escape(params.seriesName) +
            ': ' +
            escape(params.value ?? 'unavailable') +
            ' ' +
            escape(report.unit) +
            '<br>Source row: ' +
            params.data.rowIndex,
        },
        toolbox: {
          right: 16,
          iconStyle: { borderColor: '#b8d2ee' },
          feature: { restore: {}, saveAsImage: { type: 'svg', name: 'performance' } },
        },
        xAxis: line
          ? { type: 'category', data: current.labels, axisLabel: { hideOverlap: true } }
          : { type: 'value', name: report.unit, nameLocation: 'middle', nameGap: 32 },
        yAxis: line
          ? { type: 'value', name: report.unit }
          : {
              type: 'category',
              inverse: true,
              data: current.labels,
              axisLabel: { width: 260, overflow: 'truncate', interval: 0 },
            },
        dataZoom: [
          {
            type: 'inside',
            [line ? 'xAxisIndex' : 'yAxisIndex']: 0,
            start: zoom?.start ?? 0,
            end: zoom?.end ?? 100,
            filterMode: 'none',
          },
          {
            type: 'slider',
            [line ? 'xAxisIndex' : 'yAxisIndex']: 0,
            ...(line ? { bottom: 12 } : { right: 12, width: 20 }),
            start: zoom?.start ?? 0,
            end: zoom?.end ?? 100,
            filterMode: 'none',
            textStyle: { color: '#dce7f7' },
          },
        ],
        series: current.series.map((series, index) => ({
          ...series,
          id: 'metric-' + index,
          emphasis: { focus: 'none', itemStyle: { borderColor: '#fff', borderWidth: 2 } },
          symbolSize: 8,
        })),
      },
      true,
    );
    last = report;
    lastKey = key;
  };
  window.addEventListener('resize', () => chart.resize());
  return { render, select, svg: () => chart.renderToSVGString() };
}
