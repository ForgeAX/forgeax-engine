/* Browser-only report interactions. ECharts and Cytoscape own plotting, navigation and hit testing. */
export function gpuClientTools() {
  const el = (id) => document.getElementById(id);
  const text = (tag, value) => {
    const n = document.createElement(tag);
    n.textContent = value;
    return n;
  };
  const download = (name, blob) => {
    const a = document.createElement('a'),
      url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const guard =
    (fn) =>
    async (...args) => {
      try {
        el('error').textContent = '';
        return await fn(...args);
      } catch (e) {
        el('error').textContent = e.message;
      }
    };
  const format = (v) =>
    v === null
      ? 'Unknown'
      : v >= 1048576
        ? (v / 1048576).toFixed(2) + ' MiB'
        : v >= 1024
          ? (v / 1024).toFixed(1) + ' KiB'
          : v + ' B';
  return { el, text, download, guard, format };
}

export function gpuFilteredResources(ctx) {
  const { el } = ctx.t;
  return ctx.report.resources.filter(
    (r) =>
      (el('state').value === 'all' || r.state === el('state').value) &&
      (!el('search').value ||
        (r.label + ' ' + r.resourceId + ' ' + r.kind)
          .toLowerCase()
          .includes(el('search').value.toLowerCase())),
  );
}
export function gpuSelectResource(ctx, id) {
  const r = ctx.report.resources.find((r) => r.resourceId === id);
  if (!r) return;
  ctx.t.el('details-title').textContent = r.label;
  ctx.t.el('details').textContent = JSON.stringify(
    {
      resource: r,
      uses: ctx.report.uses.filter((u) => u.resourceId === id || u.viewResourceId === id),
    },
    null,
    2,
  );
  ctx.resourceId = id;
  const uses = ctx.report.uses.filter((u) => u.resourceId === id || u.viewResourceId === id);
  ctx.t.el('related').replaceChildren();
  for (const u of [
    ...new Map(uses.filter((u) => u.workIndex !== null).map((u) => [u.workIndex, u])).values(),
  ].slice(0, 60)) {
    const button = ctx.t.text('button', 'Work ' + u.workIndex + ' · ' + u.role);
    button.onclick = () => {
      ctx.t.el('work').value = String(u.workIndex);
      gpuRenderGraph(ctx);
      gpuTab(ctx, 'pipeline');
    };
    ctx.t.el('related').append(button);
  }
}
export function gpuRenderResources(ctx) {
  const { el, text, format } = ctx.t,
    metric = el('metric').value;
  const rows = gpuFilteredResources(ctx).sort(
    (a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.label.localeCompare(b.label),
  );
  const tree = ctx.tree(ctx.report, {
    metric,
    group: el('group').value,
    state: el('state').value,
    search: el('search').value,
  });
  ctx.treeChart.clear();
  ctx.treeChart.setOption(
    {
      animation: false,
      backgroundColor: '#101a28',
      title: {
        text: metric === 'bytes' ? 'Known descriptor bytes' : 'Observed API object count',
        subtext: 'Captured tape closure · ' + el('state').selectedOptions[0].textContent,
        left: 10,
        textStyle: { color: '#dfebfb', fontSize: 16 },
        subtextStyle: { color: '#a9bdd6' },
      },
      tooltip: {
        trigger: 'item',
        formatter: (p) => {
          const r = ctx.report.resources.find((r) => r.resourceId === p.data.resourceId);
          return r
            ? r.label + '\n' + r.kind + ' · ' + format(r.bytes) + '\n' + r.resourceId
            : p.name;
        },
        renderMode: 'richText',
      },
      series: [
        {
          type: 'treemap',
          animation: false,
          animationDuration: 0,
          animationDurationUpdate: 0,
          id: 'resources',
          left: 10,
          right: 10,
          top: 70,
          bottom: 36,
          data: tree.children,
          roam: true,
          nodeClick: 'zoomToNode',
          leafDepth: metric === 'count' ? 1 : 2,
          breadcrumb: { show: true, left: 20, bottom: 6, textStyle: { color: '#deebfc' } },
          label: {
            show: true,
            formatter: (p) =>
              p.name + '\n' + (metric === 'count' ? p.value + ' objects' : format(p.value)),
          },
          upperLabel: { show: true, height: 28 },
          itemStyle: { borderColor: '#101a28', borderWidth: 3, gapWidth: 3 },
          levels: [
            { itemStyle: { borderWidth: 4 } },
            { colorSaturation: [0.3, 0.6], itemStyle: { gapWidth: 2 } },
          ],
        },
      ],
    },
    true,
  );
  el('resource-summary').textContent =
    `${rows.length} matched objects · ${rows.filter((r) => r.storage && r.bytes === null).length} storage objects have unknown bytes · area: ${metric === 'bytes' ? 'known descriptor bytes' : 'one per observed API object'}`;
  const body = el('resource-rows');
  body.replaceChildren();
  const offset = ctx.offset ?? 0,
    visible = rows.slice(offset, offset + 100);
  for (const r of visible) {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.dataset.resourceId = r.resourceId;
    for (const value of [r.label, r.kind, format(r.bytes), r.state]) tr.append(text('td', value));
    tr.title = r.resourceId;
    tr.onclick = () => gpuSelectResource(ctx, r.resourceId);
    tr.onkeydown = (e) => {
      if (e.key === 'Enter') gpuSelectResource(ctx, r.resourceId);
    };
    body.append(tr);
  }
  el('page').textContent =
    `${rows.length ? offset + 1 : 0}–${Math.min(offset + 100, rows.length)} / ${rows.length}`;
  el('prev').disabled = offset === 0;
  el('next').disabled = offset + 100 >= rows.length;
}
export function gpuTab(ctx, tab) {
  ctx.active = tab;
  for (const panel of document.querySelectorAll('[data-panel]'))
    panel.hidden = panel.dataset.panel !== tab;
  for (const button of document.querySelectorAll('[data-tab]'))
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  requestAnimationFrame(() => {
    ctx.treeChart.resize();
    ctx.lifeChart.resize();
    ctx.cy?.resize();
    ctx.cy?.fit(undefined, 35);
  });
}
export function gpuRenderGraph(ctx) {
  const { el } = ctx.t,
    work = el('work').value,
    pass = el('pass').value;
  const data = ctx.graph(ctx.report, {
    passIndex: pass === '' ? null : Number(pass),
    workIndex: work === '' ? null : Number(work),
  });
  ctx.cy?.destroy();
  ctx.cy = cytoscape({
    container: el('graph'),
    elements: [...data.nodes, ...data.edges],
    wheelSensitivity: 0.3,
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          color: '#e7efff',
          'text-wrap': 'wrap',
          'text-max-width': 190,
          'font-size': 13,
          'background-color': '#2d6689',
          shape: 'round-rectangle',
          width: 210,
          height: 56,
          'text-valign': 'center',
          'text-halign': 'center',
        },
      },
      {
        selector: 'node[kind = "pass"], node[kind = "work"]',
        style: { 'background-color': '#297d6e' },
      },
      { selector: 'node[kind = "shader"]', style: { 'background-color': '#745398' } },
      {
        selector: 'edge',
        style: {
          width: 1.4,
          'line-color': '#71839b',
          'target-arrow-color': '#9bb2ce',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          label: 'data(label)',
          'font-size': 10,
          color: '#c4d2e5',
          'text-background-color': '#101a28',
          'text-background-opacity': 0.9,
        },
      },
      {
        selector: 'edge[?unknown]',
        style: { 'line-style': 'dashed', 'target-arrow-shape': 'none' },
      },
      { selector: '.dimmed', style: { opacity: 0.12 } },
      { selector: ':selected', style: { 'border-width': 3, 'border-color': '#ffd17c' } },
    ],
    layout: { name: 'preset' },
  });
  el('graph-status').textContent =
    `${data.nodes.length} nodes · ${data.edges.length} edges${data.omittedNodes ? ' · ' + data.omittedNodes + ' nodes omitted; select a pass/work' : ''} · captured usage graph; arrows are not execution dependencies`;
  ctx.cy.on('tap', 'node', (e) => gpuGraphSelection(ctx, e.target));
  ctx.cy.on('mouseover', 'node', (e) => {
    el('graph-hover').textContent = JSON.stringify(e.target.data(), null, 2);
  });
  const layout = ctx.cy.layout({
    name: 'elk',
    fit: true,
    padding: 35,
    elk: {
      algorithm: 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': 32,
      'elk.layered.spacing.nodeNodeBetweenLayers': 90,
    },
  });
  ctx.graphReady = false;
  layout.on('layoutstop', () => {
    ctx.graphReady = true;
    ctx.cy.fit(undefined, 35);
  });
  layout.run();
  if (work !== '') {
    const w = ctx.report.works.find((w) => w.workIndex === Number(work));
    el('details-title').textContent = 'Work ' + work + ' · ' + w.label;
    el('details').textContent = JSON.stringify(w, null, 2);
  }
}
export function gpuGraphSelection(ctx, node) {
  if (ctx.t.el('neighbors').checked) {
    ctx.cy.elements().addClass('dimmed');
    node.closedNeighborhood().removeClass('dimmed');
  }
  const data = node.data();
  if (data.resourceId) gpuSelectResource(ctx, data.resourceId);
  else if (data.workIndex !== undefined) {
    ctx.t.el('details-title').textContent = data.label;
    ctx.t.el('details').textContent = JSON.stringify(
      ctx.report.works.find((w) => w.workIndex === data.workIndex),
      null,
      2,
    );
  } else {
    ctx.t.el('details-title').textContent = data.label;
    ctx.t.el('details').textContent = JSON.stringify(
      ctx.report.passes.find((p) => p.passIndex === data.passIndex),
      null,
      2,
    );
  }
}
export function gpuLifeItem(params, api) {
  const y = api.value(0),
    start = api.coord([api.value(1), y]),
    end = api.coord([api.value(2), y]);
  const height = api.size([0, 1])[1] * 0.6;
  const shape = echarts.graphic.clipRectByRect(
    { x: start[0], y: start[1] - height / 2, width: Math.max(2, end[0] - start[0]), height },
    {
      x: params.coordSys.x,
      y: params.coordSys.y,
      width: params.coordSys.width,
      height: params.coordSys.height,
    },
  );
  return shape && { type: 'rect', shape, style: { fill: '#49b9a9' } };
}
export function gpuRenderLife(ctx) {
  const rows = gpuFilteredResources(ctx).filter((r) => r.storage),
    end = ctx.report.eventCount;
  ctx.lifeRows = rows;
  ctx.lifeChart.setOption(
    {
      animation: false,
      backgroundColor: '#101a28',
      grid: { left: 285, right: 40, top: 30, bottom: 85 },
      tooltip: {
        renderMode: 'richText',
        formatter: (p) => {
          const r = rows[p.value[0]];
          return (
            r.label +
            '\n' +
            (r.createEventIndex === null
              ? 'Bootstrap (creation unknown)'
              : 'Created event ' + r.createEventIndex) +
            '\n' +
            (r.destroyEventIndex === null
              ? 'Not destroyed by end of capture'
              : 'API destroy event ' + r.destroyEventIndex) +
            '\nGPU retirement: unknown'
          );
        },
      },
      xAxis: {
        type: 'value',
        min: -1,
        max: Math.max(1, end),
        name: 'Captured event index (not time)',
        nameLocation: 'middle',
        nameGap: 26,
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.label),
        inverse: true,
        axisLabel: { width: 245, overflow: 'truncate' },
      },
      dataZoom: [
        {
          type: 'slider',
          yAxisIndex: 0,
          right: 8,
          startValue: 0,
          endValue: Math.min(15, rows.length - 1),
          filterMode: 'weakFilter',
        },
        { type: 'inside', yAxisIndex: 0, filterMode: 'weakFilter' },
        { type: 'slider', xAxisIndex: 0, bottom: 16 },
      ],
      series: [
        {
          type: 'custom',
          renderItem: gpuLifeItem,
          encode: { x: [1, 2], y: 0 },
          data: rows.map((r, i) => [i, r.createEventIndex ?? -1, r.destroyEventIndex ?? end]),
        },
      ],
    },
    true,
  );
}
export function gpuFill(ctx) {
  const { el } = ctx.t,
    r = ctx.report;
  el('capture').textContent = r.identity.tapeDigest;
  el('facts').textContent = JSON.stringify(
    {
      identity: r.identity,
      summary: r.summary,
      resourceLifecycle: r.resourceLifecycle,
      unseededResources: r.unseededResources,
      interpretation: r.interpretation,
    },
    null,
    2,
  );
  el('tiles').replaceChildren();
  for (const [name, value] of [
    ['Observed objects', r.summary.observedObjects],
    ['Storage objects', r.summary.storageObjects],
    ['Known payload (all observed)', ctx.t.format(r.summary.knownDescriptorBytes)],
    ['Unknown byte estimates', r.summary.unknownStorageBytes],
    ['Passes / works', r.summary.passes + ' / ' + r.summary.works],
  ]) {
    const tile = document.createElement('div');
    tile.append(ctx.t.text('small', name), ctx.t.text('strong', value));
    el('tiles').append(tile);
  }
  el('pass').replaceChildren(new Option('All passes', ''));
  for (const p of r.passes)
    el('pass').append(new Option(p.label + ' · pass ' + p.passIndex, String(p.passIndex)));
  el('work').replaceChildren(new Option('Pass/resource graph', ''));
  for (const w of r.works)
    el('work').append(new Option(w.label + ' · work ' + w.workIndex, String(w.workIndex)));
  const first = r.passes.find((p) => p.workIndices.length);
  el('pass').value = first ? String(first.passIndex) : '';
  ctx.offset = 0;
  gpuRenderResources(ctx);
  gpuRenderLife(ctx);
  gpuRenderGraph(ctx);
  el('details-title').textContent = 'Select a resource, graph node or work';
  el('details').textContent = '';
  el('related').replaceChildren();
}
export function gpuBind(ctx) {
  const { el, guard, download } = ctx.t;
  for (const b of document.querySelectorAll('[data-tab]'))
    b.onclick = () => gpuTab(ctx, b.dataset.tab);
  for (const id of ['metric', 'group', 'state', 'search'])
    el(id).addEventListener(
      id === 'search' ? 'input' : 'change',
      guard(() => {
        ctx.offset = 0;
        gpuRenderResources(ctx);
        gpuRenderLife(ctx);
      }),
    );
  el('prev').onclick = () => {
    ctx.offset = Math.max(0, ctx.offset - 100);
    gpuRenderResources(ctx);
  };
  el('next').onclick = () => {
    ctx.offset += 100;
    gpuRenderResources(ctx);
  };
  el('pass').onchange = guard(() => {
    el('work').value = '';
    gpuRenderGraph(ctx);
  });
  el('work').onchange = guard(() => gpuRenderGraph(ctx));
  el('fit').onclick = () => {
    ctx.cy.elements().removeClass('dimmed');
    ctx.cy.fit(undefined, 35);
  };
  el('export-tree').onclick = () =>
    download(
      'gpu-resources.png',
      gpuDataUrlBlob(
        ctx.treeChart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#101a28' }),
      ),
    );
  el('export-graph').onclick = guard(async () =>
    download(
      'gpu-pipeline.png',
      await ctx.cy.png({
        output: 'blob-promise',
        full: true,
        bg: '#101a28',
        scale: 2,
        maxWidth: 6000,
        maxHeight: 6000,
      }),
    ),
  );
  el('export-life').onclick = () =>
    download(
      'gpu-resource-spans.png',
      gpuDataUrlBlob(
        ctx.lifeChart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#101a28' }),
      ),
    );
  el('export-data').onclick = () =>
    download('gpu.json', new Blob([JSON.stringify(ctx.report)], { type: 'application/json' }));
  el('load').onchange = guard(async (e) => {
    const value = JSON.parse(await e.target.files[0].text());
    ctx.validate(value);
    ctx.report = value;
    gpuFill(ctx);
    gpuTab(ctx, 'resources');
  });
  ctx.treeChart.on('click', (p) => {
    if (p.data.resourceId) gpuSelectResource(ctx, p.data.resourceId);
  });
  ctx.lifeChart.on('click', (p) => {
    const r = ctx.lifeRows[p.value[0]];
    if (r) gpuSelectResource(ctx, r.resourceId);
  });
  new ResizeObserver(() => {
    ctx.treeChart.resize();
    ctx.lifeChart.resize();
    ctx.cy?.resize();
  }).observe(document.body);
}
export function gpuDataUrlBlob(url) {
  return new Blob([Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0))], {
    type: 'image/png',
  });
}
export function mountGpuReport(report, tree, graph, validate) {
  const t = gpuClientTools();
  try {
    if (!window.echarts || !window.cytoscape) throw Error('Visualization runtime failed to load');
    const ctx = {
      t,
      report,
      tree,
      graph,
      validate,
      offset: 0,
      treeChart: echarts.init(t.el('treemap'), 'dark', { renderer: 'canvas' }),
      lifeChart: echarts.init(t.el('lifetime'), 'dark', { renderer: 'canvas' }),
    };
    gpuBind(ctx);
    gpuFill(ctx);
    gpuTab(ctx, 'resources');
    // Read-only handle for reusable automated image export; the report remains the data authority.
    window.gpuViewer = {
      get report() {
        return ctx.report;
      },
      get graphReady() {
        return ctx.graphReady;
      },
      selectResource: (id) => gpuSelectResource(ctx, id),
      tab: (tab) => gpuTab(ctx, tab),
      graph: (opts) => {
        t.el('work').value = opts.workIndex === undefined ? '' : String(opts.workIndex);
        t.el('pass').value = opts.passIndex === undefined ? '' : String(opts.passIndex);
        gpuRenderGraph(ctx);
      },
      exportResources: () =>
        ctx.treeChart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#101a28' }),
      exportSpans: () =>
        ctx.lifeChart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#101a28' }),
      exportGraph: () =>
        ctx.cy.png({
          output: 'base64uri',
          full: true,
          bg: '#101a28',
          scale: 2,
          maxWidth: 6000,
          maxHeight: 6000,
        }),
    };
  } catch (e) {
    t.el('error').textContent = e.message;
  }
}
