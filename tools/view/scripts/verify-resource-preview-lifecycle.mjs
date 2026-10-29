/** Real Engine/browser acceptance for native resource owners and View navigation. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startViewLiveIntegration } from './workspace-fixture.mjs';
import { uvAtPoint, uvBounds, uvTransform } from '../packages/view-plugin-mesh/src/ui/uv-viewport.ts';

const view = resolve(import.meta.dirname, '..');
const engine = dirname(fileURLToPath(import.meta.resolve('@forgeax/engine/package.json')));
const output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? join(view, 'artifacts/resource-preview-lifecycle'));
const root = await mkdtemp(join(tmpdir(), 'view-resource-lifecycle-'));
const errors = [], timings = [], opens = [];
let browser, live, page;
const wait = async (predicate, label) => {
  const end = Date.now() + 15_000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
try {
  await mkdir(output, { recursive: true });
  await mkdir(join(root, 'assets'));
  const source = await readFile(join(view, 'scripts/fixtures/workspace-proof.pack.ts'), 'utf8');
  await writeFile(join(root, 'assets/proof.pack.ts'), source.replace("'mesh/box':", "'mesh/other': { ...box.value, materialSlots: [{ slotName: 'surface', defaultMaterial: guid('material/box') }] },\n      'mesh/box':"));
  await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(engine, join(root, 'node_modules/@forgeax/engine'));
  await symlink(view, join(root, 'node_modules/@forgeax/view'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'view-resource-lifecycle', type: 'module', dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' } }));
  await writeFile(join(root, 'forge.json'), JSON.stringify({ id: 'view-resource-lifecycle', name: 'Resource lifecycle proof', schemaVersion: '3.0.0', roots: {} }));
  browser = await chromium.launch({ headless: true,
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}),
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-gpu-driver-bug-workarounds', '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits'],
    chromiumSandbox: true,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: Number(process.env.FORGEAX_EVIDENCE_DPR ?? 1) });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.text().includes('resource-open')) timings.push(message.text()); });
  await page.addInitScript(() => {
    globalThis.__uvDraws = new WeakMap();
    const stroke = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = function (...args) {
      if (this.canvas.closest('[data-testid="mesh-uv-overlay"]')) {
        let record = globalThis.__uvDraws.get(this.canvas);
        if (!record) globalThis.__uvDraws.set(this.canvas, record = { paths: new Set(), strokes: 0 });
        if (args[0] instanceof Path2D) record.paths.add(args[0]);
        record.strokes++;
      }
      return Reflect.apply(stroke, this, args);
    };
  });
  await page.addInitScript(() => localStorage.setItem('forgeax.view.locale', 'en'));
  live = await startViewLiveIntegration({ page, projectRoot: root, config: { readyTimeout: 120_000 } });
  const workspace = live.pageWorkspace;
  let uvReads = 0;
  const invokeOwner = workspace.invoke.bind(workspace);
  workspace.invoke = (operation, args, ...rest) => {
    if (operation === 'preview.display.get' && typeof args?.uvChannel === 'number') uvReads++;
    return invokeOwner(operation, args, ...rest);
  };
  const { assets } = await workspace.listAssets({ projectId: workspace.snapshot().project.id });
  const asset = key => { const value = assets.find(entry => entry.sourceKey === key); assert.ok(value, key); return value; };
  const projectId = workspace.snapshot().project.id;
  const previews = () => workspace.snapshot().previews.filter(entry => entry.asset?.kind === 'mesh');
  const open = async key => {
    const start = performance.now();
    await workspace.openAsset({ projectId, guid: asset(key).guid });
    const preview = workspace.snapshot().resourceOpens.mesh?.preview;
    opens.push({ key, elapsedMs: Math.round(performance.now() - start), target: preview?.target });
    return preview;
  };
  if (workspace.snapshot().scenePreview?.asset?.guid !== asset('scene/proof').guid)
    await workspace.openAsset({ projectId, guid: asset('scene/proof').guid });
  const firstPending = open('mesh/box');
  await page.locator('.fx-resource-page-status[data-phase="opening"]').waitFor();
  await page.screenshot({ path: join(output, 'opening.png') });
  const first = await firstPending;
  await page.locator(`[data-forgeax-asset-preview="${first.target.targetId}"]`).first().waitFor();
  await page.getByTestId('mesh-reset-view').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[data-testid="mesh-reset-view"]')?.disabled);
  const identity = { targetId: first.target.targetId, targetGeneration: first.target.generation };
  const uvFacts = await workspace.invoke('preview.display.get', identity);
  assert.deepEqual(uvFacts.uv.channels, [0, 1, 2]);
  assert.equal(uvFacts.uv.layout, undefined);
  const uv0 = await workspace.invoke('preview.display.get', { ...identity, uvChannel: 0 });
  const uv1 = await workspace.invoke('preview.display.get', { ...identity, uvChannel: 1 });
  const uv2 = await workspace.invoke('preview.display.get', { ...identity, uvChannel: 2 });
  assert.notDeepEqual(uv0.uv.layout.coordinates, uv1.uv.layout.coordinates);
  const distinctTriangles = layout => new Set(Array.from({ length: layout.triangleIndices.length / 3 }, (_, triangle) =>
    layout.triangleIndices.slice(triangle * 3, triangle * 3 + 3).map(index => layout.coordinates.slice(index * 2, index * 2 + 2).join(',')).sort().join(';'))).size;
  assert.equal(distinctTriangles(uv0.uv.layout), 2, 'The real cube UV0 overlaps all six faces');
  assert.equal(distinctTriangles(uv1.uv.layout), 12, 'The cube UV1 must contain six distinct islands');
  assert.deepEqual(uv0.uv.layout.assetBinding.publication, first.assetBinding.publication);
  const uvMeshCapture = await workspace.capture(identity);
  const uvMeshPixel = await page.evaluate(async png => {
    const bitmap = await createImageBitmap(await (await fetch(png)).blob());
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      return Array.from(context.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data);
    } finally { bitmap.close(); }
  }, uvMeshCapture.png);
  assert(uvMeshPixel[0] > uvMeshPixel[1] + 20 && uvMeshPixel[0] > uvMeshPixel[2] + 20, 'The UV preview must retain the authored orange 3D mesh');
  const settleUv = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const chooseUv = async channel => {
    await page.getByTestId('mesh-uv-menu').click();
    await page.getByRole('menuitemradio', { name: channel === null ? 'None' : `UV channel ${channel}`, exact: true }).click();
    if (channel === null) await page.getByTestId('mesh-uv-overlay').waitFor({ state: 'detached' });
    else await page.locator(`[data-testid="mesh-uv-overlay"][data-uv-channel="${channel}"]`).waitFor();
    await settleUv();
  };
  const uvCanvas = () => page.getByTestId('mesh-uv-overlay').locator('canvas');
  const navigation = () => page.getByTestId('mesh-uv-overlay').evaluate(element => ({
    centerU: Number(element.dataset.uvCenterU), centerV: Number(element.dataset.uvCenterV), zoom: Number(element.dataset.uvZoom),
  }));
  const pathCount = () => uvCanvas().evaluate(canvas => globalThis.__uvDraws.get(canvas)?.paths.size ?? 0);
  const assertUvPixel = async (layout, u, v, color) => {
    const size = await uvCanvas().evaluate(canvas => { const r = canvas.getBoundingClientRect(); return { width: r.width, height: r.height, ratioX: canvas.width / r.width, ratioY: canvas.height / r.height }; });
    const transform = uvTransform(uvBounds(layout), size, null);
    const x = (transform.x + u * transform.scale) * size.ratioX;
    const y = (transform.y + v * transform.scale) * size.ratioY;
    assert(x >= 6 * size.ratioX && x <= (size.width - 6) * size.ratioX, 'The expected UV edge must be inside the canvas');
    const found = await uvCanvas().evaluate((canvas, { x, y, color }) => {
      const context = canvas.getContext('2d');
      const pixels = context.getImageData(Math.max(0, Math.floor(x) - 2), Math.max(0, Math.floor(y) - 2), 5, 5).data;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] < 80) continue;
        if (color === 'white' && pixels[i] > 220 && pixels[i + 1] > 220 && pixels[i + 2] > 220) return true;
        if (color === 'red' && pixels[i] > 200 && pixels[i + 1] < 180 && pixels[i + 2] < 180) return true;
      }
      return false;
    }, { x, y, color });
    assert(found, `The ${color} UV edge at ${u},${v} must be visible`);
  };
  const uvPixels = () => page.getByTestId('mesh-uv-overlay').locator('canvas').evaluate(canvas => {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let white = 0, red = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 80) continue;
      if (data[i] > 220 && data[i + 1] > 220 && data[i + 2] > 220) white++;
      if (data[i] > 200 && data[i + 1] < 180 && data[i + 2] < 180) red++;
    }
    return { white, red, width: canvas.width, height: canvas.height };
  });
  await chooseUv(0);
  await page.waitForFunction(() => document.querySelector('[data-testid="mesh-uv-overlay"] canvas')?.width > 1);
  const channel0Pixels = await uvPixels();
  assert(channel0Pixels.white > 20 && channel0Pixels.red === 0, JSON.stringify(channel0Pixels));
  await page.screenshot({ path: join(output, 'uv-channel-0-desktop.png') });
  await chooseUv(1);
  const channel1Pixels = await uvPixels();
  assert(channel1Pixels.white > 20 && channel1Pixels.red === 0, JSON.stringify(channel1Pixels));
  for (let face = 0; face < 6; face++) {
    const coordinates = uv1.uv.layout.coordinates;
    assert(Math.abs((coordinates[face * 8 + 2] - coordinates[face * 8]) - (coordinates[face * 8 + 5] - coordinates[face * 8 + 1])) < 1e-6, 'The cube atlas must preserve square face proportions');
    await assertUvPixel(uv1.uv.layout, (coordinates[face * 8] + coordinates[face * 8 + 2]) / 2, coordinates[face * 8 + 1], 'white');
  }
  const checkHud = async () => {
    const rects = await page.locator('.fx-mesh-preview-hud').evaluate(hud => {
      const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      return { panel: box(hud.parentElement), stats: box(hud.querySelector('.fx-preview-stats')), uv: box(hud.querySelector('.fx-mesh-uv-overlay')) };
    });
    assert(rects.uv.y >= rects.stats.bottom && rects.uv.bottom <= rects.panel.bottom + 1, JSON.stringify(rects));
    assert(rects.uv.right <= rects.panel.right + 1 && rects.uv.height > 40, JSON.stringify(rects));
  };
  await checkHud();
  await page.screenshot({ path: join(output, 'uv-channel-1-desktop.png') });
  await page.setViewportSize({ width: 480, height: 720 });
  await settleUv();
  await checkHud();
  await page.screenshot({ path: join(output, 'uv-channel-1-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await chooseUv(2);
  const channel2Pixels = await uvPixels();
  assert(channel2Pixels.white > 20 && channel2Pixels.red > 20, JSON.stringify(channel2Pixels));
  await assertUvPixel(uv2.uv.layout, 1.25, 0.5, 'red');
  await page.screenshot({ path: join(output, 'uv-channel-2-complete.png') });
  const cameraBeforeNavigation = (await workspace.getCamera(identity)).camera;
  const readsBeforeNavigation = uvReads;
  const rect = await uvCanvas().boundingBox();
  assert(rect);
  const cursor = { x: Math.round(rect.x + rect.width * 0.37), y: Math.round(rect.y + rect.height * 0.42) };
  const local = { x: cursor.x - rect.x, y: cursor.y - rect.y };
  const anchor = uvAtPoint(uvTransform(uvBounds(uv2.uv.layout), rect, await navigation()), local);
  await page.mouse.move(cursor.x, cursor.y);
  await page.mouse.wheel(0, -360);
  await settleUv();
  const zoomed = await navigation();
  assert(zoomed.zoom > 1);
  const zoomedAnchor = uvAtPoint(uvTransform(uvBounds(uv2.uv.layout), rect, zoomed), local);
  assert(Math.abs(anchor.u - zoomedAnchor.u) < 1e-5 && Math.abs(anchor.v - zoomedAnchor.v) < 1e-5, 'Wheel zoom must preserve its cursor anchor');
  await page.mouse.down();
  await page.mouse.move(cursor.x + 30, cursor.y + 20, { steps: 5 });
  await page.mouse.wheel(0, -120);
  await settleUv();
  const zoomDuringDrag = (await navigation()).zoom;
  assert(zoomDuringDrag > zoomed.zoom);
  await page.mouse.move(cursor.x + 45, cursor.y + 25, { steps: 3 });
  await page.mouse.up();
  await settleUv();
  const moved = await navigation();
  assert.notEqual(moved.centerU, zoomed.centerU);
  assert.equal(moved.zoom, zoomDuringDrag, 'Continuing a drag after wheel zoom must retain the new scale');
  assert.equal(await pathCount(), 2, 'Navigation must reuse the original two Path2D objects');
  assert.equal(uvReads, readsBeforeNavigation, 'Navigation must not read UV data again');
  assert.deepEqual((await workspace.getCamera(identity)).camera, cameraBeforeNavigation, 'UV input must not move the 3D camera');
  await page.getByRole('tab', { name: /^Scene/ }).click();
  await page.locator('[data-page-id="page-mesh"]').click();
  await page.locator('[data-testid="mesh-uv-overlay"][data-uv-channel="2"]').waitFor();
  await settleUv();
  assert.deepEqual(await navigation(), moved, 'Hiding must retain the UV navigation state');
  await page.setViewportSize({ width: 480, height: 720 });
  await settleUv();
  assert.deepEqual(await navigation(), moved, 'Resize must retain UV center and relative zoom');
  await page.getByTestId('mesh-uv-fit').click();
  await settleUv();
  assert.equal((await navigation()).zoom, 1);
  await assertUvPixel(uv2.uv.layout, 1.25, 0.5, 'red');
  await page.setViewportSize({ width: 1440, height: 900 });
  await settleUv();
  await chooseUv(null);
  await chooseUv(1);
  const originalInvoke = workspace.invoke.bind(workspace);
  let releaseUv;
  let oldUvFinished = false;
  workspace.invoke = async (operation, args, ...rest) => {
    const result = await originalInvoke(operation, args, ...rest);
    if (operation === 'preview.display.get' && args.uvChannel === 0) {
      await new Promise(resolve => { releaseUv = resolve; });
      oldUvFinished = true;
    }
    return result;
  };
  try {
    await page.getByTestId('mesh-uv-menu').click();
    await page.getByRole('menuitemradio', { name: 'UV channel 0', exact: true }).click();
    await wait(() => releaseUv, 'the delayed UV query');
    await chooseUv(1);
    releaseUv();
    await wait(() => oldUvFinished, 'the retired UV result');
    assert.equal(await page.getByTestId('mesh-uv-overlay').getAttribute('data-uv-channel'), '1');
  } finally { releaseUv?.(); workspace.invoke = originalInvoke; }
  workspace.invoke = async (operation, args, ...rest) => {
    const result = await originalInvoke(operation, args, ...rest);
    if (operation !== 'preview.display.get' || args.uvChannel !== 0) return result;
    return { ...result, uv: { ...result.uv, layout: { ...result.uv.layout, assetBinding: { ...result.uv.layout.assetBinding,
      publication: { ...result.uv.layout.assetBinding.publication, digest: `sha256:${'a'.repeat(64)}` },
    } } } };
  };
  try {
    await page.getByTestId('mesh-uv-menu').click();
    await page.getByRole('menuitemradio', { name: 'UV channel 0', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'The mesh UV binding changed' }).waitFor();
    await page.getByTestId('mesh-uv-overlay').waitFor({ state: 'detached' });
  } finally { workspace.invoke = originalInvoke; }
  await chooseUv(1);
  let releaseHiddenUv;
  let hiddenUvFinished = false;
  workspace.invoke = async (operation, args, ...rest) => {
    const result = await originalInvoke(operation, args, ...rest);
    if (operation === 'preview.display.get' && args.uvChannel === 0) {
      await new Promise(resolve => { releaseHiddenUv = resolve; });
      hiddenUvFinished = true;
    }
    return result;
  };
  try {
    await page.getByTestId('mesh-uv-menu').click();
    await page.getByRole('menuitemradio', { name: 'UV channel 0', exact: true }).click();
    await wait(() => releaseHiddenUv, 'the UV query to hide');
    await page.getByRole('tab', { name: /^Scene/ }).click();
    releaseHiddenUv();
    await wait(() => hiddenUvFinished, 'the hidden UV result to retire');
  } finally { releaseHiddenUv?.(); workspace.invoke = originalInvoke; }
  await page.locator('[data-page-id="page-mesh"]').click();
  await page.locator('[data-testid="mesh-uv-overlay"][data-uv-channel="0"]').waitFor();
  await chooseUv(1);
  await writeFile(join(output, 'uv-pixels.json'), JSON.stringify({ channel0Pixels, channel1Pixels, channel2Pixels, navigation: { anchor, zoomedAnchor, moved } }, null, 2));
  const camera = await workspace.getCamera(identity);
  const repeated = await open('mesh/box');
  for (const key of ['targetId', 'generation', 'sessionId', 'worldId']) assert.equal(repeated.target[key], first.target[key]);
  assert.equal(previews().length, 1);
  assert.deepEqual((await workspace.getCamera(identity)).camera, camera.camera);
  await page.getByRole('tab', { name: /^Scene/ }).click();
  assert.equal(previews()[0].target.targetId, first.target.targetId);
  await page.locator('[data-page-id="page-mesh"]').click();
  await page.locator('[data-testid="mesh-uv-overlay"][data-uv-channel="1"]').waitFor();
  const results = await Promise.all([open('mesh/other'), open('mesh/other')]);
  assert.deepEqual(results[0].target, results[1].target);
  await wait(() => previews().length === 1, 'the superseded mesh to close');
  assert.notEqual(previews()[0].target.targetId, first.target.targetId);
  await page.getByTestId('mesh-uv-overlay').waitFor({ state: 'detached' });
  await page.waitForFunction(() => !document.querySelector('[data-testid="mesh-reset-view"]')?.disabled);
  const current = workspace.snapshot().resourceOpens.mesh.preview;
  const capture = await workspace.capture({ targetId: current.target.targetId, targetGeneration: current.target.generation });
  assert.match(capture.png, /^data:image\/png/);
  await writeFile(join(output, 'mesh-capture.png'), Buffer.from(capture.png.split(',')[1], 'base64'));
  const exact = { targetId: current.target.targetId, targetGeneration: current.target.generation };
  const tree = await workspace.getSceneTree(exact);
  await writeFile(join(output, 'diagnostics.json'), JSON.stringify({
    target: current.target, capture: { ...capture, png: undefined }, camera: await workspace.getCamera(exact), tree,
    entities: await Promise.all(tree.nodes.map(node => workspace.invoke('entity.inspect', { ...exact, entityId: node.entityId }))),
  }, null, 2));
  const pixels = await page.evaluate(async png => {
    const bitmap = await createImageBitmap(await (await fetch(png)).blob());
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const center = Array.from(context.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data);
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let min = 255, max = 0;
      for (let i = 0; i < data.length; i += 4) { min = Math.min(min, data[i], data[i + 1], data[i + 2]); max = Math.max(max, data[i], data[i + 1], data[i + 2]); }
      return { center, contrast: max - min, width: bitmap.width, height: bitmap.height };
    } finally { bitmap.close(); }
  }, capture.png);
  await writeFile(join(output, 'pixels.json'), JSON.stringify(pixels, null, 2));
  assert(pixels.contrast > 20, `A completed replacement frame must have actual pixel variation: ${JSON.stringify(pixels)}`);
  assert(pixels.center[0] > pixels.center[1] + 20 && pixels.center[0] > pixels.center[2] + 20, 'The authored orange cube must occupy the center of the completed frame');
  await writeFile(join(output, 'mesh-capture.png'), Buffer.from(capture.png.split(',')[1], 'base64'));
  await page.screenshot({ path: join(output, 'replacement.png') });
  await workspace.openAsset({ projectId, guid: asset('material/navigation').guid });
  const material = workspace.snapshot().resourceOpens.material.preview;
  await page.locator('[data-page-id="page-material"]').waitFor();
  await page.getByTestId('material-mesh-sphere').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="material-mesh-sphere"]')?.disabled === false);
  const materialAddress = { targetId: material.target.targetId, targetGeneration: material.target.generation };
  const materialState = () => workspace.invoke('preview.material.get', materialAddress);
  const openingCamera = await workspace.getCamera(materialAddress);
  const initialMaterial = await materialState();
  const selectMaterialMesh = async mesh => {
    await page.getByTestId(`material-mesh-${mesh}`).click();
    await page.waitForFunction(mesh => {
      const button = document.querySelector(`[data-testid="material-mesh-${mesh}"]`);
      return button?.getAttribute('aria-pressed') === 'true' && !button.disabled;
    }, mesh);
  };
  for (const mesh of ['sphere', 'cylinder', 'plane', 'cube']) {
    await selectMaterialMesh(mesh);
    const state = await materialState();
    assert.equal(state.mesh, mesh);
    assert.deepEqual(state.rotation, initialMaterial.rotation);
    const image = await workspace.capture(materialAddress);
    assert(image.png?.startsWith('data:image/png;base64,'));
    await writeFile(join(output, `material-${mesh}.png`), Buffer.from(image.png.split(',')[1], 'base64'));
  }
  const surface = page.locator(`div[data-forgeax-asset-preview="${material.target.targetId}"]`);
  const materialRect = await surface.boundingBox();
  assert(materialRect && materialRect.width > 0 && materialRect.height > 0);
  const drag = async (button, dx, dy) => {
    await page.mouse.move(materialRect.x + materialRect.width / 2, materialRect.y + materialRect.height / 2);
    await page.mouse.down({ button });
    await page.mouse.move(materialRect.x + materialRect.width / 2 + dx, materialRect.y + materialRect.height / 2 + dy, { steps: 8 });
    await page.mouse.up({ button });
  };
  await drag('left', 60, 25);
  await wait(async () => JSON.stringify((await materialState()).rotation) !== JSON.stringify(initialMaterial.rotation), 'material rotation');
  // A primitive transaction settles the View input owner before sampling its
  // final accepted rotation; the first changed read can precede the last call.
  await selectMaterialMesh('sphere');
  const rotated = await materialState();
  assert.notDeepEqual(rotated.rotation, initialMaterial.rotation);
  assert.deepEqual((await workspace.getCamera(materialAddress)).camera, openingCamera.camera);
  await drag('right', 0, 35);
  await selectMaterialMesh('plane');
  assert.deepEqual((await materialState()).rotation, rotated.rotation);
  const zoomedMaterialCamera = await workspace.getCamera(materialAddress);
  assert.notDeepEqual(zoomedMaterialCamera.camera.transform.pos, openingCamera.camera.transform.pos);
  assert.equal(zoomedMaterialCamera.camera.lens.fov, openingCamera.camera.lens.fov);
  await page.mouse.move(materialRect.x + materialRect.width / 2, materialRect.y + materialRect.height / 2);
  await page.mouse.wheel(0, -120);
  await wait(async () => JSON.stringify((await workspace.getCamera(materialAddress)).camera.transform.pos) !== JSON.stringify(zoomedMaterialCamera.camera.transform.pos), 'material wheel dolly');
  await drag('middle', 35, 15);
  await selectMaterialMesh('cube');
  assert.notDeepEqual((await workspace.getCamera(materialAddress)).camera.pivot, openingCamera.camera.pivot);
  await page.getByTestId('material-restore-view').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="material-restore-view"]')?.disabled === false);
  assert.deepEqual((await materialState()).rotation, initialMaterial.rotation);
  assert.equal((await materialState()).mesh, 'cube');
  assert.deepEqual((await workspace.getCamera(materialAddress)).camera.transform, openingCamera.camera.transform);
  await page.screenshot({ path: join(output, 'material-toolbar.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const controls = await page.getByTestId('material-mesh-cube').boundingBox();
  assert(controls && controls.x >= 0 && controls.x + controls.width <= 390, 'Material toolbar must fit a narrow panel');
  await page.screenshot({ path: join(output, 'material-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-page-id="page-mesh"]').click();
  await page.locator('[data-page-id="page-material"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="material-mesh-cube"]')?.disabled === false);
  assert.equal((await materialState()).mesh, 'cube', 'Hidden material pages retain their owner selection');
  await page.locator('[data-page-id="page-mesh"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close to the right', exact: true }).click();
  await page.locator('[data-page-id="page-material"]').waitFor({ state: 'detached' });
  assert(!workspace.snapshot().previews.some(entry => entry.target.targetId === material.target.targetId));
  assert.equal(previews()[0].target.targetId, current.target.targetId);
  await page.locator('[data-page-id="page-mesh"]').click();
  await page.locator('[data-page-id="page-mesh"]').hover();
  await page.locator('[data-page-close="page-mesh"]').click();
  await page.locator('[data-page-id="page-mesh"]').waitFor({ state: 'detached' });
  assert.equal(previews().length, 0);
  const reopened = await open('mesh/other');
  assert.notEqual(reopened.target.targetId, current.target.targetId);
  await page.waitForFunction(() => !document.querySelector('[data-testid="mesh-reset-view"]')?.disabled);
  await page.screenshot({ path: join(output, 'reopened.png') });
  await workspace.openAsset({ projectId, guid: asset('material/navigation').guid });
  await page.locator('[data-page-id="page-material"]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="material-mesh-sphere"]')?.disabled === false);
  const reopenedMaterial = workspace.snapshot().resourceOpens.material.preview;
  assert.equal((await workspace.invoke('preview.material.get', { targetId: reopenedMaterial.target.targetId, targetGeneration: reopenedMaterial.target.generation })).mesh, 'sphere');
  await page.locator('[data-page-id="page-mesh"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close others', exact: true }).click();
  await page.locator('[data-page-id="page-material"]').waitFor({ state: 'detached' });
  assert.equal(previews()[0].target.targetId, reopened.target.targetId);
  assert.equal(await page.getByRole('tab', { name: /^Scene/ }).count(), 1);
  assert(!workspace.snapshot().previews.some(entry => entry.asset?.kind === 'material'));
  const closed = await live.backendHost.context.get('toolApi').run('view.workspace.call', { operation: 'presentation.page.close', args: { pageId: 'page-mesh' } }, { sourceId: 'view-workspace' }).terminal;
  assert.equal(closed.outcome, 'succeeded', JSON.stringify(closed));
  assert(!closed.result.pages.some(entry => entry.id === 'page-mesh'), 'The close API must return the committed page removal');
  await page.locator('[data-page-id="page-mesh"]').waitFor({ state: 'detached' });
  assert.equal(previews().length, 0);
  const dense = await open('mesh/dense');
  await page.waitForFunction(() => !document.querySelector('[data-testid="mesh-reset-view"]')?.disabled);
  const denseIdentity = { targetId: dense.target.targetId, targetGeneration: dense.target.generation };
  const denseUv = await workspace.invoke('preview.display.get', { ...denseIdentity, uvChannel: 0 });
  assert.equal(denseUv.uv.layout.triangleIndices.length / 3, 49152);
  assert.equal(dense.assetBinding.meta.triangleCount, 49152);
  await chooseUv(0);
  assert((await uvPixels()).white > 1000);
  const denseCamera = (await workspace.getCamera(denseIdentity)).camera;
  const denseReads = uvReads;
  const denseRect = await uvCanvas().boundingBox();
  await page.mouse.move(denseRect.x + denseRect.width / 2, denseRect.y + denseRect.height / 2);
  await page.mouse.wheel(0, -1200);
  await page.mouse.down();
  await page.mouse.move(denseRect.x + denseRect.width / 2 + 20, denseRect.y + denseRect.height / 2 + 10, { steps: 5 });
  await page.mouse.up();
  await settleUv();
  assert.equal(await pathCount(), 2);
  assert.equal(uvReads, denseReads);
  assert.deepEqual((await workspace.getCamera(denseIdentity)).camera, denseCamera);
  await page.mouse.move(denseRect.x + denseRect.width + 80, denseRect.y);
  await page.screenshot({ path: join(output, 'uv-dense-49152-zoomed.png') });
  await page.getByTestId('mesh-uv-fit').click();
  await settleUv();
  await page.mouse.move(denseRect.x + denseRect.width + 80, denseRect.y);
  await page.getByRole('tooltip').waitFor({ state: 'hidden' });
  await page.screenshot({ path: join(output, 'uv-dense-49152-triangles.png') });
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, engine, opens, pixels, timings, errors, boundary: 'Paired Engine native owners; completed-ready capture verifies the exact replacement target.' }, null, 2));
  console.log(JSON.stringify({ passed: true, output, opens: opens.map(({ key, elapsedMs }) => ({ key, elapsedMs })) }));
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  await writeFile(join(output, 'failure.json'), JSON.stringify({ message: error.message, errors, timings, root }, null, 2));
  throw error;
} finally {
  try { await live?.dispose(); }
  finally {
    await browser?.close();
    await rm(root, { recursive: true, force: true });
  }
}
