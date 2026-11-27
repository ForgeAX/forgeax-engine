import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderStartupCover, STARTUP_COVER_STYLES } from '@forgeax/engine-app';
import { createBlitzUi, gpuShaders } from '@forgeax/engine-ui-blitz';

const wasmUrl = new URL(
  './pkg/ui_blitz_bg.wasm',
  import.meta.resolve('@forgeax/engine-ui-blitz/package.json'),
);
let wasmBytes;
const wasm = {
  readWasm: () => wasmBytes ??= readFile(wasmUrl),
  async instantiate(imports) {
    return WebAssembly.instantiate(await wasm.readWasm(), imports);
  },
};

const html = (startup) => `<!doctype html><html><head><style>
${startup ? STARTUP_COVER_STYLES : ''}
#forgeax-loading{font-family:Preview}
#forgeax-loading[data-entered]{display:none}
#panel[data-loading]{display:none}
#sponza-startup-stages{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 24px}
.sponza-startup-stage{display:flex;justify-content:space-between;gap:12px;color:#b9c3d2;font-size:13px}
.sponza-startup-stage[data-state="active"]{color:#ffc3a7}
@media(max-width:600px){#sponza-startup-stages{grid-template-columns:1fr}}

html,body{margin:0;background:transparent;font-family:Preview;font-size:14px;color:#edf3ff}
#panel{position:absolute;left:18px;top:18px;width:370px;padding:14px;background:#122033;border:1px solid #405674;border-radius:12px}
h1{font-size:19px;margin:0 0 6px}p{margin:6px 0;line-height:1.4;color:#bbcce2}
.header{display:flex;align-items:center;justify-content:space-between;gap:8px}.header h1{margin:0}
#toggle-panel{padding:6px 8px}
#panel[data-collapsed="true"]{width:auto;padding:0;background:transparent;border:0}
#panel[data-collapsed="true"] h1,#panel[data-collapsed="true"] #panel-content{display:none}
.row{display:flex;gap:7px;margin:6px 0;flex-wrap:wrap}
button{background:#24384f;color:#edf3ff;border:1px solid #57718f;border-radius:6px;padding:9px 10px;font-family:Preview;font-size:13px}
button[aria-pressed="true"]{background:#23665c;border-color:#85e0cb;color:#ffffff}
#status{font-size:12px;color:#9edbcf}#exposure{color:#ffffff}
</style></head><body>
${startup ? renderStartupCover('Sponza', undefined, 'Preparing graphics').replace(
  '<div id="forgeax-loading-row">',
  '<div id="sponza-startup-stages"></div><div id="forgeax-loading-row">',
) : ''}
<div id="panel" data-collapsed="true"${startup ? ' data-loading' : ''}>
<div class="header"><h1>Sponza · Native GI</h1><button id="toggle-panel" aria-expanded="false" aria-controls="panel-content">Show controls</button></div>
<div id="panel-content"><p>GI mode · selected button is highlighted</p>
<div class="row"><button id="off">1 · Off</button><button id="irradiance-field">2 · Irradiance Field</button><button id="screen-probe">3 · Screen Probe</button></div>
<div class="row"><button id="toggle-hardware">H · Hardware RT allowed</button></div><p id="traversal"></p>
<div class="row"><button id="toggle-exposure">F · Auto exposure</button><button id="exposure-down">[ · EV −</button><button id="exposure-up">] · EV +</button></div>
<p id="exposure"></p><p id="status">Preparing renderer…</p>
<div class="row"><button id="reset-camera">R · Reset camera</button></div>
<p>WASD move · Q/E down/up · Shift faster<br>Hold right mouse + drag to look · arrows also look<br>Left click buttons · Escape closes</p>
</div></div></body></html>`;

/** Native host supplies WASM bytes and its installed system font; no global DOM. */
export async function createNativeSponzaUi(facts, enqueue, onError, startup = false) {
  const font = await readFile(join(process.env.SystemRoot ?? 'C:/Windows', 'Fonts', 'segoeui.ttf'));
  const ui = await createBlitzUi({
    wasm,
    html: html(startup), font, fontFamily: 'Preview', width: facts.width, height: facts.height,
    pixelRatio: facts.scaleFactor, onError,
  });
  const commands = ['off', 'irradiance-field', 'screen-probe', 'toggle-hardware', 'toggle-exposure', 'exposure-down', 'exposure-up', 'reset-camera'];
  const elements = new Map(commands.map((id) => {
    const element = ui.document.getElementById(id);
    if (!element) throw new Error(`Missing native preview control: ${id}`);
    element.addEventListener('click', () => enqueue(id, 'button'));
    return [id, element];
  }));
  const exposureLabel = ui.document.getElementById('exposure');
  const statusLabel = ui.document.getElementById('status');
  const traversalLabel = ui.document.getElementById('traversal');
  if (!exposureLabel || !statusLabel || !traversalLabel) throw new Error('Missing native preview status labels');
  const panel = ui.document.getElementById('panel');
  const togglePanel = ui.document.getElementById('toggle-panel');
  if (!panel || !togglePanel) throw new Error('Missing native preview panel toggle');
  togglePanel.addEventListener('click', () => {
    const expanded = togglePanel.getAttribute('aria-expanded') !== 'true';
    panel.setAttribute('data-collapsed', String(!expanded));
    togglePanel.setAttribute('aria-expanded', String(expanded));
    togglePanel.textContent = expanded ? 'Hide controls' : 'Show controls';
  });
  elements.set('toggle-panel', togglePanel);
  const cover = ui.document.getElementById('forgeax-loading');
  const progress = ui.document.getElementById('forgeax-loading-progress');
  const fill = ui.document.getElementById('forgeax-loading-fill');
  const activity = ui.document.getElementById('forgeax-loading-status');
  const detail = ui.document.getElementById('forgeax-loading-detail');
  const meta = ui.document.getElementById('forgeax-loading-meta');
  const list = ui.document.getElementById('sponza-startup-stages');
  const timingRows = new Map();
  const text = (element, value) => {
    if (element.textContent !== value) element.textContent = value;
  };
  let previous;
  return {
    updateStartup(snapshot) {
      if (!cover || !progress || !fill || !activity || !detail || !meta || !list) return;
      if (snapshot.outcome === 'ready') {
        cover.setAttribute('data-entered', '');
        panel.removeAttribute('data-loading');
        return;
      }
      const view = snapshot.progress;
      text(activity, view.activity);
      text(detail, view.detail);
      text(meta, `${view.percent}% · ${view.elapsed}`);
      progress.setAttribute('aria-valuenow', String(view.percent));
      fill.setAttribute('style', `width: ${view.percent}%`);
      for (const stage of snapshot.stages) {
        let row = timingRows.get(stage.id);
        if (!row) {
          const root = ui.document.createElement('div');
          root.setAttribute('class', 'sponza-startup-stage');
          const name = ui.document.createElement('span');
          name.textContent = stage.label;
          const time = ui.document.createElement('span');
          root.appendChild(name);
          root.appendChild(time);
          list.appendChild(root);
          row = { root, time };
          timingRows.set(stage.id, row);
        }
        row.root.setAttribute('data-state', stage.state);
        text(row.time, stage.elapsedMs === undefined ? 'Pending' : `${(stage.elapsedMs / 1000).toFixed(1)} s`);
      }
    },
    ui,
    rendererUi: { kind: /** @type {const} */ ('sparse-strips'), shaders: gpuShaders, paint: (time) => ui.paintGpu(time) },
    update({ mode, automatic, ev, giState, fieldState, exposureState, hardwareRayTracing = true, traversal = 'preparing', traversalFallback }) {
      const key = `${mode}|${automatic}|${ev}|${giState}|${fieldState}|${exposureState}|${hardwareRayTracing}|${traversal}|${traversalFallback}`;
      if (previous === key) return;
      previous = key;
      for (const id of ['off', 'irradiance-field', 'screen-probe'])
        elements.get(id).setAttribute('aria-pressed', String(id === mode));
      elements.get('toggle-exposure').setAttribute('aria-pressed', String(automatic));
      elements.get('toggle-hardware').setAttribute('aria-pressed', String(hardwareRayTracing));
      elements.get('toggle-hardware').textContent = hardwareRayTracing ? 'H · Hardware RT allowed' : 'H · Hardware RT OFF';
      traversalLabel.textContent = mode === 'off' ? 'Tracing: GI off' :
        `Actual: ${traversal === 'ray-query' ? 'Hardware Ray Query' : traversal === 'global-sdf' ? 'Software Global SDF' : traversal}${traversalFallback && traversalFallback !== 'hardware-ray-query-disabled' ? ` (${traversalFallback})` : ''}`;
      exposureLabel.textContent = `${automatic ? 'Auto' : 'Manual'} · ${ev >= 0 ? '+' : ''}${ev.toFixed(1)} EV`;
      statusLabel.textContent = `GI: ${giState}${fieldState === undefined ? '' : ` · Field: ${fieldState}`} · Exposure: ${exposureState}`;
    },
    snapshot() {
      return Object.fromEntries([...elements].map(([id, element]) => {
        const rect = element.getBoundingClientRect();
        return [id, { selected: element.getAttribute('aria-pressed'), expanded: element.getAttribute('aria-expanded'),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }];
      }));
    },
  };
}
