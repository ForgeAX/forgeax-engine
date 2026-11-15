import assert from 'node:assert/strict';

const read = 'vc-ue5.ground';
const cloudRead = 'vc-ue5.cloud';
const sceneRead = 'vc-ue5.scene';
const sceneGuid = '3ff37484-d2aa-584c-8035-45e09d98cb72';
const frameSelector = '[data-ui-part="frame"]';
const fpsSelector = '[data-ui-part="fps"]';
const expectedVerticalFov = 73.739795 * Math.PI / 180;
const groundPosition = (state) => state.position.map((n) => Math.round(n * 1e5) / 1e5);
const difference = (a, b) => Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);

async function countAppCompletions(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const canvas = [...document.querySelectorAll('canvas')].find((node) => node.forgeaxFrameProgress?.completed);
    if (!canvas) { resolve(null); return; }
    let first;
    let last;
    let count = 0;
    const onComplete = (event) => {
      if (event.detail.presentation !== 'ready') return;
      const at = performance.now();
      first ??= at;
      last = at;
      count++;
    };
    canvas.addEventListener('forgeax:frame-completed', onComplete);
    setTimeout(() => {
      canvas.removeEventListener('forgeax:frame-completed', onComplete);
      const elapsedMs = (last ?? 0) - (first ?? 0);
      resolve({ count, elapsedMs, fps: elapsedMs > 0 ? (count - 1) * 1000 / elapsedMs : null });
    }, 1250);
  }));
}

async function readTelemetry(play) {
  await play.page.locator(frameSelector).filter({ hasText: /#\d+/ }).waitFor();
  await play.page.locator(fpsSelector).filter({ hasText: /^\d+\.\d$/ }).waitFor();
  return play.page.locator(frameSelector).evaluate((node) => {
    const canvases = [...document.querySelectorAll('canvas')];
    const actual = canvases.find((canvas) => canvas.forgeaxFrameProgress?.completed)?.forgeaxFrameProgress.completed;
    return {
      displayed: Number(node.textContent.slice(1)),
      displayedDevice: Number(node.dataset.deviceGeneration),
      displayedWorld: node.dataset.worldIdentity,
      count: Number(node.dataset.count),
      actual: actual?.frameId,
      actualDevice: actual?.deviceGeneration,
      actualWorld: actual?.worldIdentity ?? '',
      fps: Number(node.getRootNode().querySelector('[data-ui-part="fps"]').textContent),
    };
  });
}

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function playthrough(play) {
  await play.page.locator('.properties details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  const scene = await play.step('instantiate the formal seven-entity Scene', async () => {
    const state = await play.state(sceneRead);
    assert.equal(state.guid, sceneGuid);
    assert.equal(state.sourceKey, 'scene/ground-reference');
    assert.equal(state.sourcePath, 'assets/game.pack.ts');
    assert.match(state.sourceRevision, /^sha256:[0-9a-f]{64}$/);
    assert.match(state.packageDigest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(state.entities), [
      'camera', 'ground', 'occluder', 'sun', 'skylight', 'atmosphere', 'cloud',
    ]);
    assert.equal(new Set(Object.values(state.entities)).size, 7);
    assert.ok(!Object.values(state.entities).includes(state.root));
    return state;
  });
  const start = await play.step('start from the frozen ground pose', async () => {
    assert.equal(await play.page.evaluate(() => document.documentElement.lang), 'zh-CN');
    assert.equal(await play.page.title(), 'VC UE5 | 体积云地面参考');
    assert.match(await play.page.locator('#forgeax-status').textContent(), /^演示 [^|]+ \| 引擎 [^|]+ \| FPS /);
    assert.equal(await play.page.locator('#forgeax-fps').getAttribute('aria-label'), '每秒实际完成帧数');
    const state = await play.state(read);
    assert.deepEqual(groundPosition(state), [157.17355, 0.35069, 36.17745]);
    assert.equal(state.fixtureVisible, true);
    assert.ok(Math.abs(state.fov - expectedVerticalFov) < 1e-6);
    assert.ok((await play.screenshot('ground-reference')).rendered);
    return state;
  });
  const initialCloud = await play.state(cloudRead);
  assert.equal(initialCloud.mode, 'shape');
  assert.ok(Math.abs(initialCloud.extinctionPerMeter - 0.008) < 1e-8);
  assert.equal(initialCloud.viewSampleCountScale, 1);
  assert.ok(Math.abs(initialCloud.stopTransmittance - 0.005) < 1e-7);
  assert.match(initialCloud.kernelIdentity, /^[0-9a-f]{64}$/);
  const resized = await play.step('keep the vertical lens through an aspect change', async () => {
    const initial = play.page.viewportSize();
    assert.ok(initial);
    await play.page.setViewportSize({ width: 960, height: 720 });
    const resized = await play.waitFor((state) => Math.abs(state.aspect - 4 / 3) < 1e-6, { read });
    assert.equal(resized.fov, start.fov);
    assert.deepEqual(resized.position, start.position);
    assert.ok((await play.screenshot('maintain-vertical-at-4x3')).rendered);
    await play.page.setViewportSize(initial);
    await play.waitFor((state) => state.aspect === start.aspect, { read });
    return { aspect: resized.aspect, verticalFov: resized.fov };
  });
  const telemetry = await play.step('compare HUD with App completion', async () => {
    await readTelemetry(play);
    const independent = await countAppCompletions(play.page);
    const sample = await readTelemetry(play);
    assert.equal(sample.displayed, sample.actual);
    assert.equal(sample.displayedDevice, sample.actualDevice);
    assert.equal(sample.displayedWorld, sample.actualWorld);
    assert.ok(sample.count > 1 && sample.fps > 0);
    assert.ok(independent?.fps > 0);
    // The HUD and independent observer have different windows; allow scheduling variation.
    assert.ok(Math.abs(sample.fps - independent.fps) / independent.fps < 0.25,
      `HUD ${sample.fps} FPS and independent completion count ${independent.fps} FPS disagree`);
    assert.equal((await play.page.locator('[data-ui-part="gpu"]').textContent()).trim(), '不可用');
    assert.equal(await play.page.locator('fieldset:not(:disabled) input[type=number]').count(), 15);
    return { ...sample, independent };
  });
  const analyticCloud = await play.step('switch and adjust the cooked spherical layer', async () => {
    await play.page.getByRole('button', { name: '均匀云', exact: true }).click();
    const reference = await play.waitFor((state) => state.mode === 'uniform', { read: cloudRead });
    assert.ok(reference.extinctionPerMeter > 0);
    assert.ok((await play.screenshot('analytic-cloud-on')).rendered);
    await play.page.getByRole('button', { name: '无云', exact: true }).click();
    await play.waitFor((state) => !state.enabled, { read: cloudRead });
    assert.ok((await play.screenshot('analytic-cloud-off')).rendered);
    await play.page.getByRole('button', { name: '均匀云', exact: true }).click();
    await play.waitFor((state) => state.enabled, { read: cloudRead });
    await play.page.locator('[data-ui-part="cloud-bottom"]').fill('6200');
    await play.waitFor((state) => state.bottomMeters === 6200, { read: cloudRead });
    await play.page.getByRole('status').filter({ hasText: '参数已应用' }).waitFor();
    await play.page.locator('[data-ui-part="cloud-bottom"]').fill('0');
    await play.page.getByRole('status').filter({ hasText: '参数须在允许范围内。' }).waitFor();
    assert.equal((await play.state(cloudRead)).bottomMeters, 6200);
    await play.page.locator('[data-ui-part="cloud-bottom"]').fill('6200');
    await play.page.getByRole('status').filter({ hasText: '参数已应用' }).waitFor();
    assert.ok((await play.screenshot('analytic-cloud-raised')).rendered);
    await play.page.locator('[data-ui-part="cloud-thickness"]').fill('3600');
    await play.waitFor((state) => state.thicknessMeters === 3600, { read: cloudRead });
    assert.ok((await play.screenshot('analytic-cloud-thinner')).rendered);
    await play.page.locator('[data-ui-part="cloud-extinction"]').fill('0.00022');
    const changed = await play.waitFor(
      (state) => Math.abs(state.extinctionPerMeter - 0.00022) < 1e-8,
      { read: cloudRead },
    );
    assert.ok((await play.screenshot('analytic-cloud-extinction')).rendered);
    assert.deepEqual(groundPosition(await play.state(read)), groundPosition(start));
    return { reference, changed };
  });
  const cloudShape = await play.step('sample the cooked cloud shape and change its controls', async () => {
    await play.page.getByRole('button', { name: 'UE 原纹理', exact: true }).click();
    const original = await play.waitFor((state) => state.mode === 'sample-ue', { read: cloudRead });
    assert.notEqual(original.materialGuid, initialCloud.materialGuid);
    assert.ok((await play.screenshot('original-ue-textures')).rendered);
    await play.page.getByRole('button', { name: '生成云', exact: true }).click();
    const shape = await play.waitFor((state) => state.mode === 'shape', { read: cloudRead });
    assert.equal(shape.materialGuid, initialCloud.materialGuid);
    assert.equal(shape.programIdentity, initialCloud.programIdentity);
    const number = (key) => play.page.locator(`[data-ui-part="cloud-${key}"]`);
    await number('bottom').fill('5000');
    await number('thickness').fill('10000');
    await play.waitFor((state) => state.bottomMeters === 5000 && state.thicknessMeters === 10000,
      { read: cloudRead });
    assert.ok((await play.screenshot('sampled-shape-default')).rendered);
    const adopted = [];
    for (const [key, name, value] of [
      ['layout', 'layoutWeight', 0.3], ['mask', 'maskWeight', 0], ['profile', 'profileWeight', 0.4],
      ['body', 'bodyWeight', 0.35], ['erosion', 'erosionWeight', 0], ['coverage', 'coverageBias', 0.1],
      ['extinction', 'extinctionPerMeter', 0.0006],
    ]) {
      await number(key).fill(String(value));
      const state = await play.waitFor((state) => Math.abs(state[name] - value) < 1e-7, { read: cloudRead });
      adopted.push([name, state[name]]);
      assert.ok((await play.screenshot(`sampled-shape-${key}`)).rendered);
      await number(key).fill(String(shape[name]));
      await play.waitFor((state) => Math.abs(state[name] - shape[name]) < 1e-7, { read: cloudRead });
    }
    await number('detail').check();
    await number('skip').uncheck();
    const switched = await play.waitFor((state) => state.useDetail && !state.skipEmpty, { read: cloudRead });
    assert.notEqual(switched.programIdentity, initialCloud.programIdentity);
    assert.ok(switched.erosionWeight > 0);
    assert.ok((await play.screenshot('sampled-shape-detail')).rendered);
    await number('wind-x').fill('120');
    const moved = await play.waitFor(
      (state) => state.windOffsetMeters[0] - initialCloud.windOffsetMeters[0] > 30,
      { read: cloudRead },
    );
    assert.ok((await play.screenshot('sampled-shape-wind')).rendered);
    await number('wind-x').fill('0');
    await play.waitFor((state) => state.windX === 0, { read: cloudRead });
    assert.deepEqual(groundPosition(await play.state(read)), groundPosition(start));
    return { shape, adopted, switched, windOffsetMeters: moved.windOffsetMeters };
  });
  const completionSmoke = await play.step('complete 60 actual shaped cloud frames', async () => {
    return play.page.evaluate(() => new Promise((resolve, reject) => {
      const canvas = [...document.querySelectorAll('canvas')].find((node) => node.forgeaxFrameProgress?.completed);
      if (!canvas) { reject(new Error('No completed-frame source')); return; }
      const first = canvas.forgeaxFrameProgress.completed;
      let latest = first;
      let count = 0;
      const onFrame = (event) => {
        const frame = event.detail;
        if (frame.presentation !== 'ready' || frame.deviceGeneration !== first.deviceGeneration || frame.worldIdentity !== first.worldIdentity) return;
        if (frame.frameId <= latest.frameId) return;
        latest = frame;
        if (++count === 60) {
          clearTimeout(timeout);
          canvas.removeEventListener('forgeax:frame-completed', onFrame);
          resolve({ count, first: first.frameId, last: latest.frameId, deviceGeneration: first.deviceGeneration });
        }
      };
      const timeout = setTimeout(() => {
        canvas.removeEventListener('forgeax:frame-completed', onFrame);
        reject(new Error(`Only ${count} cloud frames completed`));
      }, 30000);
      canvas.addEventListener('forgeax:frame-completed', onFrame);
    }));
  });
  const moved = await play.step('walk and turn on the ground', async () => {
    // A real viewport click leaves number/checkbox keyboard focus in the HUD.
    await play.page.locator('canvas').first().click();
    assert.equal(await play.page.evaluate(() => document.pointerLockElement), null);
    await play.keyboard.hold('KeyW', (state) => difference(start, state) > 0.3, { read });
    const state = await play.keyboard.hold('ArrowRight', (pose) => Math.abs(pose.yaw - start.yaw) > 0.1, { read });
    assert.equal(state.position[1], start.position[1]);
    assert.ok((await play.screenshot('walk-and-turn')).rendered);
    return state;
  });
  await play.step('hide the occluder and reset with the HUD', async () => {
    const fixture = play.page.getByRole('button', { name: '遮挡物：开启' });
    await fixture.click();
    await play.waitFor((state) => !state.fixtureVisible, { read });
    await play.page.getByRole('button', { name: '遮挡物：关闭' }).waitFor();
    assert.ok((await play.screenshot('occluder-hidden')).rendered);
    await play.page.getByRole('button', { name: '地面视角' }).click();
    const reset = await play.waitFor((state) => state.fixtureVisible && difference(start, state) === 0, { read });
    assert.deepEqual(reset.rotation, start.rotation);
  });
  const reload = await play.step('reload and reproduce the same pose', async () => {
    await play.reload();
    const reloadedScene = await play.state(sceneRead);
    assert.equal(reloadedScene.guid, scene.guid);
    assert.equal(reloadedScene.sourceRevision, scene.sourceRevision);
    assert.equal(reloadedScene.packageDigest, scene.packageDigest);
    assert.deepEqual(Object.keys(reloadedScene.entities), Object.keys(scene.entities));
    const state = await play.state(read);
    assert.deepEqual(state, start);
    const cloud = await play.state(cloudRead);
    for (const key of ['mode', 'materialGuid', 'cookIdentity', 'programIdentity', 'bottomMeters',
      'thicknessMeters', 'extinctionPerMeter', 'referenceTimeSeconds', 'windOffsetMeters', 'textureGuids'])
      assert.deepEqual(cloud[key], initialCloud[key], key);
    const sample = await readTelemetry(play);
    assert.equal(sample.displayed, sample.actual);
    assert.ok((await play.screenshot('ground-after-reload')).rendered);
    return sample;
  });
  return { scene, start, resized, moved, telemetry, analyticCloud, cloudShape, completionSmoke, reload };
}
