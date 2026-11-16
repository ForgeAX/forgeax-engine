// Pure rendering shared by the Node SVG exporter and the embedded offline viewer.
export function cpuTimelineSampleDensity(track, fromMs, toMs) {
  const samples = track.samples.filter((s) => s.endMs > fromMs && s.endMs <= toMs);
  const intervals = samples
    .map((s) => s.endMs - s.startMs)
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);
  const percentile = (p) =>
    intervals.length ? intervals[Math.ceil(p * intervals.length) - 1] : null;
  return {
    samples: samples.length,
    activeSamples: samples.filter((s) => s.category !== 'idle').length,
    intervalP50Ms: percentile(0.5),
    intervalP95Ms: percentile(0.95),
  };
}

export function cpuTimelineFunctionRows(model, fromMs, toMs) {
  return model.tracks.map((track) => {
    const rows = new Map(
      track.nodes.map((node) => [node.nodeId, { ...node, selfMs: 0, inclusiveMs: 0, samples: 0 }]),
    );
    const overlap = (span) =>
      Math.max(0, Math.min(span.endMs, toMs) - Math.max(span.startMs, fromMs));
    for (const sample of track.samples) {
      const ms = overlap(sample);
      if (ms > 0) {
        const row = rows.get(sample.nodeId);
        row.selfMs += ms;
        row.samples++;
      }
    }
    for (const slice of track.slices) rows.get(slice.nodeId).inclusiveMs += overlap(slice);
    return {
      targetId: track.target.targetId,
      rows: [...rows.values()]
        .filter((row) => row.selfMs > 0 || row.inclusiveMs > 0)
        .sort(
          (a, b) => b.selfMs - a.selfMs || b.inclusiveMs - a.inclusiveMs || a.nodeId - b.nodeId,
        ),
    };
  });
}

function validateCpuTimelineViewport(model, width, fromMs, toMs) {
  if (
    !(
      Number.isSafeInteger(width) &&
      width >= 800 &&
      width <= 16000 &&
      Number.isFinite(fromMs) &&
      Number.isFinite(toMs) &&
      fromMs >= model.startMs &&
      toMs <= model.endMs &&
      toMs > fromMs
    )
  )
    throw new Error('Require width 800..16000 and an increasing range inside the capture');
}

export function cpuTimelineSvg(
  model,
  { width = 2400, fromMs = model.startMs, toMs = model.endMs, search = '' } = {},
) {
  validateCpuTimelineViewport(model, width, fromMs, toMs);
  const escape = (value) =>
    String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
  const color = (name) => {
    if (name === '(idle)') return '#536579';
    if (name === '(garbage collector)') return '#f3ad5d';
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
    return `hsl(${170 + (Math.abs(h) % 110)} 49% 45%)`;
  };
  const left = 200,
    right = width - 24,
    scale = (right - left) / (toMs - fromMs);
  const x = (ms) => left + (ms - fromMs) * scale;
  const rows = [],
    trackLayouts = [];
  let y = 210;
  for (const track of model.tracks) {
    let maxDepth = 0;
    for (const s of track.slices)
      if (s.endMs > fromMs && s.startMs < toMs) maxDepth = Math.max(maxDepth, s.depth);
    trackLayouts.push({ track, y, height: Math.max(72, (maxDepth + 1) * 21 + 34) });
    y += trackLayouts.at(-1).height + 14;
  }
  const height = y + 56;
  const text = (tx, ty, value, extra = '') =>
    `<text x="${tx}" y="${ty}" ${extra}>${escape(value)}</text>`;
  const rect = (start, end, ry, rh, fill, title, extra = '', label = '') => {
    const a = Math.max(start, fromMs),
      b = Math.min(end, toMs);
    if (b <= a) return '';
    const w = (b - a) * scale;
    return `<g ${extra}><title>${escape(title)}</title><rect x="${x(a)}" y="${ry}" width="${w}" height="${rh}" fill="${fill}" rx="2"/>${w > 45 ? text(x(a) + 5, ry + 14, label.slice(0, Math.floor((w - 10) / 6.8)), 'fill="#fff" font-size="11"') : ''}</g>`;
  };
  rows.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="CPU sampling timeline"><style>text{pointer-events:none;font-family:ui-monospace,monospace;fill:#becbdd;font-size:12px}.muted{fill:#8194aa}g[data-node],g[data-frame]{cursor:pointer}g[data-frame]:hover rect{stroke:#fff;stroke-width:2}</style><rect width="100%" height="100%" fill="#0c1421"/>`,
  );
  rows.push(
    text(24, 34, 'CPU / SAMPLING TIMELINE', 'font-size="20" font-weight="700" fill="#f2f6ff"'),
  );
  rows.push(
    text(
      24,
      59,
      `${model.tracks.length} JS targets | ${model.frameIntervals.length} completion intervals | ${fromMs.toFixed(3)} - ${toMs.toFixed(3)} ms | producer ok: ${model.producerReportOk ?? 'unknown'} | not sampled: ${(model.captureScope?.unsampledTargets ?? []).map((t) => t.title || t.targetId).join(', ') || 'none declared'}`,
    ),
  );
  rows.push(
    text(
      24,
      82,
      `Sampled estimates, not measured function scopes or OS CPU time. Clock uncertainty: ${model.clock ? model.clock.uncertaintyMs.toFixed(3) + ' ms' : 'no cross-target alignment'}`,
      'class="muted"',
    ),
  );
  rows.push(
    text(
      24,
      104,
      'Blank regions are unobserved. Completion gaps are not frame execution latency. Nested widths overlap.',
      'class="muted"',
    ),
  );
  for (let i = 0; i <= 8; i++) {
    const at = fromMs + (i * (toMs - fromMs)) / 8;
    rows.push(`<line x1="${x(at)}" y1="144" x2="${x(at)}" y2="${height - 40}" stroke="#263248"/>`);
    rows.push(
      text(x(at), 132, `${at.toFixed(2)} ms`, `text-anchor="${i === 8 ? 'end' : 'start'}"`),
    );
  }
  rows.push(text(24, 166, 'COMPLETION GAP'));
  rows.push(text(24, 184, 'receipt to receipt', 'class="muted" font-size="10"'));
  model.frameIntervals.forEach((frame, index) => {
    const fill =
      frame.coverage !== 'complete' || frame.missingIntermediateReceipts > 0
        ? '#9e7154'
        : '#367c83';
    rows.push(
      rect(
        frame.startMs,
        frame.endMs,
        151,
        36,
        fill,
        `Completion #${frame.current.frameId}: ${frame.completionGapMs.toFixed(3)} ms; ${frame.coverage}; missing receipts ${frame.missingIntermediateReceipts}; ${frame.current.worldIdentity}/${frame.current.deviceGeneration}`,
        `data-frame="${index}"`,
        `#${frame.current.frameId} | ${frame.completionGapMs.toFixed(2)} ms`,
      ),
    );
  });
  if (!model.frameIntervals.length)
    rows.push(text(left + 8, 173, 'No aligned completion receipts supplied', 'class="muted"'));
  const paintTrackSlices = (track, top, trackIndex) => {
    const nodes = new Map(track.nodes.map((n) => [n.nodeId, n]));
    for (const slice of track.slices) {
      if (slice.endMs <= fromMs || slice.startMs >= toMs) continue;
      const node = nodes.get(slice.nodeId),
        name = node.source?.functionName || node.functionName || '(anonymous)';
      const location = node.source
        ? `${node.source.file}:${node.source.line}:${node.source.column}`
        : `${node.url}:${node.lineNumber + 1}:${node.columnNumber + 1}`;
      const title = `${name}\nCaptured function: ${node.functionName || '(anonymous)'}\n${slice.startMs.toFixed(3)} - ${slice.endMs.toFixed(3)} ms (${(slice.endMs - slice.startMs).toFixed(3)} ms sampled estimate)\nSource: ${location}\nGenerated: ${node.url}:${node.lineNumber + 1}:${node.columnNumber + 1}\nTarget ${track.target.targetId}`;
      const match = !search || `${name} ${location}`.toLowerCase().includes(search.toLowerCase());
      rows.push(
        rect(
          slice.startMs,
          slice.endMs,
          top + 7 + slice.depth * 21,
          19,
          color(name),
          title,
          `data-track="${trackIndex}" data-node="${slice.nodeId}" data-start="${slice.startMs}" data-end="${slice.endMs}"${match ? '' : ' opacity="0.15"'}`,
          name,
        ),
      );
    }
  };
  for (const [trackIndex, { track, y: top, height: rh }] of trackLayouts.entries()) {
    rows.push(
      `<rect x="${left}" y="${top}" width="${right - left}" height="${rh}" fill="#152135" opacity="0.65"/>`,
    );
    rows.push(text(24, top + 18, track.name.slice(0, 23), 'fill="#edf4ff" font-weight="700"'));
    rows.push(
      text(24, top + 37, track.target.targetId.slice(0, 23), 'class="muted" font-size="10"'),
    );
    const density = cpuTimelineSampleDensity(track, fromMs, toMs);
    rows.push(
      text(
        24,
        top + 54,
        `${density.samples} samples / ${density.activeSamples} active`,
        'class="muted" font-size="10"',
      ),
    );
    rows.push(
      text(
        24,
        top + 71,
        `median dt ${density.intervalP50Ms?.toFixed(3) ?? '?'} ms`,
        'class="muted" font-size="10"',
      ),
    );
    paintTrackSlices(track, top, trackIndex);
  }
  rows.push(
    text(
      24,
      height - 42,
      `Source: ${model.identity.game ?? model.identity.rawSha256 ?? 'input identity unavailable'}`,
      'class="muted"',
    ),
  );
  rows.push(
    text(
      24,
      height - 20,
      'TIME ORDER | width = estimated interval | depth = call stack | gray = idle sample | amber = GC sample',
      'class="muted"',
    ),
  );
  rows.push('</svg>');
  return rows.join('');
}

export function mountCpuTimeline(initial, initialView = {}) {
  document.head.insertAdjacentHTML(
    'beforeend',
    `<style>
    *{box-sizing:border-box}body{margin:0;background:#0b1220;color:#dce7f7;font:14px system-ui,sans-serif}
    header{padding:25px 30px 18px;border-bottom:1px solid #29374e;background:#101c2d}
    h1{margin:0;font-size:23px;letter-spacing:-.4px}p{color:#99acc4;line-height:1.55;margin:8px 0}
    .tag{color:#7be0cf;font:11px ui-monospace,monospace;letter-spacing:2px;margin-bottom:9px}
    nav{display:flex;gap:9px;flex-wrap:wrap;align-items:center;padding:16px 30px;background:#111e30}
    button,.file{border:1px solid #38506e;background:#1a3049;color:#edf7ff;padding:8px 12px;border-radius:6px;cursor:pointer;font:inherit}
    button:hover,.file:hover{background:#274865}input{background:#091424;border:1px solid #3a506d;color:#eff6ff;border-radius:5px;padding:8px;font:inherit}
    input[type=number]{width:115px}input[type=search]{width:220px}#load{display:none}#status{padding:10px 30px;color:#9fb6d2;font:12px ui-monospace,monospace}
    #chart{overflow:auto;margin:0 20px;border:1px solid #2b3e59;border-radius:9px}#chart svg{display:block}
    section{margin:20px 30px 35px}h2{font-size:16px}table{border-collapse:collapse;width:100%;font:12px ui-monospace,monospace}
    th,td{text-align:left;padding:11px;border-bottom:1px solid #27384e}th{color:#9bb6d3}#error{color:#ffab9f;margin:0 30px}small{color:#90a7c3}
  </style>`,
  );
  document.body.innerHTML = `<header><div class="tag">FORGEAX / OFFLINE PROFILING</div><h1>CPU sampling timeline</h1><p>Read the same capture as frame intervals, parallel JS targets and time-ordered call stacks.</p><small>Sampling estimates and completion receipts. Native threads, scheduling states and exact function scopes need separate sources.</small></header>
    <nav><label class="file">Open timeline JSON<input type="file" id="load" accept=".json"></label>
    <label>From <input id="from" type="number" step="any" aria-label="From milliseconds"></label>
    <label>To <input id="to" type="number" step="any" aria-label="To milliseconds"></label>
    <button id="apply">Apply range</button><button id="reset">Full capture</button><button id="zoom">Zoom in 2x</button>
    <input id="search" type="search" placeholder="Find function or source" aria-label="Find function or source">
    <button id="svg">Export SVG</button><button id="png">Export PNG</button></nav>
    <div id="status"></div><p id="error" role="alert"></p><main id="chart"></main>
    <section><h2 id="selection">Select a completion interval above</h2><p>Sample weights below estimate activity within that interval. They are not exclusive execution time for that frame.</p><div id="detail"></div><pre id="frame-facts" style="white-space:pre-wrap"></pre></section>
    <section><h2>Aggregated call tree</h2><button id="topdown">Top-down</button><button id="bottomup">Bottom-up self costs</button><button id="tree-svg">Export call-tree SVG</button><p id="tree-note"></p><div id="call-trees"></div></section><section><h2>Functions in the visible interval</h2><p>Self and inclusive values are sampled estimates. Each row identifies one call-tree context; recursive levels remain separate. Click a stack segment for its source and callers.</p><pre id="function-detail" style="white-space:pre-wrap"></pre><div id="functions"></div></section>`;
  const treeStyle = document.createElement('style');
  treeStyle.textContent =
    '#call-trees details details{margin-left:18px;border-left:1px solid #29415b;padding-left:8px}#call-trees summary{font:12px/26px ui-monospace,monospace;cursor:pointer}#call-trees summary:hover{background:#1d3046}.tree-row{display:inline-grid;grid-template-columns:minmax(260px,1fr) 150px 150px 110px;width:calc(100% - 26px)}.tree-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}';
  document.head.append(treeStyle);
  const el = (id) => document.getElementById(id);
  let model,
    fromMs,
    toMs,
    svg,
    treeDirection = 'top-down';
  const width = () => Math.max(1200, Math.min(2400, window.innerWidth - 42));
  const render = () => {
    svg = cpuTimelineSvg(model, { width: width(), fromMs, toMs, search: el('search').value });
    el('chart').innerHTML = svg;
    el('from').value = fromMs;
    el('to').value = toMs;
    el('status').textContent =
      `${model.completeness} | ${model.tracks.length} captured JS targets | not sampled: ${(model.captureScope?.unsampledTargets ?? []).map((t) => t.title || t.targetId).join(', ') || 'none declared'} | ${model.frameIntervals.length} completion intervals | ${model.identity.game ?? model.identity.rawSha256 ?? 'no input digest'} | click an interval to inspect`;
    el('error').textContent = '';
    el('function-detail').textContent = '';
    const trees = cpuTimelineCallTrees(model, fromMs, toMs, { direction: treeDirection });
    el('call-trees').replaceChildren();
    el('tree-note').textContent = trees[0]?.interpretation ?? '';
    for (const tree of trees) {
      const section = document.createElement('section'),
        heading = document.createElement('h3');
      heading.textContent = tree.name;
      section.append(heading);
      const add = (id, parent, depth) => {
        const row = tree.nodes[id],
          details = document.createElement('details'),
          summary = document.createElement('summary');
        const line = document.createElement('span');
        line.className = 'tree-row';
        for (const text of [
          row.label,
          `${treeDirection === 'top-down' ? 'Total' : 'Leaf cost'} ${row.totalMs.toFixed(4)} ms`,
          treeDirection === 'top-down' ? `Self ${row.selfMs.toFixed(4)} ms` : 'caller distribution',
          `${row.samples} samples`,
        ]) {
          const cell = document.createElement('span');
          cell.textContent = text;
          line.append(cell);
        }
        summary.append(line);
        summary.title = row.source
          ? `${row.source.file}:${row.source.line}:${row.source.column}`
          : (row.callFrame?.url ?? row.label);
        details.append(summary);
        parent.append(details);
        let expanded = false;
        const expand = () => {
          if (expanded) return;
          expanded = true;
          let shown = 0;
          const more = () => {
            for (const child of row.children.slice(shown, shown + 100))
              add(child, details, depth + 1);
            shown += 100;
            if (shown < row.children.length) {
              const b = document.createElement('button');
              b.textContent = `More children (${row.children.length - shown})`;
              b.onclick = () => {
                b.remove();
                more();
              };
              details.append(b);
            }
          };
          more();
        };
        details.ontoggle = () => {
          if (details.open) expand();
        };
        if (depth < 2) {
          expand();
          details.open = true;
        }
      };
      add(tree.rootId, section, 0);
      el('call-trees').append(section);
    }
    const container = el('functions');
    container.replaceChildren();
    for (const result of cpuTimelineFunctionRows(model, fromMs, toMs)) {
      const track = model.tracks.find((t) => t.target.targetId === result.targetId);
      const section = document.createElement('details');
      section.open = true;
      const summary = document.createElement('summary');
      const density = cpuTimelineSampleDensity(track, fromMs, toMs);
      summary.textContent = `${track.name} - ${density.samples} samples (${density.activeSamples} active), median / p95 interval ${density.intervalP50Ms?.toFixed(3) ?? '?'} / ${density.intervalP95Ms?.toFixed(3) ?? '?'} ms; ${result.rows.length} call-tree nodes (top 80 by self time)`;
      section.append(summary);
      const table = document.createElement('table');
      const append = (values, heading = false) => {
        const tr = table.insertRow();
        for (const value of values) {
          const cell = document.createElement(heading ? 'th' : 'td');
          cell.textContent = String(value);
          tr.append(cell);
        }
        return tr;
      };
      append(['Function', 'Self ms', 'Inclusive ms', 'Leaf samples'], true);
      for (const row of result.rows.slice(0, 80)) {
        const source = row.source
          ? `${row.source.file}:${row.source.line}:${row.source.column}`
          : `${row.url}:${row.lineNumber + 1}:${row.columnNumber + 1} (generated)`;
        const tr = append([
          row.source?.functionName || row.functionName || '(anonymous)',
          row.selfMs.toFixed(4),
          row.inclusiveMs.toFixed(4),
          row.samples,
        ]);
        tr.title = `Captured function: ${row.functionName || '(anonymous)'}\nSource: ${source}\nCall-tree context #${row.nodeId}`;
        tr.style.cursor = 'pointer';
        tr.onclick = () => showFunction(track, row.nodeId);
      }
      section.append(table);
      container.append(section);
    }
  };
  const showFunction = (track, nodeId) => {
    const result = cpuTimelineFunctionRows(model, fromMs, toMs).find(
      (r) => r.targetId === track.target.targetId,
    );
    const row =
      result.rows.find((r) => r.nodeId === nodeId) ?? track.nodes.find((r) => r.nodeId === nodeId);
    const parents = [],
      visited = new Set([nodeId]);
    let parent = row.parentNodeId;
    while (parent !== null && parent !== undefined && !visited.has(parent)) {
      visited.add(parent);
      const owner = track.nodes.find((r) => r.nodeId === parent);
      if (!owner) break;
      parents.push({
        nodeId: owner.nodeId,
        functionName: owner.functionName,
        source: owner.source ?? {
          url: owner.url,
          lineNumber: owner.lineNumber,
          columnNumber: owner.columnNumber,
        },
      });
      parent = owner.parentNodeId;
    }
    el('function-detail').textContent = JSON.stringify(
      {
        target: track.target,
        visibleInterval: { fromMs, toMs },
        function: row,
        callersLeafToRoot: parents,
      },
      null,
      2,
    );
  };
  const accept = (next, range = next?.initialView ?? {}) => {
    if (
      next?.schemaVersion !== 1 ||
      next.kind !== 'sampled-cpu-timeline' ||
      !Array.isArray(next.tracks) ||
      !Array.isArray(next.frameIntervals)
    )
      throw new Error('Open a normalized timeline.json produced by cpu.mjs report');
    cpuTimelineSvg(next, { width: width(), fromMs: range.fromMs, toMs: range.toMs }); // Keep the current model if admission/rendering fails.
    model = next;
    fromMs = range.fromMs ?? model.startMs;
    toMs = range.toMs ?? model.endMs;
    el('detail').replaceChildren();
    el('frame-facts').textContent = '';
    el('selection').textContent = 'Select a completion interval above';
    render();
  };
  const guard =
    (fn) =>
    async (...args) => {
      try {
        await fn(...args);
      } catch (error) {
        el('error').textContent = error.message;
      }
    };
  el('topdown').onclick = () => {
    treeDirection = 'top-down';
    render();
  };
  el('bottomup').onclick = () => {
    treeDirection = 'bottom-up';
    render();
  };
  el('tree-svg').onclick = () =>
    download(
      new Blob([cpuCallTreeSvg(model, { fromMs, toMs, direction: treeDirection })], {
        type: 'image/svg+xml',
      }),
      'cpu-call-tree.svg',
    );
  el('load').onchange = guard(async (event) => {
    const file = event.target.files[0];
    if (file) accept(JSON.parse(await file.text()));
  });
  document.body.ondragover = (event) => event.preventDefault();
  document.body.ondrop = guard(async (event) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) accept(JSON.parse(await file.text()));
  });
  el('apply').onclick = guard(() => {
    const nextFrom = Number(el('from').value),
      nextTo = Number(el('to').value);
    cpuTimelineSvg(model, { width: width(), fromMs: nextFrom, toMs: nextTo });
    fromMs = nextFrom;
    toMs = nextTo;
    render();
  });
  el('reset').onclick = guard(() => {
    fromMs = model.startMs;
    toMs = model.endMs;
    render();
  });
  el('zoom').onclick = guard(() => {
    const span = (toMs - fromMs) / 4;
    fromMs += span;
    toMs -= span;
    render();
  });
  el('search').oninput = guard(render);
  window.addEventListener('resize', guard(render));
  el('chart').onclick = guard((event) => {
    const segment = event.target.closest('[data-node]');
    if (segment) {
      const track = model.tracks[Number(segment.getAttribute('data-track'))];
      showFunction(track, Number(segment.getAttribute('data-node')));
      return;
    }
    const index = event.target.closest('[data-frame]')?.getAttribute('data-frame');
    if (index === undefined || index === null) return;
    const frame = model.frameIntervals[Number(index)];
    fromMs = frame.startMs;
    toMs = frame.endMs;
    render();
    el('frame-facts').textContent = JSON.stringify(
      {
        submittedPhaseFactsForEndingFrame: frame.submittedFacts,
        submitToCompleteMs: frame.current.renderSubmitToCompleteMs,
        boundary:
          'Measured owner wall durations joined by frame/world/device identity; not OS on-CPU or exclusive GPU duration. Submission can predate this completion interval. Raw whole-profile line ticks are not clipped to this frame.',
      },
      null,
      2,
    );
    el('selection').textContent =
      `Completion #${frame.current.frameId} | ${frame.completionGapMs.toFixed(3)} ms gap | ${frame.coverage} coverage | ${frame.missingIntermediateReceipts} missing receipts`;
    const table = document.createElement('table');
    const row = (values, heading = false) => {
      const tr = table.insertRow();
      for (const value of values) {
        const td = document.createElement(heading ? 'th' : 'td');
        td.textContent = String(value);
        tr.append(td);
      }
    };
    row(
      [
        'JS target',
        'Sampled ms',
        'Script ms',
        'GC ms',
        'Idle ms',
        'Unknown ms',
        'Top sampled leaf',
      ],
      true,
    );
    for (const thread of frame.threads) {
      const track = model.tracks.find((t) => t.target.targetId === thread.targetId);
      const top = thread.topSelf[0],
        node = top && track.nodes.find((n) => n.nodeId === top.nodeId);
      row([
        `${track.name} [${thread.targetId}]`,
        thread.sampledMs.toFixed(3),
        (thread.categories.script ?? 0).toFixed(3),
        (thread.categories.gc ?? 0).toFixed(3),
        (thread.categories.idle ?? 0).toFixed(3),
        thread.unobservedMs.toFixed(3),
        node
          ? `${node.source?.functionName || node.functionName || '(anonymous)'} (${top.sampledSelfMs.toFixed(3)} ms)`
          : 'not observed',
      ]);
    }
    el('detail').replaceChildren(table);
  });
  const download = (blob, name) => {
    const url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  el('svg').onclick = guard(() =>
    download(new Blob([svg], { type: 'image/svg+xml' }), 'cpu-timeline.svg'),
  );
  el('png').onclick = guard(async () => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (image.width * image.height > 64000000 || image.height > 16000)
        throw new Error('PNG is too large; narrow the range or export SVG');
      const canvas = document.createElement('canvas');
      canvas.width = image.width * 2;
      canvas.height = image.height * 2;
      if (canvas.width * canvas.height > 64000000 || canvas.height > 16000) {
        canvas.width = image.width;
        canvas.height = image.height;
      }
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG encoding failed; export SVG instead');
      download(blob, 'cpu-timeline.png');
    } finally {
      URL.revokeObjectURL(url);
    }
  });
  accept(
    initial,
    initialView.fromMs !== undefined || initialView.toMs !== undefined
      ? initialView
      : (initial.initialView ?? {}),
  );
}

/** Aggregate clipped sample weights; visits are samples, never invocation counts. */
function cpuSampleCallerChain(source, nodeId) {
  if (!source.has(nodeId)) throw Error('Unknown sampled call-tree node');
  const chain = [],
    seen = new Set();
  for (let n = source.get(nodeId); n; n = source.get(n.parentNodeId)) {
    if (seen.has(n.nodeId)) throw Error('Cyclic call-tree parents');
    seen.add(n.nodeId);
    if (n.functionName !== '(root)') chain.push(n);
    if (n.parentNodeId !== null && !source.has(n.parentNodeId))
      throw Error('Unknown call-tree parent');
  }
  if (!chain.length)
    chain.push({
      ...source.get(nodeId),
      functionName: '(unattributed stack)',
      source: null,
    });
  return chain;
}

export function cpuTimelineCallTrees(
  model,
  fromMs,
  toMs,
  { direction = 'top-down', includeIdle = false } = {},
) {
  if (
    !['top-down', 'bottom-up'].includes(direction) ||
    !Number.isFinite(fromMs) ||
    !Number.isFinite(toMs) ||
    toMs <= fromMs ||
    fromMs < model.startMs ||
    toMs > model.endMs
  )
    throw Error('Invalid call-tree direction/range');
  return model.tracks.map((track) => {
    const source = new Map(track.nodes.map((n) => [n.nodeId, n])),
      root = {
        id: 0,
        parentId: null,
        label: track.name,
        totalMs: 0,
        selfMs: 0,
        samples: 0,
        selfSamples: 0,
        children: [],
      },
      nodes = [root],
      prefixes = new Map();
    for (const sample of track.samples) {
      const ms = Math.max(0, Math.min(toMs, sample.endMs) - Math.max(fromMs, sample.startMs));
      if (!ms || (!includeIdle && sample.category === 'idle')) continue;
      const chain = cpuSampleCallerChain(source, sample.nodeId);
      if (direction === 'top-down') chain.reverse();
      root.totalMs += ms;
      root.samples++;
      let parent = root;
      for (const [index, frame] of chain.entries()) {
        const identity =
          direction === 'top-down'
            ? String(frame.nodeId)
            : JSON.stringify([
                frame.scriptId,
                frame.functionName,
                frame.url,
                frame.lineNumber,
                frame.columnNumber,
              ]);
        const key = parent.id + '|' + identity;
        let row = prefixes.get(key);
        if (!row) {
          row = {
            id: nodes.length,
            parentId: parent.id,
            nodeId: frame.nodeId,
            label: frame.source?.functionName || frame.functionName || '(anonymous)',
            callFrame: frame,
            source: frame.source ?? null,
            totalMs: 0,
            selfMs: 0,
            samples: 0,
            selfSamples: 0,
            children: [],
          };
          nodes.push(row);
          parent.children.push(row.id);
          prefixes.set(key, row);
        }
        row.totalMs += ms;
        row.samples++;
        if (direction === 'top-down' ? index === chain.length - 1 : index === 0) {
          row.selfMs += ms;
          row.selfSamples++;
        }
        parent = row;
      }
    }
    for (const row of nodes)
      row.children.sort((a, b) => nodes[b].totalMs - nodes[a].totalMs || a - b);
    return {
      targetId: track.target.targetId,
      name: track.name,
      direction,
      fromMs,
      toMs,
      includeIdle,
      rootId: 0,
      nodes,
      interpretation:
        direction === 'top-down'
          ? 'Idle samples are excluded by default. Total includes descendant sampled work; Self is leaf sampled work. One call-tree context aggregates scattered visits; recursion levels remain distinct. Samples are not calls.'
          : 'Idle samples are excluded by default. Roots group sampled leaf self costs by function; descendants distribute that same leaf cost across caller paths. Total is attributed leaf-self cost, not inclusive caller runtime. Samples are not calls.',
    };
  });
}

export function cpuCallTreeSvg(
  model,
  {
    fromMs = model.startMs,
    toMs = model.endMs,
    direction = 'top-down',
    width = 2400,
    maxRows = 150,
  } = {},
) {
  const trees = cpuTimelineCallTrees(model, fromMs, toMs, { direction }),
    rows = [];
  for (const tree of trees) {
    rows.push({
      label: tree.name,
      depth: 0,
      totalMs: tree.nodes[0].totalMs,
      selfMs: 0,
      samples: tree.nodes[0].samples,
      heading: true,
    });
    const pending = tree.nodes[0].children
      .slice()
      .reverse()
      .map((id) => ({ id, depth: 1 }));
    let count = 0;
    while (pending.length && count < maxRows) {
      const { id, depth } = pending.pop(),
        node = tree.nodes[id];
      rows.push({ ...node, depth });
      count++;
      for (const child of node.children.slice().reverse())
        pending.push({ id: child, depth: depth + 1 });
    }
    if (pending.length)
      rows.push({
        label: 'More nodes available in full JSON and interactive HTML',
        depth: 1,
        totalMs: 0,
        selfMs: 0,
        samples: 0,
      });
  }
  const escape = (v) =>
      String(v)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    height = 180 + rows.length * 23;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>text{font:12px ui-monospace,monospace;fill:#dce8f7}</style><rect width="100%" height="100%" fill="#0c1421"/><text x="24" y="32" font-size="20">CPU / AGGREGATED CALL TREE / ${escape(direction)}</text><text x="24" y="58">${fromMs.toFixed(3)} - ${toMs.toFixed(3)} ms | scattered visits aggregated by stack context | samples are not calls</text><text x="24" y="82">${escape(direction === 'top-down' ? 'Total includes descendants; Self is exclusive sampled leaf cost.' : 'Total distributes leaf self cost across caller paths; it is not inclusive caller duration.')}</text><text x="24" y="110">FUNCTION / STACK PATH</text><text x="${width - 340}" y="110">${direction === 'top-down' ? 'TOTAL ms' : 'LEAF COST ms'}</text><text x="${width - 220}" y="110">${direction === 'top-down' ? 'SELF ms' : 'VIA CALLERS'}</text><text x="${width - 110}" y="110">SAMPLES</text>`,
  ];
  rows.forEach((row, i) => {
    const y = 137 + i * 23,
      x = 24 + Math.min(row.depth, 25) * 17,
      label = row.label.slice(0, Math.max(10, Math.floor((width - 400 - x) / 7)));
    svg.push(
      `<g><title>${escape(row.label + ' | ' + (row.source ? row.source.file + ':' + row.source.line : (row.callFrame?.url ?? '')))}</title><text x="${x}" y="${y}" ${row.heading ? 'font-weight="700" fill="#77dbce"' : ''}>${escape(label)}</text><text x="${width - 340}" y="${y}">${row.totalMs.toFixed(4)}</text><text x="${width - 220}" y="${y}">${direction === 'top-down' ? row.selfMs.toFixed(4) : '-'}</text><text x="${width - 110}" y="${y}">${row.samples}</text></g>`,
    );
  });
  svg.push(
    `<text x="24" y="${height - 14}">Per-target sampled estimates; nested totals overlap. Native scheduling and GPU time require separate evidence.</text></svg>`,
  );
  return svg.join('');
}
