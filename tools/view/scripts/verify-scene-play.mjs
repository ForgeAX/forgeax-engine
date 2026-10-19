import assert from 'node:assert/strict';

export async function verifyScenePlay({ page, live, sameRun, cycles = 10 }) {
  const workspace = live.pageWorkspace;
  const scene = workspace.snapshot().scenePreview ?? workspace.snapshot().preview;
  let previousPlayTargetId;
  for (let cycle = 0; cycle < cycles; cycle++) {
    console.error('starting Play', cycle + 1);
    const opened = await workspace.invoke('play.start', { projectId: workspace.snapshot().project.id });
    assert.equal(opened.targetBinding, 'play');
    assert.equal(opened.scenePreview.target.targetId, scene.target.targetId);
    const target = opened.play.target;
    const args = { targetId: target.targetId, targetGeneration: target.generation };
    assert.notEqual(target.targetId, scene.target.targetId);
    assert.notEqual(target.targetId, previousPlayTargetId, 'each Play starts a fresh Engine target');
    previousPlayTargetId = target.targetId;
    await page.locator('iframe[data-forgeax-scene-play]').waitFor({ state: 'attached' });
    const frame = page.frames().find(value => value.url().includes(target.targetId));
    const waitingSince = performance.now();
    let ready;
    try { ready = await workspace.invoke('play.ready', args); }
    catch (error) {
      console.error('Play startup documents', JSON.stringify(await Promise.all(page.frames().map(async frame => ({
        origin: new URL(frame.url()).origin,
        state: await frame.evaluate(() => ({ title: document.title, canvases: document.querySelectorAll('canvas').length,
          text: document.body.innerText.slice(0, 2000), dataset: { ...document.documentElement.dataset }, bootstrap: globalThis.__forgeaxRendererBootstrap })).catch(() => null),
      }))), null, 2));
      throw error;
    }
    const game = frame ?? page.frames().find(value => value.url().includes(target.targetId));
    assert.ok(game, 'the Engine-generated game target must be mounted');
    console.error('Play startup timing', { waitMs: Math.round(performance.now() - waitingSince), renderer: await game.evaluate(() => globalThis.__forgeaxRendererBootstrap) });
    const progress = setInterval(() => { void game.evaluate(() => ({ frame: document.documentElement.dataset.forgeaxFrameSubmitted, renderer: globalThis.__forgeaxGameInspection?.renderer(), canvas: { width: document.querySelector('canvas')?.width, height: document.querySelector('canvas')?.height } })).then(value => console.error('Play frames', JSON.stringify(value))).catch(() => {}); }, 10_000);
    progress.unref();
    try {
      await game.waitForFunction(count => Number(document.documentElement.dataset.forgeaxFrameSubmitted ?? 0) >= count || globalThis.__forgeaxGameInspection?.renderer().execution.engine.health === 'faulted' || globalThis.__forgeaxGameInspection?.renderer().execution.world.health === 'poisoned', cycle === 0 ? 60 : 3, { timeout: 180_000 });
    } finally { clearInterval(progress); }
    const execution = await game.evaluate(() => globalThis.__forgeaxGameInspection?.renderer());
    assert.notEqual(execution?.execution.engine.health, 'faulted', JSON.stringify(execution));
    assert.notEqual(execution?.execution.world.health, 'poisoned', JSON.stringify(execution));
    assert.deepEqual(await page.locator('.fx-error-notice').allTextContents(), [], `Play cycle ${cycle + 1} startup must admit panel queries through first readiness`);

    assert.equal(await game.locator('#forgeax-view-root').count(), 0, 'game projection excludes the View shell');
    assert.equal(await game.locator('canvas').count(), 1);
    assert.equal(await page.locator('iframe[data-forgeax-scene-play]').count(), 1);
    const tree = await workspace.getSceneTree(args);
    assert.equal(tree.targetId, target.targetId);
    const clock = tree.nodes.find(node => node.name === 'Runtime clock');
    assert.ok(clock, 'ordinary game plugins are active in Play');
    const frames = async () => (await workspace.invoke('entity.inspect', { ...args, entityId: clock.entityId })).components.find(component => component.name === 'ProofClock').values.frames;
    const gameFramesBefore = await frames();
    const entity = tree.nodes.find(node => node.name === 'Lifecycle proof cube') ?? tree.nodes.find(node => node.name !== null) ?? tree.nodes[0];
    assert.ok(entity);
    await workspace.selectSceneEntity({ ...args, entityId: entity.entityId });
    await page.waitForFunction(id => document.querySelector('[data-testid="panel-inspector"]')?.getAttribute('data-entity-id') === id, entity.entityId);
    const inspected = await workspace.invoke('entity.inspect', { ...args, entityId: entity.entityId });
    assert.ok(inspected.components.length > 0);
    await assert.rejects(workspace.invoke('entity.inspect', { ...args, entityId: entity.entityId.replace(target.targetId, scene.target.targetId) }));
    const observed = await workspace.invoke('target.control', { ...args, mode: 'observer' });
    assert.equal(observed.mode, 'observer');
    assert.equal((await workspace.getCamera(args)).camera.control, 'observer');
    // Capture waits for a completed frame, but layout can resize again before
    // picking. Reacquire only that rejected extent; other failures stay fatal.
    const pickSignal = AbortSignal.timeout(10_000);
    let captured;
    let picked;
    for (;;) {
      pickSignal.throwIfAborted();
      captured = await workspace.invoke('preview.capture', args, { signal: pickSignal });
      try {
        picked = await workspace.invoke('target.pick', { ...args, x: captured.width / 2, y: captured.height / 2 }, { signal: pickSignal });
        break;
      } catch (error) {
        if (error.code !== 'view-workspace-frame-unavailable' || error.detail?.cause?.reason !== 'extent-mismatch') throw error;
        console.error('Play pick awaiting resized frame', { cycle: cycle + 1, ...error.detail.cause });
      }
    }
    assert.ok(picked.frameId >= captured.frameId, 'picking uses the captured frame or a newer submission');
    assert.equal(picked.entityId, entity.entityId, 'picking uses the submitted game frame');
    await workspace.invoke('entity.focus', { ...args, entityId: entity.entityId });
    const beforeCamera = await workspace.getCamera(args);
    const before = await game.evaluate(() => Number(document.documentElement.dataset.forgeaxFrameSubmitted));
    await workspace.selectTarget({ targetId: scene.target.targetId });
    assert.equal(workspace.snapshot().preview.target.targetId, scene.target.targetId);
    await workspace.selectTarget({ targetId: target.targetId });
    await game.waitForFunction(value => Number(document.documentElement.dataset.forgeaxFrameSubmitted) > value, before);
    assert.equal((await workspace.getSceneTree(args)).worldId, tree.worldId);
    // Startup owns input until its completed-frame fade has actually retired.
    // Renderer readiness and three submitted frames alone do not admit gestures.
    await game.locator('#forgeax-loading').waitFor({ state: 'hidden' });
    const camera = game.locator('canvas');
    const box = await camera.boundingBox();
    assert.ok(box?.width);
    await game.evaluate(() => {
      // Game-authored UI may cover the canvas. Keep the same real mouse/key
      // path while making this previously intermittent failure deterministic.
      const rect = document.querySelector('canvas').getBoundingClientRect();
      const overlay = document.createElement('div');
      overlay.dataset.observerInputProof = 'true';
      Object.assign(overlay.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, zIndex: '2147483647', pointerEvents: 'auto' });
      document.body.append(overlay);
      globalThis.__inputProof = [];
      const controller = new AbortController();
      globalThis.__inputProofCleanup = () => { controller.abort(); overlay.remove(); };
      for (const type of ['pointerdown', 'mousedown', 'contextmenu', 'keydown', 'keyup', 'pointerup', 'blur']) window.addEventListener(type, event => globalThis.__inputProof.push({ type, code: event.code, button: event.button, x: event.clientX, y: event.clientY, prevented: event.defaultPrevented, target: event.target?.tagName }), { capture: true, signal: controller.signal });
    });
    // A target command commits Engine state before the consuming UI paints it.
    // An arbitrary iframe at this point can still be the previous Scene.
    await page.waitForFunction(({ x, y, targetId }) => document.elementFromPoint(x, y)?.getAttribute('data-forgeax-scene-play') === targetId,
      { x: box.x + box.width / 2, y: box.y + box.height / 2, targetId: target.targetId });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: 'right' });
    try {
      await page.keyboard.down('w');
      // A fixed key pulse can fit entirely between software-rendered frames.
      // Keep real input held until the Engine reports movement, with a deadline.
      const signal = AbortSignal.timeout(10_000);
      let moved = false;
      while (!signal.aborted) {
        const sampled = await workspace.getCamera(args, { signal });
        if (sampled.camera.transform.pos.some((value, index) => value !== beforeCamera.camera.transform.pos[index])) {
          moved = true;
          break;
        }
        await page.waitForTimeout(50);
      }
      assert.ok(moved, 'held game-document input must move the observer within 10 seconds');
      await page.mouse.move(box.x + box.width / 2 + 15, box.y + box.height / 2 + 5);
    } finally {
      await page.keyboard.up('w');
      await page.mouse.up({ button: 'right' });
      console.error('input trace', await game.evaluate(() => globalThis.__inputProof), JSON.stringify({ before: beforeCamera.camera.transform, after: (await workspace.getCamera(args)).camera.transform }));
    }
    await page.waitForTimeout(100);
    const afterCamera = await workspace.getCamera(args);
    await game.evaluate(() => globalThis.__inputProofCleanup());
    assert.ok(Array.isArray(beforeCamera.camera.transform.pos));
    assert.notDeepEqual(afterCamera.camera.transform.pos, beforeCamera.camera.transform.pos, 'actual game-document input moves the observer');
    console.error('Play lifecycle stage', { cycle: cycle + 1, stage: 'possess-start', at: new Date().toISOString() });
    const possessed = await workspace.invoke('target.control', { ...args, mode: 'player' });
    assert.equal(possessed.camera.control, 'game');
    assert.ok(await frames() > gameFramesBefore, 'game systems continue through observer control');
    const toolbar = page.getByRole('toolbar', { name: 'Scene execution' });
    await toolbar.locator('[data-action="scene.eject"]').click();
    await toolbar.locator('[data-action="scene.possess"]').waitFor();
    assert.equal((await workspace.getCamera(args)).camera.control, 'observer');
    await toolbar.locator('[data-action="scene.possess"]').click();
    await toolbar.locator('[data-action="scene.eject"]').waitFor();
    assert.equal((await workspace.getCamera(args)).camera.control, 'game');

    console.error('Play lifecycle stage', { cycle: cycle + 1, stage: 'toolbar-complete', at: new Date().toISOString() });
    if (cycle === 0) {
      let sawTransient = false;
      let sawRemoval = false;
      let sawReparent = false;
      let transientId;
      const deadline = Date.now() + 35_000;
      while ((!sawTransient || !sawRemoval || !sawReparent) && Date.now() < deadline) {
        const changedTree = await workspace.getSceneTree(args);
        const transient = changedTree.nodes.find(node => node.name === 'Runtime transient');
        if (transient) {
          sawTransient = true; transientId = transient.entityId;
          const branch = changedTree.nodes.find(node => node.name === 'Runtime branch');
          assert.ok([clock.entityId, branch.entityId].includes(transient.parentId));
          if (transient.parentId === branch.entityId) sawReparent = true;
        }
        else if (sawTransient) sawRemoval = true;
        await page.waitForTimeout(100);
      }
      assert.ok(sawTransient && sawRemoval && sawReparent, 'hierarchy follows live creation, reparenting and destruction');
      await assert.rejects(workspace.invoke('entity.inspect', { ...args, entityId: transientId }));
      const outerColor = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await game.evaluate(() => {
        const style = document.createElement('style'); style.textContent = 'body { background: rgb(255, 0, 100) !important; }'; document.head.append(style);
        const ui = document.createElement('div'); ui.id = 'play-owned-hud'; ui.textContent = 'Play owned HUD'; document.body.append(ui);
        window.__dogfoodTimer = setInterval(() => { window.__dogfoodTicks = (window.__dogfoodTicks ?? 0) + 1; }, 10);
      });
      assert.equal(await page.locator('#play-owned-hud').count(), 0);
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), outerColor);
      await page.screenshot({ path: '/tmp/view-scene-play.png' });
    }
    console.error('Play lifecycle stage', { cycle: cycle + 1, stage: 'independent-status-start', at: new Date().toISOString() });
    await sameRun();
    console.error('Play lifecycle stage', { cycle: cycle + 1, stage: 'independent-status-complete', at: new Date().toISOString() });
    // Keep both hierarchy and Inspector polling while the Play identity retires.
    await workspace.selectSceneEntity({ ...args, entityId: entity.entityId });
    await page.waitForFunction(id => document.querySelector('[data-testid="panel-inspector"]')?.getAttribute('data-entity-id') === id, entity.entityId);
    let lastPlayImage;
    if (cycle === 0) {
      await page.locator('[data-page-id="page-display"]').click();
      const capture = page.locator('.fx-view-run-observer');
      await capture.getByLabel('Capture source').selectOption('play');
      const image = capture.getByRole('img', { name: 'Latest Engine run capture', includeHidden: true });
      await image.waitFor({ state: 'visible', timeout: 30_000 });
      assert.equal(await capture.locator('input').count(), 0);
      assert.equal(await capture.getByRole('button', { name: /View project run|Reconnect current run/ }).isVisible(), false);
      await page.screenshot({ path: '/tmp/view-runtime-capture-play.png' });
      await page.locator('[data-page-id="page-scene"]').click();
      lastPlayImage = await image.getAttribute('src');
      assert.ok(lastPlayImage?.startsWith('data:image/png;base64,'));
    }
    console.error('Play lifecycle stage', { cycle: cycle + 1, stage: 'stop-start', at: new Date().toISOString() });
    await workspace.invoke('play.stop', args);
    console.error('Play lifecycle stage', { cycle: cycle + 1, stage: 'stop-complete', at: new Date().toISOString() });
    await page.waitForFunction(() => !document.querySelector('iframe[data-forgeax-scene-play]'));
    assert.equal(workspace.snapshot().preview.target.targetId, scene.target.targetId);
    assert.equal(workspace.snapshot().play, null);
    await assert.rejects(workspace.getSceneTree(args));
    assert.equal(workspace.snapshot().workspaceTargetLost, false, 'a stopped Play target must not disconnect the scene');
    assert.equal(await page.locator('.fx-view-header__recovery').count(), 0);
    assert.deepEqual(await page.locator('.fx-error-notice').allTextContents(), [], `Play cycle ${cycle + 1} must not report retired panel queries`);
    if (cycle === 0) {
      await page.locator('[data-page-id="page-display"]').click();
      const capture = page.locator('.fx-view-run-observer');
      await capture.getByRole('status').filter({ hasText: 'Run ended' }).waitFor();
      assert.equal(await capture.getByRole('img', { name: 'Latest Engine run capture' }).getAttribute('src'), lastPlayImage);
      await page.screenshot({ path: '/tmp/view-runtime-capture-play-stopped.png' });
      await page.locator('[data-page-id="page-scene"]').click();
    }
    console.error('scene Play lifecycle passed', cycle + 1, tree.worldId);
  }
}

export async function verifyScenePlayFailure({ page, live, sameRun }) {
  assert.deepEqual(await page.locator('.fx-error-notice').allTextContents(), [], 'Normal Play cycles must leave no command errors');
  const workspace = live.pageWorkspace;
  const scene = workspace.snapshot().scenePreview ?? workspace.snapshot().preview;
  const opened = await workspace.invoke('play.start', { projectId: workspace.snapshot().project.id });
  const target = opened.play.target;
  const args = { targetId: target.targetId, targetGeneration: target.generation };
  await workspace.invoke('play.ready', args);
  const game = page.frames().find(frame => frame.url().includes(target.targetId));
  assert.ok(game);
  await game.evaluate(async () => {
    const { channel } = await globalThis.__forgeaxGameInspection.read('workspace-proof.control');
    const control = new BroadcastChannel(channel);
    globalThis.__workspaceProofControl = control;
    control.postMessage({ type: 'fail' });
  });
  const deadline = Date.now() + 10_000;
  while (workspace.snapshot().play?.phase !== 'failed' && Date.now() < deadline) await page.waitForTimeout(50);
  assert.equal(workspace.snapshot().play?.phase, 'failed', 'the real App failure must reach the workspace state');
  await game.evaluate(() => { globalThis.__workspaceProofControl?.close(); delete globalThis.__workspaceProofControl; });
  await assert.rejects(workspace.getSceneTree(args));
  const sceneArgs = { targetId: scene.target.targetId, targetGeneration: scene.target.generation };
  assert.equal((await workspace.getSceneTree(sceneArgs)).worldId, scene.target.worldId);
  const capture = await workspace.capture(sceneArgs);
  assert.ok(capture.png.startsWith('data:image/png'));
  await workspace.invoke('play.stop', args);
  await page.waitForFunction(() => !document.querySelector('iframe[data-forgeax-scene-play]'));
  assert.equal(workspace.snapshot().play, null);
  assert.equal(workspace.snapshot().preview.target.targetId, scene.target.targetId);
  assert.equal(workspace.snapshot().workspaceTargetLost, false);
  assert.equal(await page.locator('.fx-view-header__recovery').count(), 0);
  await sameRun();
  await page.getByTestId('panel-hierarchy').locator('[data-testid^="hier-row-"]').first().waitFor();
  // The live hierarchy can query the deliberately poisoned Play World. Confirm
  // and acknowledge only that expected diagnostic before unrelated UI tests.
  const notices = page.locator('.fx-error-notice');
  for (const notice of await notices.all()) {
    const diagnostic = await notice.textContent();
    assert.match(diagnostic, /Workspace command failed \(scene-tree\.get\)/);
    assert.match(diagnostic, /view-workspace-provider-failed/);
    assert.match(diagnostic, /world\.update\(deltaSeconds\) completes successfully/);
  }
  if (await notices.count()) {
    await page.screenshot({ path: '/tmp/view-scene-play-intentional-failure.png' });
    const count = await notices.count();
    for (let index = 0; index < count; index++) {
      await notices.first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    }
  }
  assert.equal(await notices.count(), 0);
  console.error('poisoned game reports failure, rejects tools, stops, and preserves the scene');
}
