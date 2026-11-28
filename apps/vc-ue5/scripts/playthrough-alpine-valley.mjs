import assert from 'node:assert/strict';

const READ = 'vc-ue5.cloud';
const ALPINE = 'alpine-valley';
const DEG = Math.PI / 180;
const action = (play, name) => play.page.locator(`[data-ui-action="${name}"]`);

function adopted(state, mode, afterFrame = 0) {
  const frame = state.completed;
  if (state.mode !== mode || !frame) return false;
  return Object.values(state.renderer?.layer ?? {}).some(({ resourceStage, mode0 }) =>
    resourceStage === 'accepted' && mode0?.materialIdentity === `${state.programIdentity}:${state.cookIdentity}` &&
    mode0.deviceGeneration === frame.deviceGeneration && mode0.acceptedFrame > afterFrame && mode0.acceptedFrame <= frame.frameId);
}

async function waitAdopted(play, mode, afterFrame = 0) {
  return play.waitFor(state => adopted(state, mode, afterFrame), { read: READ, timeoutMs: 60000 });
}

async function showHud(play, show) {
  await play.page.locator('aside.panel, nav.panel').evaluateAll((panels, visible) => {
    for (const panel of panels) panel.style.visibility = visible ? '' : 'hidden';
  }, show);
}

async function capture(play, label, mode = ALPINE) {
  const after = await play.state(READ);
  const state = await play.waitFor(value => adopted(value, mode) && value.completed.frameId >= after.completed.frameId + 5,
    { read: READ, timeoutMs: 20000 });
  const shot = await play.screenshot(label);
  assert.equal(shot.rendered, true);
  return { ...shot, mode, view: state.viewMode, pose: state.configuration.camera.pose, frame: state.completed };
}

async function choose(play, mode) {
  const before = await play.state(READ);
  await action(play, `cloud-${mode}`).click();
  const state = await waitAdopted(play, mode, before.completed.frameId);
  await play.page.locator(`[data-ui-action="cloud-${mode}"][aria-pressed="true"]`).waitFor();
  return state;
}

async function aimPitch(play, target) {
  const { pitch } = (await play.state(READ)).configuration.camera.pose;
  const up = target > pitch;
  await play.keyboard.hold(up ? 'ArrowUp' : 'ArrowDown', state => {
    const live = state.configuration.camera.pose.pitch;
    return up ? live >= target : live <= target;
  }, { read: READ, timeoutMs: 20000 });
}

async function turnRight(play, angle) {
  const { yaw } = (await play.state(READ)).configuration.camera.pose;
  await play.keyboard.hold('ArrowRight', state => {
    const moved = state.configuration.camera.pose.yaw - yaw;
    return (moved + 2 * Math.PI) % (2 * Math.PI) >= angle;
  }, { read: READ, timeoutMs: 20000 });
}

function assertTextureOnly(before, after) {
  const slots = Object.keys(before.textureGuids).sort();
  assert.deepEqual(slots, ['bodyNoise', 'heightProfile', 'layoutMask', 'layoutPattern']);
  assert.deepEqual(Object.keys(after.textureGuids).sort(), slots);
  for (const name of slots) assert.notEqual(after.textureGuids[name], before.textureGuids[name]);
  const controls = state => Object.fromEntries(Object.entries(state.authoring.resolvedCookValues)
    .filter(([key]) => !slots.includes(key)));
  assert.deepEqual(controls(after), controls(before));
  assert.deepEqual(after.configuration.parameters, before.configuration.parameters);
  assert.deepEqual(after.configuration.camera, before.configuration.camera);
  assert.deepEqual(after.configuration.clock, before.configuration.clock);
  for (const key of ['materialGuid', 'cookIdentity', 'programIdentity', 'kernelIdentity', 'enabled', 'preset',
    'initializationRevision', 'sunAzimuth', 'sunElevation', 'exposure', 'maskWeight', 'useDetail', 'viewSampleCountScale'])
    assert.deepEqual(after[key], before[key], key);
}

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function alpineValley(play) {
  const shots = [];
  const alpine = await play.step('Switch all three texture sets while retaining the current controls', async () => {
    await waitAdopted(play, 'shape');
    const field = name => play.page.locator(`[data-ui-part="${name}"]`);
    await field('sun-elevation').fill('27');
    await field('cloud-bottom').fill('1400');
    await play.page.locator('.properties > details').filter({ has: play.page.locator('[data-ui-part="group-density"]') })
      .locator(':scope > summary').click();
    await field('cloud-mask').fill('0.24');
    await field('cloud-detail').setChecked(true);
    await action(play, 'cloud-pause').click();
    await play.waitFor(value => value.paused && value.bottomMeters === 1400 && Math.abs(value.sunElevation - 27) < 1e-4 &&
      Math.abs(value.maskWeight - 0.24) < 1e-6 && value.useDetail, { read: READ });
    await play.mouse.click([0.5, 0.52]);
    await aimPitch(play, 19 * DEG);
    await action(play, 'cloud-view-contour').click();
    const generated = await play.waitFor(value => value.viewMode === 'contour' && adopted(value, 'shape'), { read: READ });
    const ue = await choose(play, 'sample-ue');
    assertTextureOnly(generated, ue);
    const state = await choose(play, ALPINE);
    assertTextureOnly(ue, state);
    assert.deepEqual(Object.keys(state.authoring.instanceOverrides).sort(), Object.keys(state.textureGuids).sort());
    const restored = await choose(play, 'shape');
    assertTextureOnly(state, restored);
    assert.deepEqual(restored.textureGuids, generated.textureGuids);
    assertTextureOnly(restored, await choose(play, ALPINE));
    await action(play, 'cloud-view-normal').click();
    await play.waitFor(value => value.viewMode === 'normal', { read: READ });
    shots.push(await capture(play, '01-hud'));
    return state;
  });

  await play.step('Capture reference heading, low horizon, and nearby upward view', async () => {
    await showHud(play, false);
    await play.mouse.click([0.5, 0.52]);
    shots.push(await capture(play, '02-reference'));
    await aimPitch(play, 3 * DEG);
    shots.push(await capture(play, '03-horizon'));
    await aimPitch(play, 55 * DEG);
    shots.push(await capture(play, '04-near-up'));
    await aimPitch(play, alpine.configuration.camera.pose.pitch);
  });

  await play.step('Rotate through alternate headings in the same weather tile', async () => {
    for (const [index, heading] of ['right', 'rear', 'left'].entries()) {
      await turnRight(play, Math.PI / 2);
      shots.push(await capture(play, `0${index + 5}-${heading}`));
    }
  });

  await play.step('Compare a cloud transmittance frame and restore the original mode', async () => {
    await showHud(play, true);
    await action(play, 'cloud-view-transmittance').click();
    await play.waitFor(value => value.viewMode === 'transmittance', { read: READ });
    await showHud(play, false);
    shots.push(await capture(play, '08-transmittance'));
    await showHud(play, true);
    await action(play, 'cloud-view-normal').click();
    await play.waitFor(value => value.viewMode === 'normal', { read: READ });
    const before = await play.state(READ);
    const restored = await choose(play, 'shape');
    assertTextureOnly(before, restored);
    await showHud(play, false);
    shots.push(await capture(play, '09-generated-clouds', 'shape'));
    await showHud(play, true);
    await action(play, 'cloud-off').click();
    await play.waitFor(value => value.mode === 'off', { read: READ });
    assert.equal(await action(play, 'cloud-alpine-valley').isEnabled(), false);
    await action(play, 'cloud-textured').click();
    await waitAdopted(play, 'shape');
    await choose(play, ALPINE);
  });

  const { materialGuid, textureGuids, programIdentity, kernelIdentity, cookIdentity, authoring } = alpine;
  return { release: play.release, materialGuid, textureGuids, programIdentity, kernelIdentity, cookIdentity,
    authoring, setup: {
      bottomMeters: alpine.bottomMeters, thicknessMeters: alpine.thicknessMeters,
      viewSampleCountScale: alpine.viewSampleCountScale, viewBlueNoise: alpine.viewBlueNoise,
      sunAzimuth: alpine.sunAzimuth, sunElevation: alpine.sunElevation, sunIlluminanceLux: alpine.sunIlluminanceLux,
      exposure: alpine.exposure, phaseG: alpine.phaseG, phaseG2: alpine.phaseG2, phaseBlend: alpine.phaseBlend,
      msContribution: alpine.msContribution, msOcclusion: alpine.msOcclusion, msEccentricity: alpine.msEccentricity,
      multiScatteringOctaves: alpine.multiScatteringOctaves, shadowSamples: alpine.shadowSamples,
      stopTransmittance: alpine.stopTransmittance,
    }, shots };
}
