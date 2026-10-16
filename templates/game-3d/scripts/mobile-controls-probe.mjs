import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Real browser input and read-only World inspection on the ordinary game host. */
export async function probeMobileControls(page, read, evidenceDir, readVase) {
  const cdp = await page.context().newCDPSession(page);
  const progress = [];
  const screenshots = [];
  const part = name => page.locator(`[data-ui-part="${name}"]`);
  const neutral = state => state.player.controls.horizontal === 0 &&
    state.player.controls.vertical === 0 && state.player.controls.run === false;
  const distance = (a, b) => Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
  const record = async (name, state) => {
    progress.push({ name, ...state });
    await writeFile(join(evidenceDir, 'mobile-progress.json'), JSON.stringify(progress, null, 2));
    return state;
  };
  const wait = async (name, predicate, timeout = 20_000) => {
    const deadline = performance.now() + timeout;
    let state;
    do {
      state = await read();
      assert.equal(state.renderer.state, 'alive');
      assert.equal(state.renderer.execution.world.health, 'healthy');
      assert.equal(state.renderer.execution.fault, null);
      assert.equal(state.player.camera.pointerLocked, false, 'Touch must not acquire mouse pointer lock');
      if (await predicate(state)) return record(name, state);
      await page.waitForTimeout(100);
    } while (performance.now() < deadline);
    await record(`${name}-timeout`, state);
    assert.fail(`${name} did not settle: ${JSON.stringify(state)}`);
  };
  const advance = (name, before) => wait(name, state =>
    state.player.simulation.fixedTick >= before.player.simulation.fixedTick + 4 &&
    state.renderer.execution.frame.completed >= before.renderer.execution.frame.completed + 2);
  const center = async (name, id) => {
    const bounds = await (typeof name === 'string' ? part(name) : name).boundingBox();
    assert.ok(bounds, `${name} must be visible`);
    return { id, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, radiusX: 4, radiusY: 4 };
  };
  const touch = (type, touchPoints = []) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const tap = async name => {
    await touch('touchStart', [await center(name, 1)]);
    await touch('touchEnd');
  };
  const capture = async name => {
    const path = join(evidenceDir, `${name}.png`);
    await page.screenshot({ path });
    screenshots.push(path);
  };
  const visibleControls = async () => {
    const viewport = page.viewportSize();
    const bounds = {};
    for (const name of ['move-stick', 'look-pad', 'jump', 'run', 'vase-toggle']) {
      await part(name).waitFor({ state: 'visible', timeout: 15_000 });
      const rect = await part(name).boundingBox();
      assert.ok(rect && rect.width >= 44 && rect.height >= (name === 'vase-toggle' ? 24 : 44), `${name} has a usable touch target`);
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width &&
        rect.y + rect.height <= viewport.height, `${name} stays inside the viewport`);
      bounds[name] = rect;
    }
    for (const [index, a] of Object.values(bounds).entries()) {
      for (const b of Object.values(bounds).slice(index + 1)) {
        assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x ||
          a.y + a.height <= b.y || b.y + b.height <= a.y, 'Touch targets must not overlap');
      }
    }
    return bounds;
  };
  const held = async jump => {
    const move = await center('move-stick', 1);
    const look = await center('look-pad', 2);
    const run = await center('run', 3);
    const points = [{ ...move, x: move.x + 24, y: move.y - 24 }, look, run];
    if (jump) points.push(await center('jump', 4));
    await touch('touchStart', points);
    points[1] = { ...look, x: look.x + 24, y: look.y - 8 };
    await touch('touchMove', points);
    return points;
  };
  try {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    // Observe trusted input without fabricating events, ports, or game state.
    await page.evaluate(() => {
      globalThis.__forgeaxMobilePointerEvidence = [];
      for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
        document.addEventListener(name, event => {
          const events = globalThis.__forgeaxMobilePointerEvidence;
          if (events.length < 100) events.push({ type: event.type, trusted: event.isTrusted,
            pointerType: event.pointerType, pointerId: event.pointerId });
        }, true);
      }
    });
    await page.setViewportSize({ width: 390, height: 844 });
    // A desktop browser may deliver real mouse movement before switching to
    // touch. Keep that input in the evidence rather than requiring exclusivity.
    await page.mouse.move(1, 1);
    // The first real touch selects the Host's actual touch mode.
    await touch('touchStart', [{ id: 1, x: 195, y: 420 }]);
    await touch('touchEnd');
    const portrait = await visibleControls();
    const initial = await wait('portrait-ready', state => neutral(state) && state.player.grounded);
    await advance('portrait-rendered', initial);
    await capture('mobile-portrait');

    await page.setViewportSize({ width: 844, height: 390 });
    const landscape = await visibleControls();
    const before = await wait('landscape-ready', state => neutral(state) && state.player.grounded);
    await advance('landscape-rendered', before);
    await capture('mobile-landscape');
    await held(true);
    const combined = await wait('four-touch-move-look-jump-run', state =>
      state.player.controls.horizontal > 0.2 && state.player.controls.vertical > 0.2 &&
      state.player.controls.run && !state.player.grounded &&
      state.player.position[1] > before.player.position[1] + 0.04 &&
      distance(state.player, before.player) > 0.02 &&
      Math.abs(state.player.camera.yaw - before.player.camera.yaw) > 0.02);
    assert.equal(await part('run').getAttribute('aria-pressed'), 'true');
    assert.equal(await part('jump').getAttribute('aria-pressed'), 'true');
    assert.notEqual(await part('move-thumb').evaluate(node => getComputedStyle(node).transform), 'matrix(1, 0, 0, 1, 0, 0)');
    await capture('mobile-four-touch');
    await touch('touchEnd');
    const released = await wait('release', state => neutral(state) && state.player.grounded);
    const stopped = await advance('release-stopped', released);
    assert.ok(distance(stopped.player, released.player) < 0.005, 'Release stops movement');
    assert.ok(Math.abs(stopped.player.camera.yaw - released.player.camera.yaw) < 0.005, 'Release stops camera look');
    assert.equal(await part('run').getAttribute('aria-pressed'), 'false');
    assert.equal(await part('jump').getAttribute('aria-pressed'), 'false');

    await held(false);
    await wait('before-cancel', state => state.player.controls.run && state.player.controls.horizontal > 0.2);
    await touch('touchCancel');
    const cancelled = await wait('cancel', neutral);
    const cancelStopped = await advance('cancel-stopped', cancelled);
    assert.ok(distance(cancelStopped.player, cancelled.player) < 0.005, 'Cancel stops movement');

    const editingPoints = await held(false);
    await wait('before-editor', state => state.player.controls.run && state.player.controls.horizontal > 0.2);
    // Chrome suppresses compatibility clicks for a secondary contact within a
    // game gesture. Trusted keyboard activation separately exercises reset while
    // the game contacts remain held; the single-touch form journey follows.
    await part('vase-toggle').focus();
    await page.keyboard.press('Enter');
    await part('vase-body').waitFor({ state: 'visible', timeout: 10_000 });
    const editing = await wait('editor-reset', neutral);
    editingPoints[0].x += 12;
    editingPoints[1].x += 12;
    await touch('touchMove', editingPoints);
    const editorStill = await advance('editor-does-not-move-player', editing);
    assert.ok(neutral(editorStill));
    assert.ok(distance(editorStill.player, editing.player) < 0.005, 'Editor pauses movement');
    assert.ok(Math.abs(editorStill.player.camera.yaw - editing.player.camera.yaw) < 0.005, 'Editor pauses look');
    await capture('mobile-editor');
    await touch('touchEnd');
    await tap('vase-toggle');
    await part('vase-body').waitFor({ state: 'hidden', timeout: 10_000 });
    await visibleControls();

    await tap('vase-toggle');
    await part('vase-body').waitFor({ state: 'visible', timeout: 10_000 });
    const beforeForm = await wait('touch-editor-open', neutral);
    const beforeVase = await readVase();
    await tap(page.getByLabel('Height', { exact: true }));
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText('2.8');
    await tap(page.getByRole('button', { name: 'Generate vase' }));
    let editedVase;
    const afterForm = await wait('touch-form-generated', async state => {
      editedVase = await readVase();
      return neutral(state) && !editedVase.busy && editedVase.generation !== beforeVase.generation;
    });
    assert.equal(editedVase.error, undefined);
    assert.equal(editedVase.guid, beforeVase.guid);
    assert.equal(editedVase.entity, beforeVase.entity);
    assert.ok(Math.abs(editedVase.aabb[4] - 2.8) < 0.001);
    assert.ok(distance(afterForm.player, beforeForm.player) < 0.005, 'Touch form does not move the player');
    assert.ok(Math.abs(afterForm.player.camera.yaw - beforeForm.player.camera.yaw) < 0.005);
    await advance('touch-form-rendered', afterForm);
    await capture('mobile-form');
    await tap('vase-toggle');
    await part('vase-body').waitFor({ state: 'hidden', timeout: 10_000 });

    await held(false);
    await wait('before-resize', state => state.player.controls.run && state.player.controls.horizontal > 0.2);
    await page.setViewportSize({ width: 390, height: 844 });
    const resized = await wait('resize-reset', neutral);
    await touch('touchEnd');
    await visibleControls();
    const resizeStill = await advance('resize-stopped', resized);
    assert.ok(distance(resizeStill.player, resized.player) < 0.005, 'Resize clears held movement');

    const pointerEvents = await page.evaluate(() => globalThis.__forgeaxMobilePointerEvidence);
    await writeFile(join(evidenceDir, 'mobile-pointer-events.json'), JSON.stringify(pointerEvents, null, 2));
    assert.ok(pointerEvents.every(event => event.trusted),
      `All observed input must come from the browser: ${JSON.stringify(pointerEvents)}`);
    assert.ok(pointerEvents.some(event => event.pointerType === 'mouse' && event.type === 'pointermove'),
      'The desktop-to-touch transition must retain its real mouse movement');
    const touchEvents = pointerEvents.filter(event => event.pointerType === 'touch');
    assert.ok(touchEvents.length > 0);
    assert.ok(touchEvents.some(event => event.type === 'pointercancel'));
    assert.ok(new Set(touchEvents.filter(event => event.type === 'pointerdown').map(event => event.pointerId)).size >= 4);
    const result = { portrait, landscape, initial, combined, released, cancelled,
      editing: { activation: 'trusted-keyboard-with-touch-contacts-held', state: editing },
      touchForm: { before: beforeVase, after: editedVase, player: afterForm.player }, resized, pointerEvents, screenshots };
    await writeFile(join(evidenceDir, 'mobile-result.json'), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    await capture('mobile-failure').catch(() => {});
    throw error;
  } finally {
    await touch('touchCancel').catch(() => {});
    await cdp.detach();
  }
}
