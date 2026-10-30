import assert from 'node:assert/strict';

export const SKINNED_PREVIEW_SOURCE_KEYS = [
  'mesh/player', 'mesh/steve',
  'material/player-body', 'material/player-accent', 'material/player-cloth', 'material/player-signal',
  'material/steve-skin', 'material/steve-outer',
];

export function selectSkinnedPreviewAssets(assets) {
  return SKINNED_PREVIEW_SOURCE_KEYS.map(sourceKey => {
    const asset = assets.find(candidate => candidate.sourceKey === sourceKey);
    assert.ok(asset, `missing skinned preview fixture ${sourceKey}`);
    return asset;
  });
}

export function assertSkinnedPreviewPixels(stats, label, transparent = false) {
  assert.ok(stats.width > 0 && stats.height > 0, `${label}: image dimensions`);
  assert.ok(stats.covered > stats.width * stats.height * 0.005, `${label}: empty rendered subject`);
  assert.ok(stats.colors > 4, `${label}: flat rendered subject`);
  if (transparent) {
    assert.ok(stats.covered < stats.width * stats.height, `${label}: transparent thumbnail background`);
    assert.equal(stats.edgePixels, 0, `${label}: cropped thumbnail subject`);
  } else {
    assert.ok(stats.changed > stats.width * stats.height * 0.005, `${label}: background-only preview`);
    assert.equal(stats.edgePixels, 0, `${label}: cropped preview subject`);
    assert.equal(stats.opaque, stats.width * stats.height, `${label}: lost opaque preview background`);
  }
}

async function previewPixelStats(page, png, background) {
  return page.evaluate(async ({ source, background }) => {
    const decode = async source => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height);
    };
    const { data, width, height } = await decode(source);
    const reference = background ? await decode(background) : undefined;
    if (reference && (reference.width !== width || reference.height !== height)) throw new Error('preview background extent changed');
    let covered = 0, opaque = 0, changed = 0, edgePixels = 0;
    const colors = new Set();
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset + 3] < 8) continue;
      covered++;
      if (data[offset + 3] >= 250) opaque++;
      colors.add((data[offset] >> 3) * 1024 + (data[offset + 1] >> 3) * 32 + (data[offset + 2] >> 3));
      const foreground = !reference || Math.abs(data[offset] - reference.data[offset]) + Math.abs(data[offset + 1] - reference.data[offset + 1]) + Math.abs(data[offset + 2] - reference.data[offset + 2]) > 32;
      if (!foreground) continue;
      changed++;
      const pixel = offset / 4, x = pixel % width, y = Math.floor(pixel / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edgePixels++;
    }
    return { width, height, covered, opaque, changed, edgePixels, colors: colors.size };
  }, { source: png, background });
}

async function backgroundCapture(workspace, args) {
  const settled = async () => {
    const deadline = Date.now() + 10_000;
    let camera, since = Date.now(), version;
    do {
      camera = await workspace.getCamera(args);
      if (!camera.committed || camera.interaction || camera.version !== version) since = Date.now();
      version = camera.version;
      if (camera.committed && !camera.interaction && Date.now() - since >= 150) return camera;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.fail('resource preview camera did not settle before background capture');
  };
  const before = await settled();
  const displaced = structuredClone(before.camera);
  const [x, y, z, w] = displaced.transform.quat;
  const right = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
  displaced.transform.pos = displaced.transform.pos.map((position, axis) => position + 1000 * right[axis]);
  const set = async camera => {
    const current = await settled();
    const interaction = { ...args, interactionId: `background-${crypto.randomUUID()}` };
    await workspace.beginCamera({ ...interaction, baseVersion: current.version });
    try {
      await workspace.updateCamera({ ...interaction, camera });
      await workspace.commitCamera({ ...interaction, operationId: crypto.randomUUID(), expectedVersion: current.version });
    } catch (error) {
      await workspace.abortCamera(interaction);
      throw error;
    }
  };
  // Translate without rotating: the infinite environment stays pixel-aligned.
  await set(displaced);
  try { return (await workspace.capture(args)).png; }
  finally { await set(before.camera); }
}

/** Real game-3d assets; transparent native thumbnails falsify background-only captures. */
export async function verifySkinnedResourcePreviews({ page, workspace, save = async () => {}, onPreview = async () => {} }) {
  const initial = workspace.snapshot();
  const assets = selectSkinnedPreviewAssets(initial.assets);
  assert.ok(initial.scenePreview?.target, 'open the game-3d Scene before verifying resource previews');
  const observations = [];
  const backgrounds = new Map();
  const capture = async (args, label) => {
    const image = await workspace.capture(args);
    assert.deepEqual(image.errors ?? [], [], `${label}: render errors`);
    const pixels = await previewPixelStats(page, image.png, backgrounds.get(args.targetId));
    assertSkinnedPreviewPixels(pixels, label);
    await save(label, image.png);
    observations.push({ label, targetId: args.targetId, frameId: image.frameId, pixels });
  };
  for (const asset of assets) {
    const opened = await workspace.openAsset({ projectId: initial.project.id, guid: asset.guid, width: 512, height: 512 });
    const preview = opened.openRequest?.preview;
    assert.equal(preview?.asset.guid, asset.guid);
    assert.notEqual(preview.target.targetId, initial.scenePreview.target.targetId);
    const args = { targetId: preview.target.targetId, targetGeneration: preview.target.generation };
    const panelId = previewPanelTestId(asset.kind);
    const resetId = asset.kind === 'mesh' ? 'mesh-reset-view' : 'material-restore-view';
    await page.getByTestId(panelId).waitFor({ state: 'visible' });
    await page.waitForFunction(({ panelId, resetId }) => {
      const panel = document.querySelector(`[data-testid="${panelId}"]`);
      const failure = panel?.querySelector('[role="alert"]')?.textContent;
      if (failure) throw new Error(failure);
      const reset = panel?.querySelector(`[data-testid="${resetId}"]`);
      return reset instanceof HTMLButtonElement && !reset.disabled;
    }, { panelId, resetId });
    const tree = await workspace.getSceneTree(args);
    assert.ok(tree.nodes.some(node => node.componentNames.includes('Skin')), `${asset.sourceKey}: native Skin binding`);
    const label = asset.sourceKey.replaceAll('/', '-');
    const background = await backgroundCapture(workspace, args);
    backgrounds.set(args.targetId, background);
    await save(`${label}-background`, background);
    await capture(args, label);
    await onPreview({ asset, preview });
    if (asset.kind === 'material') {
      await workspace.invoke('preview.material.rotate', { ...args, yaw: 0.6, pitch: 0.3 });
      for (const mesh of ['sphere', 'cylinder', 'plane', 'cube']) {
        await workspace.invoke('preview.material.set', { ...args, mesh });
        await capture(args, `${label}-${mesh}`);
      }
      await workspace.invoke('preview.material.reset', args);
    } else {
      await workspace.invoke('preview.display.set', { ...args, mode: 'wireframe', bounds: true });
      assert.ok(!(await workspace.getSceneTree(args)).nodes.some(node => node.componentNames.includes('Skin')));
      await capture(args, `${label}-wireframe`);
      await workspace.invoke('preview.display.set', { ...args, mode: 'material', bounds: false });
      await capture(args, `${label}-restored`);
      const uv = await workspace.invoke('preview.display.get', { ...args, uvChannel: 0 });
      assert.ok(uv.uv.layout.coordinates.length > 0);
    }
    const selected = page.locator('[data-page-id][aria-selected="true"]');
    const id = await selected.getAttribute('data-page-id');
    await selected.hover();
    await page.locator(`[data-page-close="${id}"]`).click();
    await page.getByTestId(panelId).waitFor({ state: 'detached' });
    await assert.rejects(workspace.getSceneTree(args), error => /target-mismatch/.test(error.code));
  }
  const deadline = Date.now() + 180_000;
  let thumbnails;
  do {
    thumbnails = (await workspace.invoke('assets.thumbnails', { projectId: initial.project.id, guids: assets.map(asset => asset.guid) })).thumbnails;
    for (const row of thumbnails) assert.ok(!['failed', 'unsupported'].includes(row.state), JSON.stringify(row.error ?? row));
    if (thumbnails.every(row => row.state === 'ready')) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  for (const row of thumbnails) {
    assert.equal(row.state, 'ready', `${row.guid}: thumbnail readiness`);
    const pixels = await previewPixelStats(page, row.dataUrl);
    assertSkinnedPreviewPixels(pixels, row.guid, true);
    await save(`thumbnail-${row.guid}`, row.dataUrl);
    observations.push({ label: `thumbnail-${row.guid}`, pixels });
  }
  assert.equal(workspace.snapshot().scenePreview.target.targetId, initial.scenePreview.target.targetId);
  return observations;
}

function previewPanelTestId(kind) {
  if (kind === 'material') return 'panel-material-preview';
  if (kind === 'mesh') return 'panel-mesh-preview';
  return 'panel-texture-preview';
}

export function inlinePreviewReadyExtent({ testId, targetId }) {
  const host = document.querySelector(`[data-testid="${testId}"] [data-forgeax-preview-panel]`);
  const surface = host?.querySelector('canvas');
  const dpr = Math.max(1, devicePixelRatio);
  const width = Math.round((host?.clientWidth ?? 0) * dpr);
  const height = Math.round((host?.clientHeight ?? 0) * dpr);
  return width > 0 && height > 0 && surface?.dataset.forgeaxAssetPreview === targetId &&
    surface.width === width && surface.height === height &&
    surface.forgeaxFrameProgress?.completed?.presentation === 'ready' ? [width, height] : false;
}

export async function verifyInlinePreviews({ page, workspace, onCaptureFailure }) {
  const capturePreview = async (args, worldId) => {
    try {
      return await workspace.capture(args);
    } catch (error) {
      try { await onCaptureFailure?.({ target: { ...args, worldId }, error }); }
      catch (failure) { console.error('Failed to preserve inline preview evidence:', failure); }
      throw error;
    }
  };
  const initial = workspace.snapshot();
  const scene = initial.scenePreview;
  const assets = ['mesh', 'material'].map(kind => initial.assets.find(asset => asset.kind === kind));
  assert.ok(assets.every(Boolean), 'the probe must exercise real mesh and material previews');
  const opened = [];
  for (const asset of assets) {
    const state = await workspace.openAsset({ projectId: initial.project.id, guid: asset.guid, width: 320, height: 240 });
    assert.equal(state.scenePreview.target.targetId, scene.target.targetId);
    const preview = state.openRequest?.preview;
    assert.ok(preview?.target, `Engine must expose a type-preview target for ${asset.kind}`);
    assert.equal(preview.asset.guid, asset.guid);
    assert.notEqual(preview.target.targetId, scene.target.targetId);
    assert.notEqual(preview.target.worldId, scene.target.worldId);
    const args = { targetId: preview.target.targetId, targetGeneration: preview.target.generation };
    const assetPage = page.locator(`[data-page-id="page-${asset.kind}"][aria-selected="true"]`);
    await assetPage.waitFor();
    const panel = page.getByTestId(previewPanelTestId(asset.kind));
    const canvas = panel.locator(`canvas[data-forgeax-asset-preview="${args.targetId}"]`);
    await canvas.waitFor({ state: 'visible' });
    assert.equal(await panel.locator('canvas').count(), 1, 'the tab hosts the exact Engine preview canvas');
    assert.equal(await page.locator('[aria-label="Asset previews"]').count(), 0);
    assert.equal(await page.locator('[data-forgeax-view-mount-host="viewport"] [data-forgeax-asset-preview]').count(), 0);
    const tree = await workspace.getSceneTree(args);
    assert.equal(tree.worldId, preview.target.worldId);
    assert.ok(tree.nodes.length > 0);
    const extent = await page.waitForFunction(inlinePreviewReadyExtent,
      { testId: previewPanelTestId(asset.kind), targetId: args.targetId });
    const dimensions = await extent.jsonValue();
    await extent.dispose();
    {
      // Both panels seed their orbit pivot after hosting/resizing the canvas.
      // Their existing reset controls become available after that transaction;
      // a visible canvas alone does not establish a committed camera.
      const resetId = asset.kind === 'mesh' ? 'mesh-reset-view' : 'material-restore-view';
      await page.waitForFunction(({ panelId, resetId }) => {
        const panel = document.querySelector(`[data-testid="${panelId}"]`);
        const failure = panel?.querySelector('[role="alert"]')?.textContent;
        if (failure) throw new Error(failure);
        const reset = panel?.querySelector(`[data-testid="${resetId}"]`);
        return reset instanceof HTMLButtonElement && !reset.disabled;
      }, { panelId: previewPanelTestId(asset.kind), resetId });
      const camera = await workspace.getCamera(args);
      assert.equal(camera.committed, true, `${asset.kind} preview initialization must commit before capture`);
      assert.equal(camera.interaction, null);
    }
    const capture = await capturePreview(args, tree.worldId);
    assert.deepEqual([capture.width, capture.height], dimensions, 'visible previews render at the panel device-pixel extent');
    assert.match(capture.png, /^data:image\/png/);
    const visibleBytes = Buffer.from(capture.png.split(',')[1], 'base64');
    assert.deepEqual([visibleBytes.readUInt32BE(16), visibleBytes.readUInt32BE(20)], dimensions);
    assert.deepEqual(await page.locator('.fx-error-notice').allTextContents(), [], 'asset preview must not leave workspace command errors');
    await page.screenshot({ path: `/tmp/view-asset-${asset.kind}.png` });
    opened.push({ args, kind: asset.kind, dimensions, worldId: tree.worldId, frameId: capture.frameId });
  }
  await page.locator('[data-page-id="page-scene"]').click();
  await page.locator('[data-forgeax-view-mount-host="viewport"]').waitFor();
  assert.equal(await page.locator('[aria-label="Asset previews"]').count(), 0);
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(workspace.snapshot().previews.length, 3);
  await workspace.selectTarget({ targetId: scene.target.targetId });
  const sceneCapture = await workspace.capture({ targetId: scene.target.targetId, targetGeneration: scene.target.generation });
  assert.match(sceneCapture.png, /^data:image\/png/);
  await page.screenshot({ path: '/tmp/view-inline-previews.png' });
  console.error('asset tabs host exact Engine preview canvases; independent Worlds, panel sizing and capture passed');
  return async () => {
    await page.locator('[data-page-id="page-scene"]').click();
    for (const { args, kind, dimensions, worldId, frameId } of opened) {
      assert.equal((await workspace.getSceneTree(args)).worldId, worldId);
      const captured = await capturePreview(args, worldId);
      assert.ok(captured.frameId > frameId, 'the original asset renderer must still submit frames after Play');
      assert.deepEqual(captured.errors ?? [], []);
      assert.deepEqual([captured.width, captured.height], dimensions);
      // The hidden page retains its owner after Play. Test its native extent
      // before explicit page close acknowledges that owner's retirement.
      const resized = await workspace.resizePreview({ ...args, width: 400, height: 300 });
      assert.equal(resized.target.generation, args.targetGeneration);
      assert.equal(resized.target.worldId, worldId);
      const resizedCapture = await capturePreview(args, worldId);
      assert.deepEqual([resizedCapture.width, resizedCapture.height], [400, 300]);
      assert.deepEqual(resizedCapture.errors ?? [], []);
      const bytes = Buffer.from(resizedCapture.png.split(',')[1], 'base64');
      assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [400, 300]);
      assert.equal((await workspace.getSceneTree(args)).worldId, worldId);
      await page.locator(`[data-page-id="page-${kind}"]`).hover();
      await page.locator(`[data-page-close="page-${kind}"]`).click();
      await page.getByTestId(previewPanelTestId(kind)).waitFor({ state: 'detached' });
      const retired = error => /target-mismatch/.test(error.code);
      await assert.rejects(workspace.getSceneTree(args), retired);
      await assert.rejects(workspace.resizePreview({ ...args, width: 400, height: 300 }), retired);
      await assert.rejects(workspace.capture(args), retired);
      await workspace.closePreview(args).catch(error => assert.match(error.code, /target-mismatch/));
    }
    assert.equal(workspace.snapshot().previews.length, 1);
    assert.equal(workspace.snapshot().preview.target.targetId, scene.target.targetId);
    assert.equal(workspace.snapshot().workspaceTargetLost, false, 'closed asset targets must not disconnect the scene');
    await page.waitForFunction(() => document.querySelectorAll('canvas[data-forgeax-view-surface="engine-canvas"], [data-forgeax-view-surface="engine-canvas"] canvas').length >= 1);
    console.error('retained previews resize and capture after Play; page close retires exact targets independently and preserves the editing World');
  };
}
