import assert from 'node:assert/strict';

function previewPanelTestId(kind) {
  if (kind === 'material') return 'panel-material-preview';
  if (kind === 'mesh') return 'panel-mesh-preview';
  return 'panel-texture-preview';
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
    const extent = await page.waitForFunction(({ testId, targetId }) => {
      const host = document.querySelector(`[data-testid="${testId}"] [data-forgeax-preview-panel]`);
      const surface = host?.querySelector('canvas');
      const dpr = Math.max(1, devicePixelRatio);
      const width = Math.round((host?.clientWidth ?? 0) * dpr);
      const height = Math.round((host?.clientHeight ?? 0) * dpr);
      return width > 0 && height > 0 && surface?.dataset.forgeaxAssetPreview === targetId &&
        surface.width === width && surface.height === height ? [width, height] : false;
    }, { testId: previewPanelTestId(asset.kind), targetId: args.targetId });
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
