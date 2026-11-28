import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { runUnifiedCli } from '@forgeax/engine/devkit';
import { renderModelInCliProcess } from '../../../scripts/ci/modeling-cli-render.mjs';
import { connectViewWorkspace } from '../../view/dist/modules/workspace/resident.mjs';
import { writeProofGameAssets } from '../../view/scripts/fixtures/plugin-assets.mjs';
import { projectDocument } from '../../view/scripts/project-document.mjs';

// The View modeling window (design 12) on the C-101 wheel rim, a C-100 part: checkpoints
// with previews, human picks (clicks and a box) turned into selectors by model.synthesize
// with J and stability, highlight renders from the real Engine renderer, and a parameter
// change through the existing Pack draft while the selector keeps its region.
// Writes actual panel screenshots and journey.json; the panel already calls model.render.
// Repeating every highlight through the CLI adds a second Renderer and shader graph
// without another oracle. CLI parity remains available through the explicit evidence mode.
const checkout = resolve(import.meta.dirname, '../../..');
const root = resolve(process.env.FORGEAX_MODELING_VIEW_PROJECT ?? join(checkout, 'artifacts/modeling-view/project'));
const output = resolve(process.env.FORGEAX_MODELING_VIEW_OUTPUT ?? join(checkout, 'artifacts/modeling-view'));
const view = resolve(checkout, 'tools/view');
const examples = resolve(checkout, 'packages/modeling/examples');
const source = 'assets/wheel-rim/wheel-rim.pack.ts';
const labels = JSON.parse(await readFile(join(checkout, 'tools/view-plugins/locales/en.json'), 'utf8'));

await rm(join(root, 'assets'), { recursive: true, force: true });
await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
await mkdir(output, { recursive: true });
for (const [name, target] of [['engine', join(checkout, 'packages/engine')], ['view', view]]) {
 try { await symlink(target, join(root, 'node_modules/@forgeax', name)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
}
// Game projects import modeling through the Engine facade; the source is otherwise the case file.
const facade = text => text.replaceAll("'@forgeax/engine-modeling'", "'@forgeax/engine/modeling'").replaceAll("'@forgeax/engine-pack/source'", "'@forgeax/engine/pack/source'");
for (const file of ['wheel-rim/wheel-rim.pack.ts', 'wheel-rim/wheel-rim.ts', 'mech-gt/proportions.ts', 'mech-gt/joints.json']) {
 await mkdir(dirname(join(root, 'assets', file)), { recursive: true });
 await writeFile(join(root, 'assets', file), facade(await readFile(join(examples, file), 'utf8')));
}
await cp(join(view, 'scripts/fixtures/workspace-proof.plugin.ts'), join(root, 'assets/game.plugin.ts'));
await cp(join(view, 'scripts/fixtures/workspace-proof.pack.ts'), join(root, 'assets/scene.pack.ts'));
const roots = await writeProofGameAssets(root);
await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'modeling-view-proof', type: 'module', dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' } }));
await writeFile(join(root, 'forge.json'), JSON.stringify({ schemaVersion: '3.0.0', id: 'modeling-view-proof', name: 'Modeling window', assetRoots: ['assets'], roots }));

const command = async (...args) => {
 const result = await runUnifiedCli([...args, '--root', root, '--json']);
 assert.equal(result.ok, true, JSON.stringify(result).slice(0, 2000));
 return result.value;
};
/** model.render through the CLI: the same contract the panel calls, writing PNGs for evidence. */
// Match the public CLI's terminal lifetime instead of retaining its Node GPU in this driver.
const render = (input) => renderModelInCliProcess(join(checkout, 'packages/engine/dist/bin/forgeax.mjs'), root, { source, ...input });
const journey = { case: 'C-109', source, steps: [] };
const record = (step) => { journey.steps.push(step); console.log('STEP', step.n, step.title); };

await command('project', 'engine', 'use-local', checkout);
await command('backend', 'start', '--host-pack', join(view, 'host.pack.json'));
const start = await command('view', 'start', '--input', JSON.stringify({ project: root, frontendConfig: { layout: { responsiveAutoTuck: false } } }));
const bootstrap = await fetch(new URL('/__forgeax/view/bootstrap', start.url)).then(r => r.json());
const client = await connectViewWorkspace({ endpoint: bootstrap.endpoint, token: bootstrap.token, clientId: 'modeling-view-proof' });
const launch = JSON.parse(await readFile(join(checkout, 'scripts/ci/browser-launch.json'), 'utf8'));
const browser = await chromium.launch({
 ...launch, headless: true,
 args: [...launch.args, '--use-angle=swiftshader'],
 ...(process.env.FORGEAX_BROWSER_EXECUTABLE
   ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE, channel: undefined }
   : { channel: process.env.FORGEAX_CHROME_CHANNEL ?? launch.channel }),
 chromiumSandbox: true,
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
const errors = [];
let failed = false;
page.on('pageerror', e => { errors.push(e.message); console.error('PAGE', e.message); });
page.on('crash', () => { errors.push('Modeling page crashed'); console.error('PAGE Modeling page crashed'); });
await page.addInitScript(() => { try { localStorage.setItem('forgeax.view.locale', 'en'); } catch {} });
const panel = page.locator('[data-forgeax-view-surface="modeling"]');
const shot = async (name) => { await page.screenshot({ path: join(output, name) }); return name; };
const idle = () => panel.locator('.fx-model[data-modeling-status="idle"]').waitFor({ timeout: 600000 });
const selector = () => panel.locator('[data-selector]').textContent();
const reportFacts = async () => ({
 expression: await selector(),
 imageKey: await panel.locator('.fx-model-image img').getAttribute('data-rendered'),
 summary: (await panel.locator('.fx-model-report > p').first().textContent())?.trim(),
 stability: await panel.locator('.fx-model-report').getAttribute('data-stability'),
 notes: await panel.locator('.fx-model-report .fx-model-note').allTextContents(),
});
try {
 await page.goto(start.url);
 await projectDocument(page, 120000);
 assert.equal(page.url(), new URL(start.url).href, 'Modeling retains the independent Shell URL');
 await page.waitForFunction(() => {
  const failure = document.querySelector('#forgeax-fatal-details')?.textContent;
  if (failure) throw new Error(failure);
  return globalThis.__forgeaxViewReady?.mounted;
 }, undefined, { timeout: 180000 });
 const tab = page.locator('[role="tab"][data-page-id="page-modeling"]');
 if (!await tab.count()) {
  await page.locator('.fx-page-tab-btn--new').click();
  await page.getByRole('menuitem', { name: 'Modeling', exact: true }).click();
 }
 await tab.click();
 await panel.getByLabel('Modeling Pack').waitFor({ timeout: 60000 });
 await page.waitForFunction(s => [...document.querySelectorAll('[aria-label="Modeling Pack"] option')].some(o => o.value === s), source, { timeout: 120000 });
 await panel.getByLabel('Modeling Pack').selectOption(source);

 // Step 1: checkpoint list with previews (model.inspect + model.render per checkpoint).
 await page.waitForFunction(() => {
  const failure = document.querySelector('.fx-model-error')?.textContent;
  if (failure) throw new Error(failure);
  const rows = document.querySelectorAll('.fx-model-checkpoints button');
  return rows.length >= 4 && [...rows].every(row => row.querySelector('img'));
 }, undefined, { timeout: 900000 });
 const checkpoints = await panel.locator('.fx-model-checkpoints button').evaluateAll(rows => rows.map(r => ({ checkpoint: r.dataset.checkpoint, text: r.textContent })));
 record({ n: 1, title: 'checkpoint list with previews', view: await shot('step-01-view.png'), checkpoints });

 // The panel's top view and the identical CLI render share one pixel mapping.
 await panel.getByLabel('View').selectOption('top');
 const topImage = panel.locator('.fx-model-image img[data-rendered*="|top||"]');
 await topImage.waitFor({ timeout: 300000 });
 // The panel owns this key: state.key | view | selector | valuesKey (ui.tsx).
 // This journey keeps its initial checkpoint while picks and draft values change.
 const initialImageKey = await topImage.getAttribute('data-rendered');
 const initialImageState = /^(\d+:[^|]+)\|top\|\|(\{.*\})$/.exec(initialImageKey ?? '');
 assert.ok(initialImageState, 'the initial top image carries the complete owner key');
 const checkpoint = await panel.locator('.fx-model-checkpoints button.selected').getAttribute('data-checkpoint');
 assert.equal(initialImageState[1].slice(initialImageState[1].indexOf(':') + 1), checkpoint);
 const imageState = { key: initialImageState[1], checkpoint };
 const plain = await render({ views: ['top'], width: 512, height: 512, projection: 'orthographic', annotate: false });
 const mapping = plain.views[0].camera.mapping;
 assert.ok(mapping, 'model.render reports the orthographic pixel mapping');
 const toPixel = (p) => {
  const d = [0, 1, 2].map(k => p[k] - mapping.center[k]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return [mapping.width / 2 + dot(d, mapping.right) * mapping.pixelsPerMeter, mapping.height / 2 - dot(d, mapping.up) * mapping.pixelsPerMeter];
 };
 const at = async (p) => {
  const box = await panel.locator('.fx-model-image img').boundingBox();
  const [px, py] = toPixel(p);
  return [box.x + (px / 512) * box.width, box.y + (py / 512) * box.height];
 };
 const click = async (p, modifiers = []) => {
  const [x, y] = await at(p);
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up();
  for (const key of modifiers) await page.keyboard.up(key);
 };
 const waitReport = async (previous) => {
  await page.waitForFunction(({ previous, state }) => {
   const panel = document.querySelector('[data-forgeax-view-surface="modeling"]');
   const code = panel?.querySelector('[data-selector]')?.textContent;
   const view = panel?.querySelector('[aria-label="View"]')?.value;
   const checkpoint = panel?.querySelector('.fx-model-checkpoints button.selected')?.getAttribute('data-checkpoint');
   // data-recheck belongs only to the current report expression (ui.tsx), and
   // carries the exact draft values key used by the owner's render request.
   const valuesKey = panel?.querySelector('[data-recheck]')?.getAttribute('data-recheck');
   const image = panel?.querySelector('.fx-model-image img[data-rendered]');
   const requestedKey = `${state.key}|${view}|${code}|${valuesKey}`;
   return Boolean(code && code !== previous && view && checkpoint === state.checkpoint && valuesKey &&
    image?.getAttribute('data-rendered') === requestedKey && image.complete && image.naturalWidth > 0);
  }, { previous, state: imageState }, { timeout: 900000 });
  await idle();
 };
 // Spoke k sits at k * 72 degrees from +Z; its flat front face is at y = width/2 + 12 mm - 30 mm.
 const spokeFront = 0.2413 / 2 + 0.012 - 0.03;
 const spoke = (k, r = 0.165) => [r * Math.sin((k * 2 * Math.PI) / 5), spokeFront, r * Math.cos((k * 2 * Math.PI) / 5)];

 // Step 2: five clicks (Shift adds) on the five spoke fronts.
 for (let k = 0; k < 5; k++) {
  await click(spoke(k), k === 0 ? [] : ['Shift']);
  await page.waitForFunction(expected => document.querySelector('.fx-model-view > .fx-model-note')?.textContent === expected, labels.pickCount.replace('{{count}}', String(k + 1)), { timeout: 30000 });
 }
 await waitReport(null);
 const fronts = await reportFacts();
 await page.waitForFunction(e => document.querySelector(`.fx-model-image img[data-rendered*="|top|${e}|"]`), fronts.expression, { timeout: 300000 });
 record({ n: 2, title: 'five clicks on the spoke fronts', picks: { rays: 5 }, ...fronts, view: await shot('step-02-view.png') });
 assert.match(fronts.summary, /J = 1 /);

 // Step 3: the parameter slider writes the draft (asset.source.draft); the selector re-evaluates.
 const before = await readFile(join(root, source), 'utf8');
 const slider = panel.getByRole('slider', { name: 'spokes', exact: true });
 // A human drag ends at one value; React reads range inputs from their input event.
 const slide = value => slider.evaluate((element, v) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, String(v));
  element.dispatchEvent(new Event('input', { bubbles: true }));
 }, value);
 await slide(7);
 await page.waitForFunction(() => document.querySelector('[data-forgeax-view-surface="modeling"] [data-recheck*="\\"spokes\\":7"]'), undefined, { timeout: 600000 });
 const recheck = await panel.locator('[data-recheck]').textContent();
 await page.waitForFunction(e => document.querySelector(`.fx-model-image img[data-rendered*="|top|${e}|"][data-rendered*="\\"spokes\\":7"]`), fronts.expression, { timeout: 600000 });
 const unsaved = await panel.getByRole('button', { name: 'Save parameters' }).count();
 assert.equal(await readFile(join(root, source), 'utf8'), before, 'the draft edit leaves source bytes unchanged until Save');
 record({ n: 3, title: 'spokes 5 -> 7 through the Pack draft; the selector keeps the spoke fronts', values: { spokes: 7 }, expression: fronts.expression, recheck, draftUnsaved: unsaved === 1, view: await shot('step-03-view.png') });
 assert.match(recheck, /^7 faces/);
 await slide(5);
 await page.waitForFunction(() => document.querySelector('[data-forgeax-view-surface="modeling"] [data-recheck*="\\"spokes\\":5"]'), undefined, { timeout: 600000 });

 // Box-select the first hub pocket on the original wheel. The published preview
 // uses the saved source, so wait for the original geometry before selecting it.
 await page.waitForFunction(() => document.querySelector('.fx-model-image img[data-rendered*="\\"spokes\\":5"]'), undefined, { timeout: 600000 });
 const [x0, y0] = await at([-0.013, 0.1, 0.056 - 0.013]);
 const [x1, y1] = await at([0.013, 0.1, 0.056 + 0.013]);
 await page.keyboard.down('Alt');
 await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps: 8 }); await page.mouse.up();
 await page.keyboard.up('Alt');
 await waitReport(fronts.expression);
 const lug = await reportFacts();
 record({ n: 4, title: 'box select around lug pocket 0', picks: { boxes: 1, visible: false }, ...lug, view: await shot('step-04-view.png') });

 // Step 5: the reference handed to the AI, and the highlight overlay in a live preview.
 await panel.getByRole('button', { name: 'Copy for AI' }).click();
 const reference = await page.evaluate(() => navigator.clipboard.readText()).catch(error => `clipboard unavailable: ${error}`);
 const modelingView = await shot('step-05-view.png');
 let previewEvidence = { opened: false };
 try {
  let state = await client.getState();
  const { assets } = await client.listAssets(state.project.id, { targetId: state.projectTarget.targetId });
  const mesh = assets.find(a => a.sourceKey === 'mesh/wheel-rim');
  if (mesh) {
   await client.openAsset(mesh.guid, { projectId: state.project.id });
   state = await client.getState();
   const target = state.previews.find(p => p.asset?.guid === mesh.guid)?.target;
   assert.ok(target, 'the wheel rim output has a preview target');
   // Set the overlay from Modeling, then present the actual Mesh page for capture.
   const identity = { targetId: target.targetId, targetGeneration: target.generation };
   await tab.click();
   await panel.getByRole('button', { name: 'Highlight in preview' }).click();
   const overlayDeadline = performance.now() + 15_000;
   let display = await client.getPreviewDisplay(identity);
   while (!display.overlays.includes('modeling.selection') && performance.now() < overlayDeadline) {
    await delay(50);
    display = await client.getPreviewDisplay(identity);
   }
   assert.ok(display.overlays.includes('modeling.selection'), 'Mesh preview receives the Modeling overlay');
   await page.locator('[role="tab"][data-page-id="page-mesh"]').click();
   await page.locator(`[data-forgeax-asset-preview="${target.targetId}"]`).waitFor({ state: 'visible' });
   // Mesh enables reset after its initial orbit-pivot camera transaction settles.
   await page.locator('[data-testid="mesh-reset-view"]:enabled').waitFor({ timeout: 15_000 });
   // Look down on the hub so the lug pocket overlay faces the preview camera.
   const before = await client.getCamera(identity);
   const interaction = { ...identity, interactionId: 'modeling-top' };
   await client.beginCamera({ ...interaction, baseVersion: before.version });
   await client.updateCamera({ ...interaction, camera: { position: [0.12, 0.75, 0.3], target: [0, 0.05, 0.04], lens: { projection: 'perspective', near: 0.01, far: 10 } } });
   await client.commitCamera({ ...interaction, operationId: 'modeling-top-commit', expectedVersion: before.version });
   const captured = await client.capture(identity);
   await writeFile(join(output, 'step-05-preview.png'), Buffer.from(captured.png.split(',')[1], 'base64'));
   previewEvidence = { opened: true, overlays: display.overlays, image: 'step-05-preview.png' };
  }
 } catch (error) { previewEvidence = { opened: false, error: String(error).slice(0, 500) }; }
 record({ n: 5, title: 'copy the selector for the AI; highlight it in the live preview', reference, preview: previewEvidence, view: modelingView });
 assert.equal(previewEvidence.opened, true, JSON.stringify(previewEvidence));

 // Evidence: the same picks through the CLI contract (forgeax model synthesize), full reports.
 if (process.env.FORGEAX_MODELING_VIEW_EVIDENCE === '1') {
  const down = [0, -1, 0];
  const ray = p => ({ origin: [p[0], p[1] + 1, p[2]], direction: down });
  const picks = {
   2: { rays: [0, 1, 2, 3, 4].map(k => ray(spoke(k))) },
   4: { boxes: [{ center: [0, 0.1, 0.056], right: mapping.right, up: mapping.up, halfWidth: 0.013, halfHeight: 0.013, direction: down, visible: false }] },
  };
  await mkdir(join(output, 'data'), { recursive: true });
  for (const [n, pick] of Object.entries(picks)) {
   const report = await command('model', 'synthesize', '--input', JSON.stringify({ source, pick }));
   const { highlight, ...facts } = report;
   await writeFile(join(output, `data/step-0${n}-synthesize.json`), JSON.stringify({ ...facts, highlight: { topology: highlight.topology, vertices: highlight.positions.length / 3 } }, null, 2));
   const step = journey.steps.find(s => s.n === Number(n));
   assert.equal(report.expression, step.expression, `CLI and View synthesize the same selector for step ${n}`);
  }
  const at7 = await command('model', 'select', '--input', JSON.stringify({ source, values: { spokes: 7 }, selector: fronts.expression }));
  await writeFile(join(output, 'data/step-03-select.json'), JSON.stringify(at7, null, 2));
 }
 assert.deepEqual(errors, [], 'the page reports no uncaught errors');
 // The browser owns the live preview. Retire it through the workspace
 // while that browser can acknowledge cleanup, then stop the daemon.
 if (process.env.FORGEAX_MODELING_VIEW_KEEP !== '1') {
  const { project } = await client.getState();
  assert.ok(project, 'the Modeling project stays open until explicit closure');
  await client.closeProject(project.id);
  assert.equal((await client.getState()).project ?? null, null, 'the Modeling project is retired');
 }
 await writeFile(join(output, 'journey.json'), JSON.stringify({ ...journey, passed: true }, null, 2));
} catch (error) {
 failed = true;
 const evidenceErrors = [];
 const retain = async (name, collect) => {
  try { await collect(); } catch (failure) { evidenceErrors.push({ name, error: String(failure) }); }
 };
 await retain('failure.png', () => page.screenshot({ path: join(output, 'failure.png') }));
 await retain('failure.html', async () => writeFile(join(output, 'failure.html'), await page.content()));
 await retain('failure-panel.json', async () => {
 const panelState = await panel.evaluate(element => ({
  status: element.querySelector('[data-modeling-status]')?.getAttribute('data-modeling-status'),
  error: element.querySelector('[role="alert"]')?.textContent,
  selector: element.querySelector('[data-selector]')?.textContent,
  notes: [...element.querySelectorAll('.fx-model-note')].map(node => node.textContent),
  image: element.querySelector('img[data-rendered]')?.getAttribute('data-rendered'),
  view: element.querySelector('[aria-label="View"]')?.value,
  valuesKey: element.querySelector('[data-recheck]')?.getAttribute('data-recheck'),
  checkpoint: element.querySelector('.fx-model-checkpoints button.selected')?.getAttribute('data-checkpoint'),
  imageBounds: element.querySelector('img[data-rendered]')?.getBoundingClientRect().toJSON(),
  viewport: { width: innerWidth, height: innerHeight },
 }));
 await writeFile(join(output, 'failure-panel.json'), JSON.stringify(panelState, null, 2));
 });
 await retain('journey.json', () => writeFile(join(output, 'journey.json'), JSON.stringify({ ...journey, passed: false, error: String(error.stack), errors, evidenceErrors }, null, 2)));
 if (evidenceErrors.length) console.error('Modeling secondary evidence errors:', JSON.stringify(evidenceErrors));
 throw error;
} finally {
 await client.close(); await browser.close();
 if (process.env.FORGEAX_MODELING_VIEW_KEEP !== '1') {
  try { await command('backend', 'stop'); }
  catch (error) { if (!failed) throw error; console.error('Modeling backend cleanup failed:', String(error)); }
 }
}
