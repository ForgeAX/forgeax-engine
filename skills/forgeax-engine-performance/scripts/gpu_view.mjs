import * as client from './gpu_view_client.mjs';
import { gpuResourceTree, gpuGraph, validateGpuReport } from './gpu_model.mjs';
const json = (v) =>
  JSON.stringify(v)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
const escape = (s) =>
  String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export function gpuReportHtml(report, runtime) {
  const browser = [...Object.values(client), gpuResourceTree, gpuGraph, validateGpuReport]
    .map((fn) => fn.toString())
    .join('\n');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GPU capture workbench</title><style>
 :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;color:#dfebfb;background:#101a28;font:14px/1.5 system-ui}header{padding:22px 28px 14px;background:#132234;border-bottom:1px solid #34465e}h1{font-size:25px;margin:0 0 5px}h2{font-size:17px;margin:12px 0}small,.hint{color:#a9bdd6}#capture{font:11px ui-monospace;overflow-wrap:anywhere}#tiles{display:flex;gap:12px;margin:16px 0}#tiles>div{flex:1;background:#1c3047;border:1px solid #36516e;border-radius:8px;padding:12px 16px}#tiles strong{display:block;font-size:23px}button,input,select,a{font:inherit;color:inherit;background:#20364f;border:1px solid #4e6988;border-radius:5px;padding:6px 10px}button,a{cursor:pointer}button:hover{background:#315171}button:disabled{opacity:.4;cursor:default}button[aria-selected=true]{background:#327e78;border-color:#68c6b5}input[type=search]{min-width:260px}input[type=checkbox]{vertical-align:middle}.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}nav{display:flex;gap:8px}main{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:18px;padding:10px 28px 28px}section{min-width:0}aside{padding:0 12px;border-left:1px solid #34465e;min-width:0}#details,#facts,#graph-hover{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace;max-height:620px;overflow:auto}#related{max-height:180px;overflow:auto}#related button{font-size:12px;margin:3px}#treemap{height:540px}#graph{height:650px;border:1px solid #34465e;border-radius:8px}#lifetime{height:720px}table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;color:#a9bdd6;background:#1c3047;position:sticky;top:0}td,th{padding:8px 10px;border-bottom:1px solid #2a3f57}tr:hover, tr:focus{background:#27445f;cursor:pointer}td:first-child{max-width:430px;overflow-wrap:anywhere}.table-wrap{max-height:420px;overflow:auto}#error{color:#ffb3a3;white-space:pre-wrap}label{display:inline-flex;gap:5px;align-items:center}[hidden]{display:none!important}details{margin-top:12px}a{text-decoration:none;display:inline-block}@media(max-width:1050px){main{grid-template-columns:1fr}aside{border-left:0;border-top:1px solid #34465e}#tiles{flex-wrap:wrap}#tiles>div{flex-basis:30%}header,main{padding-left:16px;padding-right:16px}}
 </style><header><h1>GPU capture workbench</h1><div class="hint">Captured resources → actual bindings and attachments → selected work and shaders</div><div id="capture"></div><div id="tiles"></div><div class="toolbar"><label>Open GPU report <input id="load" type="file" accept=".json"></label><button id="export-data">Download AI data</button><a href="gpu.svg" target="_blank">Static overview</a></div><p class="hint">Descriptor payload ≠ driver allocation or residency. Counts are observed API objects in this capture. Graph arrows show usage, not barriers or GPU scheduling.</p><nav><button data-tab="resources" aria-selected="true">Resources</button><button data-tab="pipeline">Pipeline / usage graph</button><button data-tab="lifetime">API resource spans</button></nav><div id="error" role="alert"></div></header>
 <main><div><div class="toolbar"><label>Search <input id="search" type="search" placeholder="Resource name, kind or ID"></label><label>State <select id="state"><option value="all">All observed</option><option value="live">Storage not destroyed</option><option value="destroyed">Storage API destroyed</option><option value="observed">Other observed objects</option></select></label></div>
 <section data-panel="resources"><div class="toolbar"><label>Area <select id="metric"><option value="bytes">Known bytes</option><option value="count">Object count</option></select></label><label>Hierarchy <select id="group"><option value="kind">Resource kind</option><option value="labels">Kind / label folders</option></select></label><button id="export-tree">Export tree PNG</button></div><div id="resource-summary" class="hint"></div><div id="treemap"></div><p class="hint">Wheel zoom · drag pan · click folders to drill down · breadcrumb to go up · click a resource for details. Unknown bytes remain in the table and count view.</p><div class="toolbar"><button id="prev">Previous</button><span id="page"></span><button id="next">Next</button></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Kind</th><th>Descriptor payload</th><th>Observation</th></tr></thead><tbody id="resource-rows"></tbody></table></div></section>
 <section data-panel="pipeline" hidden><div class="toolbar"><label>Pass <select id="pass"></select></label><label>Work <select id="work"></select></label><button id="fit">Fit / clear focus</button><label><input id="neighbors" type="checkbox" checked>Focus neighbors on click</label><button id="export-graph">Export graph PNG</button></div><div id="graph-status" class="hint"></div><div id="graph"></div><p class="hint">Cytoscape.js + ELK · wheel zoom · drag pan/nodes · click to inspect/focus · hover for IDs. Work selection shows shader stages and the captured resource bindings.</p><pre id="graph-hover"></pre></section>
 <section data-panel="lifetime" hidden><h2>Observed API resource spans</h2><p class="hint">X = event index, not milliseconds. Bootstrap creation and GPU retirement are unknown. An open right edge means no API destruction was observed before capture end.</p><button id="export-life">Export span PNG</button><div id="lifetime"></div></section>
 <details><summary>Identity, coverage, lifecycle summary and interpretation</summary><pre id="facts"></pre></details><details><summary>Visualization runtime licenses and provenance</summary><pre>${escape(runtime.notices)}</pre><pre>${escape(JSON.stringify(runtime.manifest, null, 2))}</pre></details></div>
 <aside><h2 id="details-title">Details</h2><div id="related"></div><pre id="details"></pre></aside></main>
 ${runtime.scripts.map((src) => `<script src="${src}"></script>`).join('')}
 <script type="module">const requireFact=(v,m)=>{if(!v)throw Error(m);};${browser}\n${graphUseSource()}\nmountGpuReport(${json(report)},gpuResourceTree,gpuGraph,validateGpuReport);</script></html>`;
}
// Keep this helper shared with graph projection through an explicit export rather than a second use algorithm.
import { graphUse } from './gpu_model.mjs';
const graphUseSource = () => graphUse.toString();

export function gpuOverviewSvg(report) {
  const rows = report.resources
    .filter((r) => r.storage)
    .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))
    .slice(0, 24);
  const width = 1600,
    height = 230 + rows.length * 36,
    max = Math.max(1, ...rows.map((r) => r.bytes ?? 0));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#101a28"/><g fill="#dfebfb" font-family="system-ui"><text x="28" y="42" font-size="27">GPU captured resource closure · largest descriptor payloads</text><text x="28" y="78" font-size="18">${report.summary.observedObjects} observed objects · ${report.summary.storageObjects} storage objects · ${report.summary.unknownStorageBytes} unknown storage byte estimates</text><text x="28" y="106" font-size="15">Descriptor bytes are not driver allocation/residency. Shared resource IDs are counted once. Views carry no storage bytes.</text><text x="28" y="132" font-size="12">${escape(report.identity.tapeDigest)}</text>${rows
    .map((r, i) => {
      const y = 158 + i * 36;
      return `<text x="28" y="${y + 20}" font-size="14">${escape(r.label.slice(0, 58))}</text><rect x="520" y="${y}" width="${r.bytes === null ? 0 : Math.max(2, (r.bytes / max) * 830)}" height="26" rx="4" fill="#49b9a9"/><text x="${r.bytes === null ? 520 : Math.min(1420, 530 + (r.bytes / max) * 830)}" y="${y + 19}" font-size="13">${r.bytes === null ? 'Unknown' : (r.bytes / 1048576).toFixed(3) + ' MiB'}</text>`;
    })
    .join(
      '',
    )}<text x="28" y="${height - 25}" font-size="13">${rows.length} of ${report.summary.storageObjects} storage objects shown · HTML contains the complete hierarchy, count view, graph and source details.</text></g></svg>`;
}
