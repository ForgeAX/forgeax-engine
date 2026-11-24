import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeSponzaUi } from '../native-sponza-ui.mjs';
import { consumeNativePointerEvents } from '../native-sponza-controls.mjs';
import { inspectNativeSponzaGi } from '../native-sponza-renderer.mjs';
import { createNativeSponzaStartup } from '../native-sponza-startup.mjs';

test('real Blitz buttons hit their own geometry, select modes, and retain unchanged GPU preparation', async () => {
  const commands = [];
  const errors = [];
  const preview = await createNativeSponzaUi({ width: 1600, height: 900, scaleFactor: 2 },
    (command, source) => commands.push({ command, source }), error => errors.push(error));
  try {
    const update = { mode: 'irradiance-field', automatic: true, ev: 0, giState: 'ready', exposureState: 'gpu-resident', hardwareRayTracing: true, traversal: 'ray-query' };
    preview.update(update);
    const first = preview.rendererUi.paint(0);
    assert.ok(first, 'actual WASM must prepare visible GPU UI');
    const collapsed = assertPanelCollapsed(preview);
    clickUiRect(preview, collapsed['toggle-panel'].rect);
    assert.ok(preview.rendererUi.paint(1), 'opening the panel must repaint the UI');
    const snapshot = preview.snapshot();
    assert.equal(snapshot['irradiance-field'].selected, 'true');
    assert.equal(snapshot.off.selected, 'false');
    assert.equal(snapshot['toggle-exposure'].selected, 'true');
    assert.equal(snapshot['toggle-hardware'].selected, 'true');
    assert.match(preview.ui.document.getElementById('traversal').textContent, /Hardware Ray Query/);
    for (const [id, { rect }] of Object.entries(snapshot)) {
      assert.ok(rect.width > 0 && rect.height > 0, `${id} must have a real hit rectangle`);
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 800 && rect.y + rect.height <= 450,
        `${id} must fit the logical viewport`);
      if (id === 'toggle-panel') continue;
      const x = (rect.x + rect.width / 2) * 2;
      const y = (rect.y + rect.height / 2) * 2;
      consumeNativePointerEvents({}, [{ kind: 'pointer-down', button: 'left', x, y },
        { kind: 'pointer-up', button: 'left', x, y }], preview.ui.input, 2);
      assert.deepEqual(commands.at(-1), { command: id, source: 'button' });
    }
    assert.equal(commands.length, 8);
    const off = snapshot.off.rect;
    const x = (off.x + off.width / 2) * 2;
    const y = (off.y + off.height / 2) * 2;
    for (const cancellation of [{ kind: 'focus', focused: false }, { kind: 'pointer-leave' },
      { kind: 'pointer-down', button: 'right', x, y }]) {
      consumeNativePointerEvents({}, [{ kind: 'pointer-down', button: 'left', x, y }, cancellation,
        { kind: 'pointer-up', button: 'left', x, y }], preview.ui.input, 2);
      assert.equal(commands.length, 8, `${cancellation.kind} must revoke a partially pressed UI button`);
    }
    preview.update({ ...update, mode: 'off', automatic: false, ev: 0.5, exposureState: 'manual' });
    assert.equal(preview.snapshot().off.selected, 'true');
    assert.equal(preview.snapshot()['toggle-exposure'].selected, 'false');
    assert.match(preview.ui.document.getElementById('exposure').textContent, /Manual.*\+0.5 EV/);
    preview.ui.input.cancel();
    preview.rendererUi.paint(1000);
    preview.update({ ...update, mode: 'off', automatic: false, ev: 0.5, exposureState: 'manual' });
    assert.equal(preview.rendererUi.paint(1001), null, 'unchanged HUD must reuse its preparation');
    preview.ui.resize(1920, 1080, 1.5);
    assert.ok(preview.rendererUi.paint(2000));
    assert.deepEqual(errors, []);
    preview.update({ ...update, hardwareRayTracing: false, traversal: 'global-sdf', traversalFallback: 'hardware-ray-query-disabled' });
    assert.equal(preview.snapshot()['toggle-hardware'].selected, 'false');
    assert.match(preview.ui.document.getElementById('traversal').textContent, /Software Global SDF/);
    const pendingField = inspectNativeSponzaGi({ gather: 'screen-probe', state: 'ready', submittedFrames: 9,
      field: { gather: 'irradiance-field', state: 'preparing' } });
    preview.update({ ...update, mode: 'screen-probe', giState: pendingField.state,
      fieldState: pendingField.fieldState, hardwareRayTracing: false, traversal: pendingField.traversal });
    assert.match(preview.ui.document.getElementById('status').textContent, /GI: ready.*Field: preparing/);
    assert.match(preview.ui.document.getElementById('traversal').textContent, /Actual: preparing/);
    assert.doesNotMatch(preview.ui.document.getElementById('traversal').textContent, /Software Global SDF/);
    const readyField = inspectNativeSponzaGi({ gather: 'screen-probe', state: 'ready', submittedFrames: 10,
      field: { gather: 'irradiance-field', state: 'ready', traversal: 'global-sdf' } });
    preview.update({ ...update, mode: 'screen-probe', giState: readyField.state,
      fieldState: readyField.fieldState, hardwareRayTracing: false, traversal: readyField.traversal });
    assert.match(preview.ui.document.getElementById('status').textContent, /GI: ready.*Field: ready/);
    assert.match(preview.ui.document.getElementById('traversal').textContent, /Software Global SDF/);
    preview.ui.resize(1600, 900, 2);
    verifyPanelToggle(preview, commands, errors);
  } finally { preview.ui.dispose(); }
});

function clickUiRect(preview, rect) {
  const x = (rect.x + rect.width / 2) * 2;
  const y = (rect.y + rect.height / 2) * 2;
  consumeNativePointerEvents({}, [{ kind: 'pointer-down', button: 'left', x, y },
    { kind: 'pointer-up', button: 'left', x, y }], preview.ui.input, 2);
}

function assertPanelCollapsed(preview) {
  const snapshot = preview.snapshot();
  assert.equal(snapshot['toggle-panel'].expanded, 'false');
  assert.equal(preview.ui.document.getElementById('toggle-panel').textContent, 'Show controls');
  for (const [id, { rect }] of Object.entries(snapshot)) {
    if (id === 'toggle-panel') assert.ok(rect.width > 0 && rect.height > 0);
    else assert.equal(rect.width * rect.height, 0, `${id} must have no hidden hit geometry`);
  }
  const panel = preview.ui.document.getElementById('panel').getBoundingClientRect();
  assert.ok(panel.width < 200 && panel.height < 70, 'collapsed panel must leave the scene visible');
  return snapshot;
}

function verifyPanelToggle(preview, commands, errors) {
  const previousCommands = [...commands];
  const update = { mode: 'irradiance-field', automatic: true, ev: 0, giState: 'ready', exposureState: 'gpu-resident' };
  const click = rect => clickUiRect(preview, rect);
    preview.update(update);
    preview.rendererUi.paint(3000);
    const expanded = preview.snapshot();
    assert.equal(expanded['toggle-panel'].expanded, 'true');
    click(expanded['toggle-panel'].rect);
    assert.ok(preview.rendererUi.paint(3001));
    const collapsed = assertPanelCollapsed(preview);
    click(expanded.off.rect);
    assert.deepEqual(commands, previousCommands, 'hidden controls must not dispatch commands');
    preview.update({ ...update, mode: 'screen-probe', automatic: false, ev: 2 });
    click(collapsed['toggle-panel'].rect);
    assert.ok(preview.rendererUi.paint(3002));
    const restored = preview.snapshot();
    assert.equal(restored['toggle-panel'].expanded, 'true');
    assert.equal(restored['screen-probe'].selected, 'true');
    assert.equal(restored['toggle-exposure'].selected, 'false');
    assert.match(preview.ui.document.getElementById('exposure').textContent, /Manual.*\+2.0 EV/);
    assert.ok(restored.off.rect.width > 0);
    assert.deepEqual(commands, previousCommands, 'panel visibility must not change renderer settings');
    assert.deepEqual(errors, []);
}

test('startup cover shows measured concurrent phases and releases controls on a qualified GI frame', async () => {
  let now = 0;
  const startup = createNativeSponzaStartup('screen-probe', now, () => now);
  const ui = await createNativeSponzaUi(
    { width: 1600, height: 900, scaleFactor: 1 }, () => {}, undefined, true,
  );
  try {
    startup.begin('scene-assets');
    now += 1250;
    startup.finish('scene-assets');
    startup.beginSceneFrames();
    now += 5000;
    startup.observeFrame({ presentationReady: true, qualified: false,
      diffuseGi: { state: 'preparing', fieldState: 'ready' } }, now - 10, now);
    const waiting = startup.snapshot();
    ui.updateStartup(waiting);
    assert.ok(ui.rendererUi.paint(now));
    const cover = ui.ui.document.getElementById('forgeax-loading');
    assert.ok(cover.getBoundingClientRect().width > 0);
    assert.match(cover.textContent, /Load Sponza assets1\.3 s/);
    assert.match(cover.textContent, /Prepare Screen Probe5\.0 s/);
    assert.match(cover.textContent, /Complete first GI framePending/);
    assert.equal(ui.snapshot().off.rect.width, 0);
    assert.ok(waiting.progress.percent < 100);

    now += 750;
    startup.observeFrame({ presentationReady: true, qualified: true,
      diffuseGi: { state: 'ready', fieldState: 'ready' } }, now - 20, now);
    const ready = startup.snapshot();
    ui.updateStartup(ready);
    assert.equal(ready.outcome, 'ready');
    assert.equal(ready.progress.percent, 100);
    assert.equal(ready.stages.find(s => s.id === 'gi-frame').elapsedMs, 20);
    assert.ok(ui.rendererUi.paint(now));
    assert.equal(cover.getBoundingClientRect().width, 0);
    assertPanelCollapsed(ui);
  } finally {
    startup.dispose();
    ui.ui.dispose();
  }
});