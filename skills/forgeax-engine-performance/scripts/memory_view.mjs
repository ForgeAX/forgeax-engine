import { inspectMemory } from './memory_model.mjs';
import { decodeMemoryModel, encodeMemoryModel } from './memory_codec.mjs';

export function memoryBytes(n) {
  for (const [unit, scale] of [
    ['GiB', 1073741824],
    ['MiB', 1048576],
    ['KiB', 1024],
  ])
    if (n >= scale) return (n / scale).toFixed(2) + ' ' + unit;
  return n + ' B';
}
export function memorySvg(model, nodeId = model.rootId, { width = 1800, limit = 24 } = {}) {
  const detail = inspectMemory(model, nodeId, { limit }),
    node = detail.node;
  const escape = (v) =>
    String(v)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const rows = [
    ...(node.selfBytes
      ? [
          {
            ...node,
            label: 'Self at this node',
            totalBytes: node.selfBytes,
            totalCount: node.selfCount,
          },
        ]
      : []),
    ...detail.children,
  ];
  const height = 275 + Math.max(1, rows.length) * 43;
  const text = (x, y, s, extra = '') => `<text x="${x}" y="${y}" ${extra}>${escape(s)}</text>`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Memory hierarchy"><style>text{font:13px ui-monospace,monospace;fill:#dce8f7}</style><rect width="100%" height="100%" fill="#0c1421"/>`,
    text(28, 35, 'MEMORY / HIERARCHY', 'font-size="21" font-weight="700"'),
    text(
      28,
      65,
      model.mode +
        ' | ' +
        memoryBytes(node.totalBytes) +
        ' | ' +
        node.totalCount +
        ' ' +
        model.countLabel,
    ),
    text(
      28,
      92,
      detail.path
        .map((p) => p.label)
        .join(' / ')
        .slice(-195),
    ),
    text(
      28,
      119,
      model.mode === 'sampled-allocation-stack'
        ? 'Estimated allocation bytes; recorded samples are not all allocations or exact object counts.'
        : 'Snapshot shallow bytes grouped by type/name/id; folder totals are not retained dominator sizes.',
    ),
    text(
      28,
      145,
      `Showing ${detail.children.length}/${detail.childCount} children; full hierarchy and records remain in JSON/HTML.`,
    ),
    text(28, 175, 'NAME'),
    text(width * 0.35, 175, 'SUBTREE BYTES / SHARE OF SELECTED NODE'),
  ];
  rows.forEach((r, i) => {
    const y = 195 + i * 43,
      share = node.totalBytes ? r.totalBytes / node.totalBytes : 0;
    svg.push(
      `<g><title>${escape(r.label + ' | ' + r.totalBytes + ' bytes | ' + r.totalCount + ' ' + model.countLabel)}</title>`,
      text(28, y + 18, r.label.slice(0, Math.floor((width * 0.34 - 40) / 8))),
      `<rect x="${width * 0.35}" y="${y}" width="${Math.max(0, Math.min(1, share)) * (width * 0.52)}" height="25" rx="3" fill="${r.type === 'group' ? '#4d76a9' : '#39a9a4'}"/>`,
      text(
        width * 0.88,
        y + 18,
        memoryBytes(r.totalBytes) + ' / ' + (share * 100).toFixed(1) + '%',
      ),
      '</g>',
    );
  });
  if (!rows.length)
    svg.push(
      text(28, 220, 'No child nodes; inspect the selected node records/references in HTML or CLI.'),
    );
  svg.push(
    text(28, height - 43, 'Input SHA256: ' + (model.input?.sha256 ?? 'not supplied')),
    text(
      28,
      height - 20,
      'Offline inspection. Read capture metadata before comparing bytes, populations or runtime overhead.',
    ),
    '</svg>',
  );
  return svg.join('');
}

export function mountMemoryExplorer(initial) {
  const style = document.createElement('style');
  style.textContent =
    'body{margin:0;background:#0c1421;color:#dce8f7;font:14px/1.5 system-ui}header,section,nav{padding:18px 28px}header{background:#132238}h1{margin:0}button,input{font:inherit;background:#20344e;color:#e6f2ff;border:1px solid #42617f;padding:7px 10px;border-radius:5px;margin:3px}button{cursor:pointer}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #273d55;padding:8px}tbody tr{cursor:pointer}tbody tr:hover{background:#1c3048}small{color:#9ab3ca}pre{white-space:pre-wrap;max-height:350px;overflow:auto;background:#122136;padding:14px}#chart svg{width:100%;height:auto}#crumbs button{color:#7adbcf}#error{color:#ffac94}.bar{height:7px;background:#3aa7a5;max-width:100%}';
  document.head.append(style);
  document.body.innerHTML =
    '<header><h1>Memory explorer</h1><p id="status"></p><small id="interpretation"></small></header><nav><label>Open normalized memory JSON <input type="file" id="load" accept=".json"></label><button id="root">Root</button><button id="up">Up</button><input id="search" placeholder="Find function, source, type or object id"><button id="blocks">Blocks</button><button id="folders">Folders</button><button id="svg">Export SVG</button><button id="png">Export PNG</button><div id="crumbs"></div><p id="error"></p></nav><section id="chart"></section><section><h2 id="heading"></h2><p id="counts"></p><button id="previous">Previous page</button><button id="next">Next page</button><table><thead><tr><th>Name</th><th>Subtree bytes</th><th>Self bytes</th><th id="count-label"></th></tr></thead><tbody id="rows"></tbody></table><h3>Selected node</h3><pre id="selected"></pre><h3>Recorded allocation samples</h3><button id="detail-previous">Previous details</button><button id="detail-next">Next details</button><small id="detail-page"></small><pre id="records"></pre><h3>Object references (outgoing / incoming)</h3><small>Raw graph edges, not dominator retention. Weak edges do not keep a target alive.</small><div id="refs"></div></section>';
  const el = (id) => document.getElementById(id);
  let model,
    current,
    offset = 0,
    detailOffset = 0,
    matches = null,
    view = 'blocks';
  const currentSvg = () =>
    view === 'blocks'
      ? memoryTreemapSvg(model, current)
      : memorySvg(model, current, { width: 1800 });
  const pageSize = 100;
  const guard =
    (fn) =>
    async (...args) => {
      try {
        await fn(...args);
        el('error').textContent = '';
      } catch (e) {
        el('error').textContent = e.message;
      }
    };
  const jump = (id) => {
    current = id;
    offset = 0;
    detailOffset = 0;
    matches = null;
    el('search').value = '';
    render();
  };
  const render = () => {
    const detail = inspectMemory(model, current, { offset, limit: pageSize }),
      node = detail.node;
    el('status').textContent =
      model.mode +
      ' | ' +
      memoryBytes(model.summary.totalBytes) +
      ' | ' +
      model.summary.totalCount +
      ' ' +
      model.countLabel +
      (model.summary.orphanSamples
        ? ` | Unresolved owners: ${model.summary.orphanSamples} sample records / ${memoryBytes(model.summary.orphanSampleBytes)} reported sample bytes (separate budget)`
        : '');
    el('interpretation').textContent = model.interpretation.join(' ');
    el('chart').innerHTML = currentSvg();
    el('crumbs').replaceChildren();
    for (const part of detail.path) {
      const b = document.createElement('button');
      b.textContent = part.label;
      b.onclick = () => jump(part.id);
      el('crumbs').append(b);
    }
    el('heading').textContent = node.label;
    el('selected').textContent = JSON.stringify(node, null, 2);
    const extra = inspectMemory(model, current, { offset: detailOffset, limit: pageSize });
    el('records').textContent = JSON.stringify(extra.records, null, 2);
    const detailTotal = Math.max(extra.records.total, extra.outgoing.total, extra.incoming.total);
    el('detail-page').textContent =
      ` Detail offset ${detailOffset}, up to ${pageSize} rows per section`;
    el('detail-previous').disabled = detailOffset === 0;
    el('detail-next').disabled = detailOffset + pageSize >= detailTotal;
    el('count-label').textContent = model.countLabel;
    const list = matches ? matches.slice(offset, offset + pageSize) : detail.children,
      total = matches ? matches.length : detail.childCount;
    el('counts').textContent =
      `${matches ? 'Search results across the full capture' : 'Children'}: ${offset + 1}-${Math.min(offset + pageSize, total)} of ${total}; ${memoryBytes(node.selfBytes)} self / ${memoryBytes(node.totalBytes)} subtree`;
    el('rows').replaceChildren();
    for (const child of list) {
      const tr = document.createElement('tr'),
        title = child.source
          ? `${child.source.file}:${child.source.line}:${child.source.column}`
          : child.callFrame
            ? `${child.callFrame.url}:${child.callFrame.lineNumber + 1}`
            : child.id;
      tr.title = title;
      for (const text of [
        child.label,
        memoryBytes(child.totalBytes),
        memoryBytes(child.selfBytes),
        child.totalCount,
      ]) {
        const td = document.createElement('td');
        td.textContent = String(text);
        tr.append(td);
      }
      tr.dataset.node = child.id;
      tr.onclick = () => jump(child.id);
      el('rows').append(tr);
    }
    el('previous').disabled = offset === 0;
    el('next').disabled = offset + pageSize >= total;
    el('refs').replaceChildren();
    for (const [direction, edges] of [
      ['Outgoing', extra.outgoing],
      ['Incoming', extra.incoming],
    ]) {
      const p = document.createElement('p');
      p.textContent = `${direction}: ${edges.total} edges (showing ${edges.rows.length})`;
      el('refs').append(p);
      for (const edge of edges.rows) {
        const b = document.createElement('button');
        b.textContent = `${edge[2]} ${edge[3]} -> ${direction === 'Outgoing' ? edge[1] : edge[0]}`;
        b.onclick = () => jump(direction === 'Outgoing' ? edge[1] : edge[0]);
        el('refs').append(b);
      }
    }
  };
  const accept = (next) => {
    next = decodeMemoryModel(next);
    inspectMemory(next);
    model = next;
    let node = next.nodes.find((n) => n.id === next.rootId);
    for (let i = 0; i < 12 && node.selfBytes === 0 && node.children.length === 1; i++)
      node = next.nodes.find((n) => n.id === node.children[0]);
    jump(next.initialNodeId ?? node.id);
  };
  el('blocks').onclick = () => {
    view = 'blocks';
    render();
  };
  el('folders').onclick = () => {
    view = 'folders';
    render();
  };
  el('chart').onclick = (e) => {
    const group = e.target.closest('g[data-memory-node]');
    if (!group) return;
    if (group.dataset.memoryOffset !== undefined) {
      current = group.dataset.memoryNode;
      offset = Number(group.dataset.memoryOffset);
      detailOffset = 0;
      matches = null;
      view = 'folders';
      el('search').value = '';
      render();
    } else jump(group.dataset.memoryNode);
  };
  el('root').onclick = () => jump(model.rootId);
  el('up').onclick = () => {
    const n = model.nodes.find((n) => n.id === current);
    if (n.parentId !== null) jump(n.parentId);
  };
  el('previous').onclick = () => {
    offset = Math.max(0, offset - pageSize);
    render();
  };
  el('next').onclick = () => {
    offset += pageSize;
    render();
  };
  el('detail-previous').onclick = () => {
    detailOffset = Math.max(0, detailOffset - pageSize);
    render();
  };
  el('detail-next').onclick = () => {
    detailOffset += pageSize;
    render();
  };
  el('search').oninput = () => {
    const query = el('search').value.toLowerCase();
    matches = query
      ? model.nodes
          .filter((n) =>
            (n.label + ' ' + n.id + ' ' + JSON.stringify(n.source ?? n.callFrame ?? ''))
              .toLowerCase()
              .includes(query),
          )
          .sort((a, b) => b.totalBytes - a.totalBytes)
      : null;
    offset = 0;
    render();
  };
  el('load').onchange = guard(async (e) => {
    if (e.target.files[0]) accept(JSON.parse(await e.target.files[0].text()));
  });
  const download = (blob, name) => {
    const a = document.createElement('a'),
      url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  el('svg').onclick = () =>
    download(new Blob([currentSvg()], { type: 'image/svg+xml' }), 'memory.svg');
  el('png').onclick = guard(async () => {
    const svg = currentSvg(),
      url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw Error('PNG encoding failed');
      download(blob, 'memory.png');
    } finally {
      URL.revokeObjectURL(url);
    }
  });
  accept(initial);
}

export function memoryHtml(model, inspectSource, serialized) {
  const data = (serialized ?? JSON.stringify(encodeMemoryModel(model))).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Memory explorer</title><body><script id="memory-data" type="application/json">${data}</script><script type="module">function requireFact(ok,message){if(!ok)throw Error(message);}\n${inspectSource}\n${decodeMemoryModel.toString()}\n${memoryBytes.toString()}\n${memorySvg.toString()}\n${memoryTreemapRects.toString()}\n${memoryTreemapSvg.toString()}\n${mountMemoryExplorer.toString()}\nconst payload=document.getElementById('memory-data');let initial=JSON.parse(payload.textContent);payload.textContent='';payload.remove();mountMemoryExplorer(initial);initial=null;</script></body></html>`;
}

/** Squarified layout: positive weights partition the supplied area without inventing mass. */
export function memoryTreemapRects(items, width, height) {
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0 ||
    items.some((n) => !Number.isFinite(n.weight) || n.weight < 0)
  )
    throw Error('Invalid treemap dimensions/weights');
  const total = items.reduce((sum, n) => sum + n.weight, 0);
  if (total <= 0) return [];
  const rest = items
    .filter((n) => n.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .map((n) => ({ ...n, area: (n.weight / total) * width * height }));
  let x = 0,
    y = 0,
    w = width,
    h = height,
    row = [];
  const output = [];
  const worst = (list, side) => {
    if (!list.length) return Infinity;
    const sum = list.reduce((s, n) => s + n.area, 0),
      max = Math.max(...list.map((n) => n.area)),
      min = Math.min(...list.map((n) => n.area));
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  const place = () => {
    const area = row.reduce((s, n) => s + n.area, 0);
    if (w >= h) {
      const rw = area / h;
      let yy = y;
      for (const n of row) {
        const rh = n.area / rw;
        output.push({ ...n, x, y: yy, width: rw, height: rh });
        yy += rh;
      }
      x += rw;
      w = Math.max(0, w - rw);
    } else {
      const rh = area / w;
      let xx = x;
      for (const n of row) {
        const rw = n.area / rh;
        output.push({ ...n, x: xx, y, width: rw, height: rh });
        xx += rw;
      }
      y += rh;
      h = Math.max(0, h - rh);
    }
    row = [];
  };
  while (rest.length) {
    const next = rest[0],
      side = Math.min(w, h);
    if (!row.length || worst([...row, next], side) <= worst(row, side)) {
      row.push(next);
      rest.shift();
    } else place();
  }
  if (row.length) place();
  return output;
}

export function memoryTreemapSvg(
  model,
  nodeId = model.rootId,
  { width = 1800, height = 1000, depth = 3 } = {},
) {
  const byId = new Map(model.nodes.map((n) => [n.id, n])),
    selected = byId.get(nodeId),
    detail = inspectMemory(model, nodeId, { limit: 1 });
  const escape = (v) =>
    String(v)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const text = (x, y, s, extra = '') => `<text x="${x}" y="${y}" ${extra}>${escape(s)}</text>`;
  const color = (id) => {
    let hash = 0;
    for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) | 0;
    hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
    return `hsl(${Math.abs(hash) % 360} 42% 35%)`;
  };
  let clipIndex = 0;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Memory treemap"><style>text{pointer-events:none;font:13px ui-monospace,monospace;fill:#eef5ff}g[data-memory-node]{cursor:pointer}g[data-memory-node]:hover>rect{stroke:#fff;stroke-width:2}</style><rect width="100%" height="100%" fill="#0c1421"/>`,
    text(25, 34, 'MEMORY / TREEMAP', 'font-size="21" font-weight="700"'),
    text(
      25,
      62,
      model.mode +
        ' | area = subtree bytes | ' +
        memoryBytes(selected.totalBytes) +
        ' | ' +
        selected.totalCount +
        ' ' +
        model.countLabel,
    ),
    text(
      25,
      88,
      detail.path
        .map((n) => n.label)
        .join(' / ')
        .slice(-200),
    ),
    text(
      25,
      114,
      'Nested blocks share one hierarchy with the folder view. Click to zoom; exact values and full paths remain inspectable.',
    ),
  ];
  const draw = (node, x, y, w, h, level) => {
    let children = node.children
      .map((id) => byId.get(id))
      .filter((n) => n.totalBytes > 0)
      .map((n) => ({ node: n, label: n.label, weight: n.totalBytes }));
    if (node.selfBytes > 0)
      children.unshift({ node, label: 'Self: ' + node.label, weight: node.selfBytes, self: true });
    children.sort((a, b) => b.weight - a.weight);
    if (children.length > 40) {
      const tail = children.slice(39);
      children = [
        ...children.slice(0, 39),
        {
          node,
          label: `Other ${tail.length} entries (browse/search folders)`,
          weight: tail.reduce((s, n) => s + n.weight, 0),
          self: true,
          aggregate: true,
          offset: children.slice(0, 39).filter((n) => !n.self).length,
        },
      ];
    }
    for (const cell of memoryTreemapRects(children, w, h)) {
      const xx = x + cell.x,
        yy = y + cell.y,
        n = cell.node,
        cw = Math.max(0, cell.width - 1),
        ch = Math.max(0, cell.height - 1);
      svg.push(
        `<g data-memory-node="${escape(n.id)}"${cell.aggregate ? ` data-memory-offset="${cell.offset}"` : ''}><title>${escape(cell.label + ' | ' + memoryBytes(cell.weight) + ' | ' + n.id + (cell.aggregate ? ' | aggregated display; all children retained in data' : ''))}</title><rect x="${xx}" y="${yy}" width="${cw}" height="${ch}" fill="${color(n.id + (cell.self ? 'self' : ''))}" stroke="#0c1421"/>`,
      );
      const clip = 'memory-cell-' + clipIndex++;
      svg.push(
        `<defs><clipPath id="${clip}"><rect x="${xx + 3}" y="${yy + 2}" width="${Math.max(0, cw - 6)}" height="${Math.min(ch, 37)}"/></clipPath></defs>`,
      );
      if (cw > 65 && ch > 17)
        svg.push(
          text(
            xx + 5,
            yy + 15,
            cell.label.slice(0, Math.max(1, Math.floor((cw - 10) / 8))),
            `clip-path="url(#${clip})"`,
          ),
        );
      if (cw > 65 && ch > 36)
        svg.push(
          text(
            xx + 5,
            yy + 31,
            memoryBytes(cell.weight),
            `font-size="11" clip-path="url(#${clip})"`,
          ),
        );
      if (!cell.self && level < depth && n.children.length && cw > 85 && ch > 85)
        draw(n, xx + 3, yy + 39, cw - 6, ch - 42, level + 1);
      svg.push('</g>');
    }
  };
  if (selected.totalBytes > 0) draw(selected, 22, 140, width - 44, height - 193, 1);
  else
    svg.push(
      text(25, 175, 'This node has no byte area; counts and children remain available in folders.'),
    );
  svg.push(
    text(
      25,
      height - 31,
      `Depth ${depth}; small branches stop at their parent; >40 siblings aggregate the tail for display. Full data is never truncated.`,
    ),
    text(25, height - 11, 'Input SHA256: ' + (model.input?.sha256 ?? 'not supplied')),
    '</svg>',
  );
  return svg.join('');
}
