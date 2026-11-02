import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { runUnifiedCli } from '@forgeax/engine/devkit';
import { connectViewWorkspace } from '../../view/dist/modules/workspace/resident.mjs';
import { writeProofGameAssets } from '../../view/scripts/fixtures/plugin-assets.mjs';

// The View modeling window (design 12) on the C-101 wheel rim, a C-100 part: checkpoints
// with previews, human picks (clicks and a box) turned into selectors by model.synthesize
// with J and stability, highlight renders from the real Engine renderer, and a parameter
// change through the existing Pack draft while the selector keeps its region.
// Writes step screenshots, model.render highlight PNGs and journey.json to the output.
const checkout = resolve(import.meta.dirname, '../../..');
const root = resolve(process.env.FORGEAX_MODELING_VIEW_PROJECT ?? join(checkout, 'artifacts/modeling-view/project'));
const output = resolve(process.env.FORGEAX_MODELING_VIEW_OUTPUT ?? join(checkout, 'artifacts/modeling-view'));
const view = resolve(checkout, 'tools/view');
const examples = resolve(checkout, 'packages/modeling/examples');
const source = 'assets/wheel-rim/wheel-rim.pack.ts';

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
const render = (input) => command('model', 'render', '--input', JSON.stringify({ source, ...input }));
const journey = { case: 'C-109', source, steps: [] };
const record = (step) => { journey.steps.push(step); console.log('STEP', step.n, step.title); };

await command('project', 'engine', 'use-local', checkout);
await command('backend', 'start', '--host-pack', join(view, 'host.pack.json'));
const start = await command('view', 'start', '--input', JSON.stringify({ root, frontendConfig: { layout: { responsiveAutoTuck: false } } }));
const bootstrap = await fetch(new URL('/__forgeax/view/bootstrap', start.url)).then(r => r.json());
const client = await connectViewWorkspace({ endpoint: bootstrap.endpoint, token: bootstrap.token, clientId: 'modeling-view-proof' });
const launch = JSON.parse(await readFile(join(checkout, 'scripts/ci/browser-launch.json'), 'utf8'));
const browser = await chromium.launch({
 ...launch, headless: true, channel: undefined,
 args: [...launch.args, '--use-angle=swiftshader'],
 ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}),
 chromiumSandbox: true,
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
const errors = [];
page.on('pageerror', e => { errors.push(e.message); console.error('PAGE', e.message); });
await page.addInitScript(() => { try { localStorage.setItem('forgeax.view.locale', 'en'); } catch {} });
const panel = page.locator('[data-forgeax-view-surface="modeling"]');
const shot = async (name) => { await page.screenshot({ path: join(output, name) }); return name; };
const idle = () => panel.locator('.fx-model[data-modeling-status="idle"]').waitFor({ timeout: 600000 });
const selector = () => panel.locator('[data-selector]').textContent();
const reportFacts = async () => ({
 expression: await selector(),
 summary: (await panel.locator('.fx-model-report > p').first().textContent())?.trim(),
 stability: await panel.locator('.fx-model-report').getAttribute('data-stability'),
 notes: await panel.locator('.fx-model-report .fx-model-note').allTextContents(),
});
try {
 await page.goto(start.url);
 await page.waitForURL(url => url.searchParams.has('forgeaxWorkspaceTarget'), { timeout: 120000 });
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
  const rows = document.querySelectorAll('.fx-model-checkpoints button');
  return rows.length >= 4 && [...rows].every(row => row.querySelector('img'));
 }, undefined, { timeout: 900000 });
 const checkpoints = await panel.locator('.fx-model-checkpoints button').evaluateAll(rows => rows.map(r => ({ checkpoint: r.dataset.checkpoint, text: r.textContent })));
 record({ n: 1, title: 'checkpoint list with previews', view: await shot('step-01-view.png'), checkpoints });

 // The panel's top view and the identical CLI render share one pixel mapping.
 await panel.getByLabel('View').selectOption('top');
 const topImage = panel.locator('.fx-model-image img[data-rendered*="|top||"]');
 await topImage.waitFor({ timeout: 300000 });
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
  await page.waitForFunction(prev => {
   const code = document.querySelector('[data-forgeax-view-surface="modeling"] [data-selector]')?.textContent;
   return code && code !== prev;
  }, previous, { timeout: 900000 });
  await idle();
 };
 const highlight = async (name, expression, values = {}, frame) => {
  const out = await render({ views: ['iso', 'top'], width: 640, height: 640, selector: expression, values, ...(frame ? { frame } : {}) });
  await cp(join(root, out.sheet.image), join(output, name));
  return { image: name, selected: out.selected, mesh: out.mesh };
 };
 // Spoke k sits at k * 72 degrees from +Z; its flat front face is at y = width/2 + 12 mm - 30 mm.
 const spokeFront = 0.2413 / 2 + 0.012 - 0.03;
 const spoke = (k, r = 0.165) => [r * Math.sin((k * 2 * Math.PI) / 5), spokeFront, r * Math.cos((k * 2 * Math.PI) / 5)];

 // Step 2: five clicks (Shift adds) on the five spoke fronts.
 for (let k = 0; k < 5; k++) await click(spoke(k), k === 0 ? [] : ['Shift']);
 await waitReport(null);
 const fronts = await reportFacts();
 await page.waitForFunction(e => document.querySelector(`.fx-model-image img[data-rendered*="|top|${e}|"]`), fronts.expression, { timeout: 300000 });
 record({ n: 2, title: 'five clicks on the spoke fronts', picks: { rays: 5 }, ...fronts, view: await shot('step-02-view.png'), render: await highlight('step-02.png', fronts.expression) });
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
 record({ n: 3, title: 'spokes 5 -> 7 through the Pack draft; the selector keeps the spoke fronts', values: { spokes: 7 }, expression: fronts.expression, recheck, draftUnsaved: unsaved === 1, view: await shot('step-03-view.png'), render: await highlight('step-03.png', fronts.expression, { spokes: 7 }) });
 assert.match(recheck, /^7 faces/);
 await slide(5);
 await page.waitForFunction(() => document.querySelector('[data-forgeax-view-surface="modeling"] [data-recheck*="\\"spokes\\":5"]'), undefined, { timeout: 600000 });

 // Step 4: one plain click on one spoke front: no semantic atom isolates it (positional fallback).
 await page.waitForFunction(() => document.querySelector('.fx-model-image img[data-rendered*="\\"spokes\\":5"]'), undefined, { timeout: 600000 });
 await click(spoke(1));
 await waitReport(fronts.expression);
 const one = await reportFacts();
 record({ n: 4, title: 'one click on one spoke front', picks: { rays: 1 }, ...one, view: await shot('step-04-view.png'), render: await highlight('step-04.png', one.expression) });

 // Step 5: a box select (Alt: hidden faces too) around lug pocket 0 at the 112 mm pitch circle.
 const [x0, y0] = await at([-0.013, 0.1, 0.056 - 0.013]);
 const [x1, y1] = await at([0.013, 0.1, 0.056 + 0.013]);
 await page.keyboard.down('Alt');
 await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps: 8 }); await page.mouse.up();
 await page.keyboard.up('Alt');
 await waitReport(one.expression);
 const lug = await reportFacts();
 record({ n: 5, title: 'box select around lug pocket 0', picks: { boxes: 1, visible: false }, ...lug, view: await shot('step-05-view.png'), render: await highlight('step-05.png', lug.expression, {}, [-0.04, 0.03, 0.02, 0.04, 0.12, 0.1]) });

 // Step 6: the reference handed to the AI, and the highlight overlay in a live preview.
 await panel.getByRole('button', { name: 'Copy for AI' }).click();
 const reference = await page.evaluate(() => navigator.clipboard.readText()).catch(error => `clipboard unavailable: ${error}`);
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
   // Opening a resource selects its page; the modeling page keeps its state.
   await tab.click();
   await page.waitForTimeout(1000);
   await panel.getByRole('button', { name: 'Highlight in preview' }).click();
   // Look down on the hub so the lug pocket overlay faces the preview camera.
   const identity = { targetId: target.targetId, targetGeneration: target.generation };
   const before = await client.getCamera(identity);
   const interaction = { ...identity, interactionId: 'modeling-top' };
   await client.beginCamera({ ...interaction, baseVersion: before.version });
   await client.updateCamera({ ...interaction, camera: { position: [0.12, 0.75, 0.3], target: [0, 0.05, 0.04], lens: { projection: 'perspective', near: 0.01, far: 10 } } });
   await client.commitCamera({ ...interaction, operationId: 'modeling-top-commit', expectedVersion: before.version });
   await page.waitForTimeout(3000);
   const display = await client.getPreviewDisplay({ targetId: target.targetId, targetGeneration: target.generation });
   const captured = await client.capture({ targetId: target.targetId, targetGeneration: target.generation });
   await writeFile(join(output, 'step-06-preview.png'), Buffer.from(captured.png.split(',')[1], 'base64'));
   previewEvidence = { opened: true, overlays: display.overlays ?? display.display?.overlays, image: 'step-06-preview.png' };
  }
 } catch (error) { previewEvidence = { opened: false, error: String(error).slice(0, 500) }; }
 record({ n: 6, title: 'copy the selector for the AI; highlight it in the live preview', reference, preview: previewEvidence, view: await shot('step-06-view.png') });

 // Evidence: the same picks through the CLI contract (forgeax model synthesize), full reports.
 if (process.env.FORGEAX_MODELING_VIEW_EVIDENCE === '1') {
  const down = [0, -1, 0];
  const ray = p => ({ origin: [p[0], p[1] + 1, p[2]], direction: down });
  const picks = {
   2: { rays: [0, 1, 2, 3, 4].map(k => ray(spoke(k))) },
   4: { rays: [ray(spoke(1))] },
   5: { boxes: [{ center: [0, 0.1, 0.056], right: mapping.right, up: mapping.up, halfWidth: 0.013, halfHeight: 0.013, direction: down, visible: false }] },
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
 await writeFile(join(output, 'journey.json'), JSON.stringify({ ...journey, passed: true }, null, 2));
} catch (error) {
 await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
 await writeFile(join(output, 'journey.json'), JSON.stringify({ ...journey, passed: false, error: String(error.stack), errors }, null, 2));
 throw error;
} finally {
 await client.close(); await browser.close();
 if (process.env.FORGEAX_MODELING_VIEW_KEEP !== '1') await command('backend', 'stop');
}
