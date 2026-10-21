// apps/feature-lab -- one page per SDK feature-catalog row.
//
// `?f=<area>/<slug>` boots exactly one feature in a fresh page so features never
// share World, Renderer, or GPU state. `window.__featureLab` is the automation
// surface scripts/run-features.mjs drives (toggle screenshots + structured checks).

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createApp } from '@forgeax/engine/app/browser';
import { Camera } from '@forgeax/engine/render';
import { AREAS } from './lab/areas';
import {
  type AppFeature,
  CheckList,
  type FeatureCheck,
  type FeatureHandle,
  type HeadlessFeature,
  runHeadless,
} from './lab/feature';
import { collectFeatures, type RegisteredFeature } from './lab/registry';
import { spawnCamera } from './lab/stage';

type LabState = 'index' | 'booting' | 'ready' | 'failed';

interface FeatureLabApi {
  id: string | null;
  kind: string | null;
  state: LabState;
  error: string | null;
  frame: number;
  on: boolean;
  toggle(on: boolean): Promise<boolean>;
  checks(): Promise<readonly FeatureCheck[]>;
  list(): readonly {
    id: string;
    kind: string;
    title: string;
    catalog: string;
    form: string;
    expectsAppError: boolean;
    knownIssue: string | null;
  }[];
}

declare global {
  interface Window {
    __featureLab: FeatureLabApi;
  }
}

const features = collectFeatures(import.meta.glob('./features/*/*.ts', { eager: true }));
const requested = new URLSearchParams(location.search).get('f');
const current = features.find((feature) => feature.id === requested);

let handle: FeatureHandle = {};
const api: FeatureLabApi = {
  id: current?.id ?? null,
  kind: current?.definition.kind ?? null,
  state: current === undefined ? 'index' : 'booting',
  error: null,
  frame: 0,
  on: true,
  async toggle(on) {
    if (handle.toggle === undefined) return false;
    await handle.toggle(on);
    api.on = on;
    renderHudToggle();
    return true;
  },
  async checks() {
    const items = handle.checks === undefined ? [] : await handle.checks();
    renderChecks(items);
    return items;
  },
  list: () =>
    features.map((feature) => ({
      id: feature.id,
      kind: feature.definition.kind,
      title: feature.definition.title,
      catalog: feature.definition.catalog,
      form: feature.form,
      expectsAppError:
        feature.definition.kind !== 'headless' && feature.definition.expectsAppError === true,
      knownIssue: feature.definition.knownIssue ?? null,
    })),
};
window.__featureLab = api;

const nav = document.getElementById('lab-nav') as HTMLElement;
const hud = document.getElementById('lab-hud') as HTMLElement;
const canvas = document.getElementById('app') as HTMLCanvasElement;
const KIND_MARK = { visual: 'V', probe: 'P', headless: 'H' } as const;

renderNav();
if (current === undefined) renderIndex(requested);
else void boot(current).catch(fail);

function renderNav(): void {
  const parts: string[] = ['<h2><a href="?">Feature Lab index</a></h2>'];
  for (const area of AREAS) {
    const rows = features.filter((feature) => feature.area === area.id);
    if (rows.length === 0) continue;
    parts.push(`<h2>${escapeHtml(area.title)}</h2>`);
    for (const row of rows) {
      const active = row.id === current?.id ? ' class="active"' : '';
      parts.push(
        `<a href="?f=${row.id}"${active} title="${escapeHtml(row.definition.catalog)}"><span class="kind">${KIND_MARK[row.definition.kind]}</span>${escapeHtml(row.definition.title)}</a>`,
      );
    }
  }
  nav.innerHTML = parts.join('');
}

function renderIndex(missing: string | null): void {
  const index = document.getElementById('lab-index') as HTMLElement;
  index.hidden = false;
  canvas.hidden = true;
  const head =
    missing === null
      ? ''
      : `<p style="color:#ff6b6b">Unknown feature '${escapeHtml(missing)}'.</p>`;
  const rows = features
    .map(
      (row) =>
        `<tr><td><a href="?f=${row.id}">${row.id}</a></td><td>${row.definition.kind}</td><td>${row.form}</td><td>${escapeHtml(row.definition.catalog)}</td><td>${escapeHtml(row.definition.expect)}${row.definition.knownIssue === undefined ? '' : ` <b>Known issue:</b> ${escapeHtml(row.definition.knownIssue)}`}</td></tr>`,
    )
    .join('');
  index.innerHTML = `${head}<h1>ForgeaX Feature Lab</h1><p>${features.length} features. V = visual toggle, P = live probe, H = headless probe. Manual: apps/feature-lab/README.md.</p><table><tr><th>id</th><th>kind</th><th>form</th><th>catalog row</th><th>expect</th></tr>${rows}</table>`;
}

function renderHud(feature: RegisteredFeature): void {
  const def = feature.definition;
  hud.hidden = false;
  hud.innerHTML = `<h1>${escapeHtml(def.title)}</h1>
    <div class="meta">${feature.id}  |  ${def.kind}  |  ${feature.form}  |  catalog: ${escapeHtml(def.catalog)}</div>
    <p>${escapeHtml(def.summary)}</p>
    <p><b>Expect:</b> ${escapeHtml(def.expect)}</p>${def.knownIssue === undefined ? '' : `\n    <p style="color:#ffb86b"><b>Known engine issue:</b> ${escapeHtml(def.knownIssue)}</p>`}
    <div class="status" id="lab-status"></div>
    <div id="lab-toggle"></div>
    <div id="lab-checks"></div>`;
}

function setStatus(text: string): void {
  const el = document.getElementById('lab-status');
  if (el !== null) el.textContent = text;
}

function renderHudToggle(): void {
  const el = document.getElementById('lab-toggle');
  if (el === null || handle.toggle === undefined) return;
  el.innerHTML = `<button id="lab-toggle-btn">Feature: ${api.on ? 'ON' : 'OFF'} (T)</button>`;
  (document.getElementById('lab-toggle-btn') as HTMLButtonElement).onclick = () =>
    void api.toggle(!api.on);
}

function renderChecks(items: readonly FeatureCheck[]): void {
  const el = document.getElementById('lab-checks');
  if (el === null) return;
  const passed = items.filter((item) => item.ok).length;
  const verdict = passed === items.length ? 'pass' : 'fail';
  el.innerHTML = `<div class="verdict ${verdict}">Checks: ${passed}/${items.length} ${verdict.toUpperCase()}</div><ul>${items
    .map(
      (item) =>
        `<li class="${item.ok ? 'pass' : 'fail'}">${escapeHtml(item.name)}${item.detail === undefined ? '' : ` <span class="detail">${escapeHtml(item.detail)}</span>`}</li>`,
    )
    .join('')}</ul><button id="lab-rerun">Re-run checks</button>`;
  (document.getElementById('lab-rerun') as HTMLButtonElement).onclick = () => void api.checks();
}

async function boot(feature: RegisteredFeature): Promise<void> {
  renderHud(feature);
  const def = feature.definition;
  if (def.kind === 'headless') return bootHeadless(def);
  return bootApp(def);
}

async function bootHeadless(def: HeadlessFeature): Promise<void> {
  canvas.hidden = true;
  const items = await runHeadless(def);
  handle = { checks: () => items };
  api.state = 'ready';
  renderChecks(items);
}

async function bootApp(def: AppFeature): Promise<void> {
  const created = await createApp(canvas, def.appOptions ?? {}, forgeaxBundlerAdapter());
  if (!created.ok) {
    const error = created.error as { code?: string; hint?: string; message?: string };
    throw new Error(`createApp failed: ${error.code ?? error.message} -- ${error.hint ?? ''}`);
  }
  const app = created.value;
  const waiters: { target: number; resolve: () => void }[] = [];
  app.renderer.subscribe((event) => {
    if (event.kind !== 'frame-submitted' || event.receipt.presentation !== 'ready') return;
    void event.receipt.completed.then((completed) => {
      if (!completed.ok) return;
      api.frame += 1;
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i] as (typeof waiters)[number];
        if (api.frame >= waiter.target) {
          waiters.splice(i, 1);
          waiter.resolve();
        }
      }
    });
  });
  app.onError((error) => {
    const cause = (error as { detail?: { cause?: unknown } }).detail?.cause;
    api.error = `${error.code}: ${error.hint}${cause === undefined ? '' : ` <- ${JSON.stringify(cause)}`}`;
    setStatus(`App error ${api.error}`);
  });
  // Rendering starts at the first frame wait or once setup returns, so an async setup
  // never renders a World that has no camera yet.
  let started = false;
  const start = (): void => {
    if (started) return;
    started = true;
    const result = app.start();
    if (!result.ok) throw new Error(`app.start failed: ${result.error.code}`);
  };
  const frames = (count: number): Promise<void> => {
    start();
    return new Promise((resolve) => waiters.push({ target: api.frame + count, resolve }));
  };
  const result = await def.setup({
    app,
    world: app.world,
    canvas,
    hud: { status: setStatus },
    frames,
  });
  handle = result ?? {};
  // Probes that only exercise the RHI, DOM or data still run inside a rendering App.
  if (!started && [...app.world.query({ read: [Camera] }).unwrap()].length === 0)
    spawnCamera(app.world);
  start();
  await frames(2);
  api.state = 'ready';
  renderHudToggle();
  window.addEventListener('keydown', (event) => {
    if (event.key === 't' || event.key === 'T') void api.toggle(!api.on);
  });
  // Under automation the runner owns the single checks() call; a second concurrent run would race it.
  if (handle.checks !== undefined && !navigator.webdriver) await api.checks();
}

function fail(error: unknown): void {
  api.state = 'failed';
  api.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  setStatus(`Setup failed: ${api.error}`);
  renderChecks(new CheckList().ok('feature setup', false, api.error).items);
  console.error('[feature-lab]', error);
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );
}
