/** Actual Engine backend, View UI, project App and dedicated resource preview. */
import assert from 'node:assert/strict';
import { browserProofWorkload } from './browser-proof-workload.mjs';
const workload = browserProofWorkload();
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  createDevKitBackend,
  createNodePackProgramImports,
  runUnifiedCli,
} from '@forgeax/engine/devkit';
import { prepareRuntimePackProgram } from '@forgeax/engine/devkit/plugin-build';
import { preparePackProgram } from '@forgeax/engine/pack/runtime';
import { prepareRuntimePackContent } from '@forgeax/engine/import';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { AssetGuid, definePackageId, projectScriptablePackSceneComponents } from '@forgeax/engine/pack/source';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { Name, Transform } from '@forgeax/engine/scene';
import { connectViewWorkspace } from '@forgeax/view/workspace/resident';
import { importRuntimeContent, openRuntimeContent } from './runtime-content-import.mjs';
import { savePreviewRhiEvidence } from './preview-rhi-evidence.mjs';

const viewRoot = resolve(dirname(fileURLToPath(import.meta.resolve('@forgeax/view'))), '../..');
const enginePackage = await realpath(dirname(fileURLToPath(import.meta.resolve('@forgeax/engine/package.json'))));
const checkout = process.env.FORGEAX_ENGINE_CHECKOUT ? resolve(process.env.FORGEAX_ENGINE_CHECKOUT) : undefined;
if (!checkout) {
  for (const name of ['NODE_PATH', 'FORGEAX_SHARED_APP_INPUTS_MANIFEST']) {
    assert.equal(process.env[name], undefined, `Independent package qualification must not inherit ${name}`);
  }
}
const temporary = await mkdtemp(join(tmpdir(), 'view-runtime-engine-'));
const projectRoot = join(temporary, 'game');
const evidence = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? '/tmp/runtime-content-engine');
const language = process.env.FORGEAX_RUNTIME_PACK_LANGUAGE ?? 'js';
assert.ok(['js', 'ts'].includes(language));
const parent = '01900000-0000-7000-8000-000000001101';
const errors = [];
let engine, browser, page, client;
let evidenceResult;
let phase = 'prepare';
let captureSubject;
const isPreviewCaptureBusy = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return message.includes('preview capture is busy')
    || code === 'view-workspace-target-busy'
    || code === 'engine-workspace-target-busy';
};
const startedAt = Date.now();
const heartbeat = setInterval(() => console.log(`Runtime content: ${phase}, elapsed ${Math.round((Date.now() - startedAt) / 1000)}s`), 30000);
heartbeat.unref();
try {
  await mkdir(evidence, { recursive: true });
  await mkdir(join(projectRoot, 'assets'), { recursive: true });
  await mkdir(join(projectRoot, 'node_modules/@forgeax'), { recursive: true });
  await symlink(enginePackage, join(projectRoot, 'node_modules/@forgeax/engine'), 'dir');
  await symlink(viewRoot, join(projectRoot, 'node_modules/@forgeax/view'), 'dir');
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ name: 'view-runtime-content', type: 'module', dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' } }));
  await writeFile(join(projectRoot, 'forge.json'), JSON.stringify({ schemaVersion: '3.0.0', id: 'runtime-content', name: 'Runtime Content', roots: {} }));
  const command = async (...args) => {
    const result = await runUnifiedCli([...args, '--root', projectRoot, '--json']);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  };
  if (checkout) {
    const binding = await command('project', 'engine', 'use-local', checkout);
    assert.equal(binding.mode, 'local');
    assert.equal(await realpath(binding.resolved.root), await realpath(checkout));
  } else {
    const metadata = JSON.parse(await readFile(join(enginePackage, 'package.json'), 'utf8'));
    assert.ok(Object.values(metadata.dependencies ?? {}).every(value => !value.startsWith('workspace:')),
      'Package qualification requires installed Engine archives; source mode needs FORGEAX_ENGINE_CHECKOUT');
    assert.equal((await command('project', 'engine', 'status')).mode, 'sdk');
  }
  assert.equal((await command('project', 'engine', 'check')).healthy, true);
  engine = await createDevKitBackend(temporary, { hostPack: join(viewRoot, 'host.pack.json') });
  const backendCall = async (operation, args = {}) => {
    const api = engine.host.context.toolApi;
    const providers = api.describe(operation).filter(record => record.callable);
    assert.equal(providers.length, 1, `Expected one native provider for ${operation}: ${JSON.stringify(providers)}`);
    const owner = providers[0].owner;
    const terminal = await api.run(operation, args, owner).terminal;
    assert.equal(terminal.outcome, 'succeeded', JSON.stringify(terminal));
    return terminal.result;
  };
  const started = await backendCall('view.start', { frontendConfig: { layout: { responsiveAutoTuck: false } } });
  const bootstrap = await fetch(new URL('/__forgeax/view/bootstrap', started.url)).then(response => response.json());
  client = await connectViewWorkspace({ endpoint: bootstrap.endpoint, token: bootstrap.token, clientId: 'runtime-content-proof' });
  const browserEnv = Object.fromEntries(['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DISPLAY', 'XAUTHORITY'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  browser = await chromium.launch({
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE
      ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE }
      : process.env.FORGEAX_CHROME_CHANNEL
        ? { channel: process.env.FORGEAX_CHROME_CHANNEL }
        : { executablePath: '/opt/google/chrome-beta/chrome' }),
    headless: false, env: browserEnv,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--use-angle=swiftshader', '--use-vulkan=swiftshader', '--enable-unsafe-swiftshader', '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--disable-gpu-watchdog', '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits'], chromiumSandbox: true});
  page = await browser.newPage({ viewport: workload.runtimeViewport, acceptDownloads: true });
  if (process.env.FORGEAX_RUNTIME_PACK_DIRECT === '1') {
    // Test observation of the live App reader, without adding a product API.
    await page.route('**/main.ts', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const marker = 'function exposeGameInspection(app) {';
      assert.ok(source.includes(marker), 'direct proof must instrument the actual App owner');
      await route.fulfill({ response, body: source.replace(marker, `${marker}
        globalThis.__runtimePackReadDirect = async guid => {
          const handle = (await app.assets.load(app.assets.parseGuid(guid), 'mesh')).unwrap();
          const mesh = app.assets.read(handle).unwrap();
          app.assets.release(handle).unwrap();
          return { typed: mesh.attributes.position instanceof Float32Array && ArrayBuffer.isView(mesh.indices),
            positions: Array.from(mesh.attributes.position), indices: Array.from(mesh.indices) };
        };
      `) });
    });
  }
  if (process.env.FORGEAX_RUNTIME_PACK_DIAGNOSTIC === '1') {
    await page.route('**/main.ts', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const marker = 'const hostContext = new Context();';
      assert.ok(source.includes(marker));
      await route.fulfill({ response, body: source.replace(marker, `${marker}
        const proofFibers = new Set();
        hostContext.on('internal/plugin', fiber => proofFibers.add(fiber));
        globalThis.__runtimeProofInspect = () => [...proofFibers].map(fiber => ({
          name: fiber.runtime?.name, uid: fiber.uid, state: fiber.state,
          transitioning: !!fiber.inertia,
          missing: Object.keys(fiber.inject).filter(name => fiber.ctx.get(name) === undefined),
        }));
      `) });
    });
  }
  page.setDefaultTimeout(30000);
  await page.addInitScript(() => { try { localStorage.setItem('forgeax.view.locale', 'en'); } catch {} });
  // Count actual explicitly owned WebGPU buffers/textures without retaining
  // their objects. Test-only instrumentation preserves the native operations.
  await page.addInitScript(() => {
    const resources = new WeakMap();
    const devices = new WeakMap();
    const canvasDevices = new WeakMap();
    const owners = [];
    const counts = { buffers: 0, textures: 0 };
    const track = (prototype, create, key) => {
      const original = prototype[create];
      prototype[create] = function(...args) {
        const resource = Reflect.apply(original, this, args);
        let owner = devices.get(this);
        if (!owner) {
          owner = { id: owners.length, buffers: 0, textures: 0, destroyed: false, labels: {} };
          devices.set(this, owner);
          owners.push(owner);
        }
        const label = `${key}:${args[0]?.label ?? '(unlabelled)'}`;
        if (!owner.destroyed) {
          resources.set(resource, { owner, label });
          owner[key]++; counts[key]++;
          owner.labels[label] = (owner.labels[label] ?? 0) + 1;
        }
        return resource;
      };
    };
    const release = (prototype, key) => {
      const original = prototype.destroy;
      prototype.destroy = function(...args) {
        const result = Reflect.apply(original, this, args);
        const tracked = resources.get(this);
        const owner = tracked?.owner;
        if (owner && !owner.destroyed) {
          owner[key]--; counts[key]--;
          if (--owner.labels[tracked.label] === 0) delete owner.labels[tracked.label];
        }
        resources.delete(this);
        return result;
      };
    };
    track(GPUDevice.prototype, 'createBuffer', 'buffers');
    track(GPUDevice.prototype, 'createTexture', 'textures');
    release(GPUBuffer.prototype, 'buffers');
    release(GPUTexture.prototype, 'textures');
    const configure = GPUCanvasContext.prototype.configure;
    GPUCanvasContext.prototype.configure = function(configuration) {
      const result = Reflect.apply(configure, this, [configuration]);
      canvasDevices.set(this.canvas, configuration.device);
      return result;
    };
    const destroy = GPUDevice.prototype.destroy;
    GPUDevice.prototype.destroy = function(...args) {
      const result = Reflect.apply(destroy, this, args);
      const owner = devices.get(this);
      if (owner && !owner.destroyed) {
        counts.buffers -= owner.buffers; counts.textures -= owner.textures; owner.destroyed = true;
        owner.buffers = 0; owner.textures = 0; owner.labels = {};
      }
      return result;
    };
    globalThis.__runtimePackGpuSample = targetId => ({
      counts: { ...counts },
      devices: owners.map(owner => ({ ...owner, labels: { ...owner.labels } })),
      previewDevice: targetId === undefined ? undefined : devices.get(canvasDevices.get(
        [...document.querySelectorAll('canvas[data-forgeax-asset-preview]')]
          .find(canvas => canvas.dataset.forgeaxAssetPreview === targetId),
      ))?.id,
    });
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', request => errors.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
  phase = 'shell';
  await page.goto(started.url);
  // Engine tool pages can be first; the Scene page owns project opening.
  await page.getByRole('tab').filter({ hasText: /^Scene/ }).click();
  await page.getByRole('dialog', { name: 'Open project', exact: true }).waitFor();
  await page.getByLabel('Project path', { exact: true }).fill(projectRoot);
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  phase = 'project';
  await page.waitForURL(url => url.searchParams.has('forgeaxWorkspaceTarget'), { timeout: 90000 });
  await page.waitForFunction(() => !!globalThis.__forgeaxViewReady?.mounted, undefined, { timeout: 90000 });
  const contentBrowser = page.getByTestId('panel-content-browser');
  const revealContentBrowser = async () => {
    await contentBrowser.waitFor({ state: 'attached' });
    if (!(await contentBrowser.isVisible())) {
      const presentation = await client.call('presentation.get');
      const panel = presentation.panels.find(panel => panel.title === 'Content Browser');
      assert.ok(panel?.mounted, 'Content Browser must have a mounted native panel');
      await client.call('presentation.panel.reveal', {
        connectionId: presentation.connectionId, panelId: panel.id,
      });
    }
    await contentBrowser.waitFor({ state: 'visible' });
  };
  await revealContentBrowser();
  let state = await client.getState();
  const readyDeadline = Date.now() + 90000;
  while (!state.projectTarget?.worldId || state.projectTarget.worldId.startsWith('pending:')) {
    await writeFile(join(evidence, 'project-pending.json'), JSON.stringify(state, null, 2));
    assert.ok(Date.now() < readyDeadline, `Project App did not become ready: ${JSON.stringify(state)}`);
    await new Promise(resolve => setTimeout(resolve, 250));
    state = await client.getState();
  }
  assert.equal(state.project.id, 'runtime-content');
  assert.equal(await realpath(state.project.root), await realpath(projectRoot));
  assert.equal(new URL(page.url()).searchParams.get('forgeaxWorkspaceTarget'), state.projectTarget.targetId);
  assert.ok(state.projectTarget.worldId && !state.projectTarget.worldId.startsWith('pending:'));
  const target = { projectId: state.project.id, targetId: state.projectTarget.targetId, worldId: state.projectTarget.worldId };
  const runtime = (operation, args = {}) => client.call(`runtime-pack.${operation}`, { ...args, ...target });
  const inspectUserContent = async () => {
    const inspection = await runtime('inspect');
    const tooling = inspection.packs.filter(pack => {
      const query = pack.source.assets?.query;
      const config = query?.payload?.config;
      return query?.kind === 'plugin' && query.payload.module?.specifier === './query.js'
        && config?.projectId === target.projectId && config.targetId === target.targetId
        && config.worldId === target.worldId && config.providerId?.startsWith('view-asset-references:');
    });
    assert.equal(tooling.length, 0, 'Native asset reference reads must not admit a View query definition');
    return inspection;
  };
  const capturePreview = async (subject) => {
    const deadline = Date.now() + 15000;
    let wait = 50;
    while (true) {
      try {
        return await client.capture({
          targetId: subject.targetId,
          targetGeneration: subject.generation,
          reportError: false,
        });
      } catch (error) {
        if (!isPreviewCaptureBusy(error) || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, wait));
        wait = Math.min(wait * 2, 1000);
      }
    }
  };
  assert.equal((await inspectUserContent()).packs.length, 0);
  const initialUrl = page.url();
  const sceneTab = page.getByRole('tab').filter({ hasText: /^Scene/ });
  const captureTarget = async (subject, name) => {
    captureSubject = subject;
    const value = await capturePreview(subject);
    assert.ok(value.frameId > 0, 'preview must have completed a real frame');
    const pixels = await page.evaluate(async png => {
      const bitmap = await createImageBitmap(await (await fetch(png)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
      const background = [data[0], data[1], data[2]];
      let left = width, top = height, right = -1, bottom = -1, count = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const contrast = Math.max(...background.map((channel, index) => Math.abs(data[offset + index] - channel)));
        if (data[offset + 3] > 0 && contrast > 20 && data[offset] < 225 && data[offset + 1] < 225 && data[offset + 2] < 225 &&
            Math.abs(data[offset] - data[offset + 1]) <= 2 && Math.abs(data[offset + 1] - data[offset + 2]) <= 2) {
          left = Math.min(left, x); right = Math.max(right, x);
          top = Math.min(top, y); bottom = Math.max(bottom, y); count++;
        }
      }
      return { width, height, background, left, right, top, bottom, count, aspect: (right - left + 1) / (bottom - top + 1) };
    }, value.png);
    await writeFile(join(evidence, `${name}.png`), Buffer.from(value.png.split(',')[1], 'base64'));
    const { png, ...metadata } = value;
    await writeFile(join(evidence, `${name}.json`), JSON.stringify({ ...metadata, pixels }, null, 2));
    assert.ok(pixels.count > 1000, 'actual geometry pixels must be present');
    captureSubject = undefined;
    return { ...metadata, pixels };
  };
  const verifyScene = async sceneGuid => {
    phase = 'scene';
    await client.openAsset(sceneGuid, { projectId: state.project.id });
    await sceneTab.click();
    const sceneState = await client.getState();
    assert.equal(sceneState.preview.target.targetId, target.targetId);
    const tree = await client.getSceneTree({ targetId: target.targetId, targetGeneration: sceneState.preview.target.generation });
    await writeFile(join(evidence, 'scene-tree.json'), JSON.stringify(tree, null, 2));
    assert.match(JSON.stringify(tree), /Runtime box/);
    const sceneCapture = await captureTarget(sceneState.preview.target, 'restored-scene');
    phase = `scene-${workload.sceneFrames}-frames`;
    const frameStart = await page.evaluate(() => globalThis.__forgeaxGameInspection.renderer().execution.frame.completed);
    await page.waitForFunction(minimum => globalThis.__forgeaxGameInspection.renderer().execution.frame.completed >= minimum,
      frameStart + workload.sceneFrames, { timeout: 180000 });
    const completedFrames = await page.evaluate(() => globalThis.__forgeaxGameInspection.renderer().execution.frame.completed);
    const stableCapture = await captureTarget(sceneState.preview.target, phase);
    assert.ok(completedFrames - frameStart >= workload.sceneFrames);
    assert.equal(await page.locator('vite-error-overlay').count(), 0, 'Scene UI must not retain a Vite error overlay');
    await page.screenshot({ path: join(evidence, 'restored-scene-ui.png') });
    return { sceneCapture, frameStart, completedFrames, stableCapture };
  };
  const readBinding = async subject => {
    const snapshot = await client.getState();
    const selected = snapshot.previews.find(preview => preview.target.targetId === subject.targetId &&
      preview.target.generation === subject.generation);
    assert.ok(selected?.assetBinding?.publication?.digest, 'actual preview owner must publish its binding');
    return selected.assetBinding;
  };

  const verifyResourceCycles = async meshGuid => {
    phase = 'resource-cycles';
    for (const preview of (await client.getState()).previews) {
      if (preview.target.targetId !== target.targetId) {
        await client.closePreview({ targetId: preview.target.targetId, targetGeneration: preview.target.generation });
      }
    }
    const sample = targetId => page.evaluate(id => globalThis.__runtimePackGpuSample(id), targetId);
    const resourceCycles = [];
    for (let index = 0; index < workload.resourceCycles; index++) {
      const before = await sample();
      const cycle = await client.openAsset(meshGuid, { projectId: state.project.id });
      const subject = cycle.openRequest.preview.target;
      await captureTarget(subject, `resource-cycle-${index}`);
      await page.locator(`canvas[data-forgeax-asset-preview="${subject.targetId}"]`).waitFor({ state: 'attached' });
      const open = await sample(subject.targetId);
      const existing = new Set(before.devices.map(device => device.id));
      const created = open.devices.filter(device => !existing.has(device.id));
      const previewDevice = created.find(device => device.id === open.previewDevice);
      assert.ok(previewDevice, 'opening this dedicated preview must create its canvas-owned GPU device');
      assert.ok(previewDevice.buffers > 0 && previewDevice.textures > 0,
        'the preview device must own observed native GPU buffers and textures');
      await client.closePreview({ targetId: subject.targetId, targetGeneration: subject.generation });
      const closeReturned = await sample();
      const record = { targetId: subject.targetId, previewDevice: previewDevice.id, before, open, closeReturned };
      resourceCycles.push(record);
      await writeFile(join(evidence, 'resource-cycles.json'), JSON.stringify(resourceCycles, null, 2));
      // RenderGraph retirement can finish after App disposal. Observe this
      // preview's actual destroys; the independently running Scene may resize.
      await page.waitForFunction(id => {
        const device = globalThis.__runtimePackGpuSample().devices.find(device => device.id === id);
        return device !== undefined && device.buffers === 0 && device.textures === 0;
      }, previewDevice.id, { timeout: 30000 });
      record.closed = await sample();
      const released = record.closed.devices.find(device => device.id === previewDevice.id);
      assert.equal(released.buffers, 0);
      assert.equal(released.textures, 0);
      await writeFile(join(evidence, 'resource-cycles.json'), JSON.stringify(resourceCycles, null, 2));
    }
    const final = await sample();
    for (const { previewDevice } of resourceCycles) {
      const released = final.devices.find(device => device.id === previewDevice);
      assert.equal(released?.buffers, 0, 'closed preview devices must remain released in later cycles');
      assert.equal(released?.textures, 0, 'closed preview devices must remain released in later cycles');
    }
    await writeFile(join(evidence, 'resource-final.json'), JSON.stringify(final, null, 2));
    return resourceCycles;
  };

  if (process.env.FORGEAX_RUNTIME_PACK_DIRECT === '1') {
    // A direct original has neither an executable recipe nor parameter instances.
    // The cold branch receives the saved bytes in a separate Node/browser run.
    const packageId = '01900000-0000-7000-8000-000000001102';
    const guid = key => AssetGuid.format(AssetGuid.derive(definePackageId(packageId), key));
    const coldPath = process.env.FORGEAX_RUNTIME_PACK_SNAPSHOT;
    let bytes;
    let expected;
    if (coldPath) {
      phase = 'direct-cold-restore';
      bytes = await readFile(resolve(coldPath));
      const saved = JSON.parse(bytes);
      assert.equal(saved.schemaVersion, 'runtime-pack-source/2');
      assert.deepEqual(saved.instances, []);
      assert.equal(saved.packs.length, 1);
      assert.equal(saved.packs[0].source.packageId, packageId);
      assert.equal(saved.packs[0].programs, undefined);
      // This is an assertion oracle only; it is never submitted to the runtime.
      expected = JSON.parse(await readFile(join(dirname(resolve(coldPath)), 'direct-expected.json'), 'utf8'));
    } else {
      phase = 'direct-create';
      const mesh = createBoxGeometry(3, 2, 2).unwrap();
      expected = { typed: true, positions: Array.from(mesh.attributes.position), indices: Array.from(mesh.indices) };
      const content = (await prepareRuntimePackContent(packageId, {
        box: mesh,
        scene: { kind: 'scene', entities: { box: { components: {
          Name: { value: 'Runtime box original' }, Transform: { pos: [0, 0, 0] },
          MeshFilter: { assetHandle: guid('box') }, MeshRenderer: {},
        } } } },
      }, { sceneComponents: projectScriptablePackSceneComponents([Name, Transform, MeshFilter, MeshRenderer]) })).unwrap();
      assert.equal(content.programs, undefined);
      bytes = Buffer.from(JSON.stringify(content));
    }
    await openRuntimeContent(page);
    const panel = page.getByTestId('runtime-content');
    await importRuntimeContent(page, panel, { name: 'direct-content.json', mimeType: 'application/json', buffer: bytes });
    await panel.locator('summary').filter({ hasText: 'Admitted packs' }).click();
    await panel.getByText(packageId, { exact: true }).waitFor();
    const admitted = await inspectUserContent();
    assert.equal(admitted.packs.length, 1);
    assert.deepEqual(admitted.executions, []);
    const rows = await client.listAssets(state.project.id, { targetId: state.projectTarget.targetId });
    assert.ok(rows.assets.some(asset => asset.guid === guid('box') && asset.kind === 'mesh'));
    const loaded = await page.evaluate(guid => globalThis.__runtimePackReadDirect(guid), guid('box'));
    assert.deepEqual(loaded, expected, 'the live browser AssetRegistry must restore every position and index as typed data');
    await writeFile(join(evidence, 'direct-expected.json'), JSON.stringify(expected));
    await writeFile(join(evidence, 'direct-loaded.json'), JSON.stringify(loaded));
    const opened = await client.openAsset(guid('box'), { projectId: state.project.id });
    const previewTarget = opened.openRequest.preview.target;
    await page.getByTestId('panel-mesh-preview').locator(`canvas[data-forgeax-asset-preview="${previewTarget.targetId}"]`).waitFor({ state: 'visible' });
    const capture = await captureTarget(previewTarget, coldPath ? 'direct-cold-mesh' : 'direct-original-mesh');
    const binding = await readBinding(previewTarget);
    assert.deepEqual(binding.meta.aabb, [-1.5, -1, -1, 1.5, 1, 1]);
    assert.ok(Math.abs(capture.pixels.aspect - 1.5) < 0.05);
    await page.screenshot({ path: join(evidence, 'direct-original-ui.png') });
    await sceneTab.click();
    await revealContentBrowser();
    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Save content', exact: true }).click();
    await (await downloadPromise).saveAs(join(evidence, 'saved-content.json'));
    const snapshot = JSON.parse(await readFile(join(evidence, 'saved-content.json'), 'utf8'));
    assert.equal(snapshot.schemaVersion, 'runtime-pack-source/2');
    assert.deepEqual(snapshot.instances, []);
    assert.equal(snapshot.packs.length, 1);
    assert.equal(snapshot.packs[0].programs, undefined);
    assert.deepEqual(snapshot.packs[0].source.assets.scene.refs, [guid('box')]);
    // Includes the serialized typed buffers, not only GUIDs or matching bounds.
    const originalPack = coldPath ? JSON.parse(bytes).packs[0] : JSON.parse(bytes);
    assert.deepEqual(snapshot.packs[0], originalPack);
    const scene = await verifyScene(guid('scene'));
    const resourceCycles = await verifyResourceCycles(guid('box'));
    evidenceResult = { mode: 'direct', cold: !!coldPath, target, admitted, rows, binding, capture, loaded, resourceCycles, ...scene, errors,
      boundary: 'direct Mesh and Scene originals, no program or parameter instance; View import and save, byte-complete Pack recovery in fresh backend/App/browser; software GPU' };
  } else if (process.env.FORGEAX_RUNTIME_PACK_SNAPSHOT) {
    // A new backend, App and browser receive only saved content. No source
    // preparation, generation service or former module cache participates.
    phase = 'cold-restore';
    const bytes = await readFile(resolve(process.env.FORGEAX_RUNTIME_PACK_SNAPSHOT));
    const snapshot = JSON.parse(bytes);
    assert.equal(snapshot.schemaVersion, 'runtime-pack-source/2');
    assert.equal(snapshot.instances.length, 1);
    const instance = snapshot.instances[0];
    const guid = key => AssetGuid.format(AssetGuid.derive(definePackageId(instance.packageId), key));
    await openRuntimeContent(page);
    const panel = page.getByTestId('runtime-content');
    await importRuntimeContent(page, panel, { name: 'cold-content.json', mimeType: 'application/json', buffer: bytes });
    await panel.getByLabel('Generator', { exact: true }).selectOption(instance.parent);
    await panel.getByLabel('Instance', { exact: true }).selectOption(instance.packageId);
    await panel.getByRole('button', { name: 'Install', exact: true }).click();
    await panel.getByText(/#\d+ · active/).waitFor();
    const restored = await runtime('inspect');
    assert.deepEqual(restored.executions.find(item => item.instance.packageId === instance.packageId).instance, instance);
    const opened = await client.openAsset(guid('box'), { projectId: state.project.id });
    const previewTarget = opened.openRequest.preview.target;
    await page.getByTestId('panel-mesh-preview').locator(`canvas[data-forgeax-asset-preview="${previewTarget.targetId}"]`).waitFor({ state: 'visible' });
    const restoredCapture = await captureTarget(previewTarget, 'cold-mesh');
    const restoredBinding = await readBinding(previewTarget);
    await page.getByTestId('panel-mesh-properties').getByText(restoredBinding.publication.digest, { exact: true }).waitFor();
    assert.ok(Math.abs(restoredCapture.pixels.aspect - instance.values.width / 2) < 0.05);
    const scene = await verifyScene(guid('scene'));
    const resourceCycles = await verifyResourceCycles(guid('box'));
    evidenceResult = { language, target, restored, opened, restoredCapture, restoredBinding, resourceCycles, ...scene, errors,
      boundary: 'fresh backend, App and browser; only a persisted source snapshot supplied after startup; native plugin, Mesh and Scene; software GPU' };
  } else {

    // These sources enter only after the real project App and UI are ready.
    const imports = Object.fromEntries(Object.entries(await createNodePackProgramImports(projectRoot)).map(([key, value]) => [key, value.identity]));
    const typed = language === 'ts' ? ': any' : '';
    const modules = {
      [`build.${language}`]: `import { createBoxGeometry } from '@forgeax/engine/geometry';
        import { AssetGuid } from '@forgeax/engine/pack/source';
        export function build({ packageId, values }${typed}) {
          return { ok: true, value: {
            box: createBoxGeometry(values.width, 2, 2).unwrap(),
            scene: { kind: 'scene', entities: { box: { components: { Name: { value: 'Runtime box' }, Transform: { pos: [0, 0, 0] }, MeshFilter: { assetHandle: AssetGuid.format(AssetGuid.derive(packageId, 'box')) }, MeshRenderer: {} } } } },
            behavior: { kind: 'plugin', module: { specifier: './behavior.${language}' } }
          } };
        }`,
      [`behavior.${language}`]: `import { Transform } from '@forgeax/engine/scene';
        export default { name: 'runtime-content-behavior', inject: ['world'], apply(ctx${typed}) {
          ctx.effect(() => {
            const marker = ctx.world.spawn({ component: Transform, data: { pos: [9, 0, 0] } }).unwrap();
            ctx.world.insertResource('runtime-content-behavior', { marker });
            return () => { ctx.world.despawn(marker).unwrap(); ctx.world.removeResource('runtime-content-behavior'); };
          });
        } };`,
    };
    const prepare = (entry, exported) => {
      const source = { entry, export: exported, modules, imports };
      return language === 'js' ? { artifact: preparePackProgram(source).unwrap() } : prepareRuntimePackProgram(source).unwrap();
    };
    const content = {
      source: { schemaVersion: '2.0.0', kind: 'scriptable-pack-source', source: `Runtime box generator.${language}`, packageId: parent, program: 'build', runtime: { dependencies: [] },
        parameters: [{ name: 'width', type: 'f32', default: 2, minimum: 1, maximum: 5 }], sceneComponents: projectScriptablePackSceneComponents([Name, Transform, MeshFilter, MeshRenderer]) },
      programs: { build: prepare(`build.${language}`, 'build'), behavior: prepare(`behavior.${language}`, 'default') },
    };
    phase = 'admit';
    await openRuntimeContent(page);
    const panel = page.getByTestId('runtime-content');
    await importRuntimeContent(page, panel, { name: 'runtime-content.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(content)) });
    await panel.getByLabel('Generator', { exact: true }).selectOption(parent);
    phase = 'generate';
    await panel.getByLabel('width', { exact: true }).fill('2');
    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    await panel.getByText(/current · Published generation/).waitFor();
    const initialPublicationStatus = await panel.getByText(/current · Published generation/).textContent();
    const instanceId = await panel.getByLabel('Instance', { exact: true }).inputValue();
    assert.ok(instanceId);
    const guid = key => AssetGuid.format(AssetGuid.derive(definePackageId(instanceId), key));
    const generated = await runtime('inspect');
    assert.equal(generated.executions[0].instance.values.width, 2);
    const rows = await client.listAssets(state.project.id, { targetId: state.projectTarget.targetId });
    assert.ok(rows.assets.some(asset => asset.guid === guid('box') && asset.kind === 'mesh'));
    assert.ok(rows.assets.some(asset => asset.guid === guid('behavior') && asset.kind === 'plugin'));
    phase = 'plugin';
    await panel.getByRole('button', { name: 'Install', exact: true }).click();
    await panel.getByText(/#\d+ · active/).waitFor();
    phase = 'preview';
    const opened = await client.openAsset(guid('box'), { projectId: state.project.id, tabId: state.selectedTabId });
    const previewTarget = opened.openRequest?.preview?.target;
    assert.ok(previewTarget, 'Engine must return a dedicated Mesh preview target');
    assert.notEqual(previewTarget.targetId, target.targetId);
    assert.notEqual(previewTarget.worldId, target.worldId);
    await page.getByTestId('panel-mesh-preview').locator('canvas').waitFor({ state: 'visible' });
    await page.getByTestId('mesh-material-slot-0').getByText('0 · Default', { exact: true }).waitFor();
    const capture = await captureTarget(previewTarget, 'initial-mesh');
    const initialBinding = await readBinding(previewTarget);
    assert.deepEqual(initialBinding.meta.aabb, [-1, -1, -1, 1, 1, 1]);
    await page.getByTestId('panel-mesh-properties').getByText(initialBinding.publication.digest, { exact: true }).waitFor();
    assert.ok(Math.abs(capture.pixels.aspect - 1) < 0.05, 'initial box front must be square');
    await page.screenshot({ path: join(evidence, 'generated.png') });

    phase = 'parameters';
    await sceneTab.click();
    await revealContentBrowser();
    await panel.getByLabel('width', { exact: true }).fill('4');
    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    await page.waitForFunction(previous => {
      const status = [...document.querySelectorAll('[data-testid="runtime-content"] [role="status"]')]
        .find(element => /^current · Published generation /.test(element.textContent));
      return status && status.textContent !== previous;
    }, initialPublicationStatus);
    assert.equal(await panel.getByLabel('Instance', { exact: true }).inputValue(), instanceId);
    const replaced = await runtime('inspect');
    assert.equal(replaced.executions[0].instance.values.width, 4);
    const inspected = await client.inspectAsset(guid('box'), {
      projectId: state.project.id, targetId: state.projectTarget.targetId,
      targetGeneration: state.projectTarget.generation,
    });
    // The runtime identity retains its content until explicit reload; source
    // publication is a separate Catalog fact used for an explicit reopen.
    assert.deepEqual(inspected.inspection.meta.aabb, [-1, -1, -1, 1, 1, 1]);
    assert.equal(inspected.inspection.publication.digest, initialBinding.publication.digest);
    assert.ok(inspected.inspection.source.publication);
    assert.notEqual(inspected.inspection.source.publication.digest, initialBinding.publication.digest);
    const oldBinding = await captureTarget(previewTarget, 'previous-consumer');
    assert.deepEqual(await readBinding(previewTarget), initialBinding);
    await page.locator('[role="tab"][data-page-id="page-mesh"]').click();
    await page.getByTestId('panel-mesh-properties').getByText(initialBinding.publication.digest, { exact: true }).waitFor();
    await page.getByTestId('panel-mesh-properties').locator('input[readonly][value="[-1,-1,-1,1,1,1]"]').waitFor();
    await page.screenshot({ path: join(evidence, 'previous-consumer-ui.png') });
    assert.ok(Math.abs(oldBinding.pixels.aspect - 1) < 0.05, 'existing consumer retains its previous result');
    const replacement = await client.openAsset(guid('box'), { projectId: state.project.id });
    const nextTarget = replacement.openRequest.preview.target;
    assert.equal(replacement.openRequest.asset.guid, guid('box'));
    await page.getByTestId('panel-mesh-preview').locator(`canvas[data-forgeax-asset-preview="${nextTarget.targetId}"]`).waitFor({ state: 'visible' });
    const nextCapture = await captureTarget(nextTarget, 'updated-mesh');
    const nextBinding = await readBinding(nextTarget);
    assert.notEqual(nextBinding.publication.digest, initialBinding.publication.digest);
    await page.getByTestId('panel-mesh-properties').getByText(nextBinding.publication.digest, { exact: true }).waitFor();
    await page.getByTestId('panel-mesh-properties').locator('input[readonly][value="[-2,-1,-1,2,1,1]"]').waitFor();
    assert.ok(Math.abs(nextCapture.pixels.aspect - 2) < 0.05, 'new consumer renders width=4');
    await page.screenshot({ path: join(evidence, 'updated.png') });

    phase = 'persist';
    await sceneTab.click();
    await revealContentBrowser();
    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Save content', exact: true }).click();
    const download = await downloadPromise;
    await download.saveAs(join(evidence, 'saved-content.json'));
    const persistedBytes = await readFile(join(evidence, 'saved-content.json'));
    const snapshot = JSON.parse(persistedBytes);
    assert.equal(snapshot.schemaVersion, 'runtime-pack-source/2');
    assert.equal(snapshot.instances.length, 1);
    assert.equal(snapshot.instances[0].packageId, instanceId);
    assert.equal(snapshot.instances[0].values.width, 4);
    await panel.getByRole('button', { name: 'Dispose', exact: true }).click();
    await panel.getByText('No installations.', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Withdraw instance', exact: true }).click();
    await panel.locator('summary').filter({ hasText: 'Admitted packs' }).click();
    await panel.getByRole('button', { name: 'Withdraw pack', exact: true }).click();
    assert.equal((await inspectUserContent()).packs.length, 0);
    assert.equal((await client.listAssets(state.project.id, { targetId: state.projectTarget.targetId })).assets.some(asset => asset.guid === guid('box')), false);
    await importRuntimeContent(page, panel, { name: 'saved-content.json', mimeType: 'application/json', buffer: persistedBytes });
    await panel.getByLabel('Generator', { exact: true }).selectOption(parent);
    await panel.getByLabel('Instance', { exact: true }).selectOption(instanceId);
    await panel.getByRole('button', { name: 'Install', exact: true }).click();
    await panel.getByText(/#\d+ · active/).waitFor();
    const restored = await runtime('inspect');
    assert.equal(restored.executions.find(item => item.instance.packageId === instanceId).instance.values.width, 4);
    const restoredPreview = await client.openAsset(guid('box'), { projectId: state.project.id });
    await page.getByTestId('panel-mesh-preview').locator(`canvas[data-forgeax-asset-preview="${restoredPreview.openRequest.preview.target.targetId}"]`).waitFor({ state: 'visible' });
    const restoredCapture = await captureTarget(restoredPreview.openRequest.preview.target, 'restored-mesh');
    assert.ok(Math.abs(restoredCapture.pixels.aspect - 2) < 0.05, 'restored source rebuilds matching geometry');

    const scene = await verifyScene(guid('scene'));
    const resourceCycles = await verifyResourceCycles(guid('box'));
    evidenceResult = { language, target, generated, replaced, restored, opened, rows, capture, oldBinding, initialBinding, nextBinding, nextCapture, restoredCapture, resourceCycles, ...scene, errors, boundary: 'actual Engine backend and View UI; live JS/TS admission, native plugin, parameter replacement, consumer publication and geometry, downloaded source restoration and Scene references; software GPU' };
  }
  assert.equal(page.url(), initialUrl);
  assert.equal((await client.getState()).projectTarget.worldId, target.worldId);
  assert.deepEqual(errors, []);
  const workspaceFailures = (await page.getByText(/Workspace command failed/).allInnerTexts())
    .filter(text => !text.includes('preview capture is busy'));
  assert.deepEqual(workspaceFailures, [], `UI command failures must fail the probe: ${JSON.stringify(workspaceFailures)}`);
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ ...evidenceResult, workload }, null, 2));
  console.log(`Runtime content Engine/View probe passed: ${evidence}`);
} catch (error) {
  const observation = captureSubject && page && !page.isClosed() ? await page.evaluate(targetId => {
      const canvas = [...document.querySelectorAll('canvas[data-forgeax-asset-preview]')]
        .find(candidate => candidate.dataset.forgeaxAssetPreview === targetId);
      const encoded = canvas?.dataset.forgeaxPreviewRhiWindow;
      if (encoded === undefined || encoded.length > 65_536) return undefined;
      try { return JSON.parse(encoded); } catch { return undefined; }
    }, captureSubject.targetId).catch(() => undefined) : undefined;
  await savePreviewRhiEvidence({ target: captureSubject, observation,
    captureRoot: process.env.FORGEAX_EVIDENCE_DIR ?? projectRoot, evidence })
    .catch(failure => console.error('Failed to preserve native preview RHI evidence:', failure));
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
    await writeFile(join(evidence, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => 'unavailable'));
    const diagnostics = await page.evaluate(() => {
      const frontend = globalThis.__forgeaxViewReady?.mounted?.frontendHost;
      return {
        workspaceReady: document.documentElement.dataset.forgeaxWorkspaceReady,
        nativeFibers: globalThis.__runtimeProofInspect?.(),
        state: frontend?.status,
        plugins: frontend?.assembly.inspection,
        inspection: globalThis.__forgeaxGameInspection?.renderer?.(),
        gpuResources: globalThis.__runtimePackGpuSample?.(),
        resources: performance.getEntriesByType('resource').map(entry => ({ name: entry.name, duration: entry.duration })),
      };
    }).catch(error => ({ error: String(error) }));
    await writeFile(join(evidence, 'failure-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  }
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ phase, errors, message: String(error) }, null, 2));
  throw error;
} finally {
  clearInterval(heartbeat);
  client?.close('runtime content verification complete');
  await browser?.close();
  await engine?.dispose();
  await rm(temporary, { recursive: true, force: true });
}
