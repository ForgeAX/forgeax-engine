import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, transform } from 'esbuild';

// Native layout regression, not a GPU or full workspace substitute. Exercise
// normal Editor placement with Engine-like canvas size observation and restore.
const browser = await chromium.launch({
  executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE ?? '/opt/google/chrome-beta/chrome',
  headless: true, args: ['--disable-gpu'],
  chromiumSandbox: true,
});
try {
  const page = await browser.newPage();
  await page.setContent('<div id="surface" style="width:320px;height:240px"><canvas id="canvas" style="width:100%;height:100%;display:block"></canvas></div><main><section><article><div id="anchor" style="width:600px;height:400px"></div></article></section></main>');
  const sources = await Promise.all([
    '../packages/view-plugin-viewport/src/editor-surface.ts',
    '../packages/view-workspace-core/src/adopt-surface.ts',
  ].map(async path => {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    return (await transform(source, { loader: 'ts', format: 'esm', target: 'esnext' })).code;
  }));
  const result = await page.evaluate(async ([fitSource, borrowSource]) => {
    const { fitEditorSurface } = await import('data:text/javascript,' + encodeURIComponent(fitSource));
    const { borrowSurface } = await import('data:text/javascript,' + encodeURIComponent(borrowSource));
    const surface = document.querySelector('#surface');
    const canvas = document.querySelector('#canvas');
    const anchor = document.querySelector('#anchor');
    const errors = [];
    window.addEventListener('error', event => errors.push(event.message));
    const originalStyle = surface.getAttribute('style');
    const originalNext = surface.nextSibling;
    const restore = borrowSurface(surface, anchor);
    anchor.append(surface);
    const restoreFit = fitEditorSurface(surface);
    const engineObserver = new ResizeObserver(() => {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
    });
    engineObserver.observe(canvas);
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await settle();
    for (let step = 0; step < 20; step++) {
      anchor.style.width = `${600 + step * 5}px`;
      anchor.style.height = `${400 + step * 3}px`;
      await settle();
    }
    const width = canvas.width;
    const height = canvas.height;
    restoreFit();
    restore();
    restore();
    anchor.style.width = '100px';
    await settle();
    engineObserver.disconnect();
    return { errors, width, height, afterDispose: canvas.width,
      ownerPreserved: canvas.parentElement === surface && surface.parentElement === document.body,
      restored: surface.nextSibling === originalNext && surface.getAttribute('style') === originalStyle };
  }, sources);
  assert.deepEqual(result.errors, [], 'Normal DOM placement must not cause ResizeObserver loop notifications');
  assert.equal(result.width, 695);
  assert.equal(result.height, 457);
  assert.equal(result.afterDispose, 320);
  assert.equal(result.ownerPreserved, true);
  assert.equal(result.restored, true);
  const startupPlacement = await page.evaluate(async source => {
    const { keepSurfaceInContainer } = await import('data:text/javascript,' + encodeURIComponent(source));
    const surface = document.querySelector('#surface');
    const canvas = document.querySelector('#canvas');
    const originalNext = surface.nextSibling;
    const attributes = ['style', 'hidden', 'aria-label', 'data-forgeax-view-target-id',
      'data-forgeax-view-tab-id', 'data-forgeax-view-surface', 'data-forgeax-view-selected'];
    const originalAttributes = attributes.map(name => surface.getAttribute(name));
    const cycles = [];
    for (let cycle = 0; cycle < 8; cycle++) {
      const dock = document.createElement('section');
      document.body.append(dock);
      const stop = keepSurfaceInContainer({ document, getContainer: () => dock, getSurface: () => surface,
        onPlace(node) {
          for (const name of attributes) node.setAttribute(name, name === 'style' ? 'width:100%;height:100%' : 'borrowed');
        },
      });
      const attached = surface.parentElement === dock && canvas.isConnected;
      dock.remove();
      await new Promise(resolve => requestAnimationFrame(resolve));
      const returned = surface.parentElement === document.body && canvas.isConnected;
      stop(); stop();
      cycles.push({ attached, returned, preserved: canvas.parentElement === surface,
        restored: surface.nextSibling === originalNext && attributes.every((name, index) => surface.getAttribute(name) === originalAttributes[index]) });
    }
    return cycles;
  }, sources[1]);
  assert.equal(startupPlacement.length, 8);
  for (const cycle of startupPlacement) assert.deepEqual(cycle, { attached: true, returned: true, preserved: true, restored: true });
  // Asset preview retirement is published before Engine's asynchronous close.
  // Keep the actual borrowed canvas connected throughout that cleanup window.
  const previewBundle = await build({
    entryPoints: [fileURLToPath(new URL('../packages/view-workspace-core/src/preview-surface.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser',
  });
  await page.setContent('<div id="parking" hidden><div id="surface" style="width:320px;height:240px"><canvas style="width:100%;height:100%"></canvas></div><span id="next"></span></div><div id="host" style="width:600px;height:400px"></div>');
  const previewPlacement = await page.evaluate(async source => {
    const { bindWorkspacePreviewSurface } = await import('data:text/javascript,' + encodeURIComponent(source));
    const parking = document.querySelector('#parking');
    const surface = document.querySelector('#surface');
    const canvas = surface.querySelector('canvas');
    const host = document.querySelector('#host');
    const originalStyle = surface.getAttribute('style');
    const next = surface.nextSibling;
    const observations = [];
    const observer = new ResizeObserver(() => observations.push(canvas.isConnected));
    observer.observe(canvas);
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    let finishAttach;
    let detached = 0;
    const attachment = new Promise(resolve => { finishAttach = resolve; });
    const input = {
      presentation: { createSurface: () => surface, attach: () => attachment },
      target: { targetId: 'mesh-preview', generation: 1 },
      container: host,
      owner: { panelId: 'mesh-preview', pageType: 'mesh' },
    };
    const first = bindWorkspacePreviewSurface(input);
    await settle();
    const disposing = first.dispose();
    const returnedSynchronously = surface.parentElement === parking && canvas.isConnected;
    host.remove();
    await settle();
    const pendingCleanup = { connected: canvas.isConnected, detached, observations: [...observations] };
    document.body.append(host);
    const second = bindWorkspacePreviewSurface(input);
    finishAttach(() => { detached++; });
    await disposing;
    await settle();
    const rebound = surface.parentElement === host && canvas.isConnected && host.dataset.forgeaxAssetPreview === 'mesh-preview';
    await second.dispose();
    const restored = surface.parentElement === parking && surface.nextSibling === next && surface.getAttribute('style') === originalStyle;
    const third = bindWorkspacePreviewSurface(input);
    // React may remove the panel before its passive effect cleanup runs.
    host.remove();
    await settle();
    const removedPanelReturned = surface.parentElement === parking && canvas.isConnected;
    await third.dispose();
    const borrowedObservations = [...observations];
    // The observer remains real: an owner removing a visible canvas is a loss.
    parking.hidden = false;
    await settle();
    observations.length = 0;
    surface.remove();
    await settle();
    const ownerRemovalObserved = observations.includes(false);
    observer.disconnect();
    parking.append(surface);
    document.body.append(host);
    const failure = new Error('attachment failed');
    let caught;
    let resizeRequests = 0;
    try {
      bindWorkspacePreviewSurface({
        ...input,
        presentation: { createSurface: () => surface, attach: () => { throw failure; } },
        api: { resizePreview: async () => { resizeRequests++; } },
      });
    } catch (error) { caught = error; }
    const rollback = { originalError: caught === failure, returned: surface.parentElement === parking && canvas.isConnected };
    // Reclaiming after failure must not be undone by a leaked placement observer.
    parking.append(surface);
    await settle();
    await new Promise(resolve => setTimeout(resolve, 120));
    rollback.keeperStopped = surface.parentElement === parking;
    rollback.resizeRequests = resizeRequests;
    const replacement = bindWorkspacePreviewSurface({
      ...input,
      presentation: { createSurface: () => surface },
      owner: { panelId: 'replacement', pageType: 'mesh' },
    });
    rollback.claimReleased = replacement.ok;
    await replacement.dispose?.();
    return { returnedSynchronously, pendingCleanup, rebound, restored, removedPanelReturned, borrowedObservations, ownerRemovalObserved, detached, rollback };
  }, previewBundle.outputFiles[0].text);
  console.log(JSON.stringify({ boundary: 'preview-surface-parking', ...previewPlacement }));
  assert.equal(previewPlacement.returnedSynchronously, true, 'release placement to Engine parking before awaiting attach/detach');
  assert.deepEqual(previewPlacement.pendingCleanup, { connected: true, detached: 0, observations: previewPlacement.pendingCleanup.observations });
  assert.ok(previewPlacement.borrowedObservations.length > 0);
  assert.ok(previewPlacement.borrowedObservations.every(Boolean), 'native ResizeObserver must never observe a disconnected borrowed canvas');
  assert.equal(previewPlacement.rebound, true, 'old asynchronous cleanup must preserve the new binding');
  assert.equal(previewPlacement.restored, true);
  assert.equal(previewPlacement.removedPanelReturned, true);
  assert.equal(previewPlacement.ownerRemovalObserved, true, 'real owner removal remains observable');
  assert.equal(previewPlacement.detached, 3);
  assert.deepEqual(previewPlacement.rollback, { originalError: true, returned: true, keeperStopped: true, resizeRequests: 0, claimReleased: true });
  // A descendant's explicit visibility must not keep an inactive Dock page in
  // layout. Native intersection is the existing Engine preview pacing signal.
  await page.setContent('<main id="page" style="position:relative;width:640px;height:480px"><div id="row" class="fx-view-workspace-row is-active"><canvas id="child" style="visibility:visible;width:100%;height:100%"></canvas></div></main>');
  await page.addStyleTag({ content: await readFile(new URL('../packages/viewer/src/styles.css', import.meta.url), 'utf8') });
  const visibility = await page.evaluate(async () => {
    const row = document.querySelector('#row');
    const child = document.querySelector('#child');
    const observations = [];
    const observer = new IntersectionObserver(([entry]) => observations.push(entry.isIntersecting));
    observer.observe(child);
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await settle();
    const active = { visible: child.checkVisibility(), intersecting: observations.at(-1) };
    row.classList.remove('is-active');
    row.hidden = true;
    await settle();
    const hidden = { visible: child.checkVisibility(), intersecting: observations.at(-1), width: child.getBoundingClientRect().width };
    document.querySelector('#page').style.width = '800px';
    row.hidden = false;
    row.classList.add('is-active');
    await settle();
    const resumed = { visible: child.checkVisibility(), intersecting: observations.at(-1), width: child.getBoundingClientRect().width, sameNode: child === document.querySelector('#child') };
    observer.disconnect();
    return { active, hidden, resumed, observations };
  });
  assert.deepEqual(visibility.active, { visible: true, intersecting: true });
  assert.deepEqual(visibility.hidden, { visible: false, intersecting: false, width: 0 }, JSON.stringify(visibility));
  assert.deepEqual(visibility.resumed, { visible: true, intersecting: true, width: 800, sameNode: true });
  console.log(JSON.stringify({ passed: true, boundary: 'owner-surface-resize', ...result, startupPlacement, previewPlacement, visibility }));
} finally { await browser.close(); }
