import assert from 'node:assert/strict';

const read = 'vc-ue5.cloud';
const modes = ['nubis-dawn', 'nubis-sunlit', 'nubis-boss'];

function adopted(state, mode, afterFrame = 0) {
  const frame = state.completed;
  return state.mode === mode && frame && (afterFrame === 0 || state.request?.status === 'cpu-applied') &&
    Object.values(state.renderer?.layer ?? {}).some(({ resourceStage, mode0 }) =>
      resourceStage === 'accepted' && mode0?.materialIdentity === `${state.programIdentity}:${state.cookIdentity}` &&
      mode0.deviceGeneration === frame.deviceGeneration &&
      mode0.acceptedFrame > afterFrame && mode0.acceptedFrame <= frame.frameId);
}

const materialValues = state => Object.fromEntries(Object.entries(state.authoring.resolvedCookValues)
  .filter(([key]) => !Object.hasOwn(state.textureGuids, key)));

function assertSharedSettings(state, reference) {
  assert.equal(state.materialGuid, reference.materialGuid);
  assert.equal(state.kernelIdentity, reference.kernelIdentity);
  assert.equal(state.cookIdentity, reference.cookIdentity);
  assert.equal(state.programIdentity, reference.programIdentity);
  assert.deepEqual(materialValues(state), materialValues(reference));
  assert.deepEqual(state.configuration.parameters, reference.configuration.parameters);
  assert.deepEqual(state.configuration.clock, reference.configuration.clock);
  assert.deepEqual(state.configuration.camera, reference.configuration.camera);
  for (const key of ['bottomMeters', 'thicknessMeters', 'viewSampleCountScale', 'viewBlueNoise',
    'exposure', 'sunElevation', 'sunAzimuth', 'sunIlluminanceLux', 'layoutWeight', 'maskWeight',
    'profileWeight', 'bodyWeight', 'erosionWeight', 'extinctionPerMeter', 'coverageBias', 'useDetail']) {
    assert.equal(state[key], reference[key], key);
  }
}

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function nubis(play) {
  await play.page.locator('html[data-forgeax-input="open"]').waitFor();
  const initial = await play.waitFor(state => adopted(state, 'shape'), { read });
  assert.equal(initial.viewBlueNoise, false);
  assert.equal(initial.qualityPreset, 'quality-low');
  assert.equal(await play.page.locator('[data-ui-action="cloud-nubis-valley"]').count(), 0);
  assert.equal(initial.viewSampleCountScale, 1);

  const switchTo = async mode => {
    const before = await play.state(read);
    const selector = `[data-ui-action="cloud-${mode}"]`;
    await play.page.locator(selector).click();
    await play.page.locator(`${selector}[aria-pressed="true"]`).waitFor();
    return play.waitFor(state => adopted(state, mode, before.completed.frameId), { read, timeoutMs: 60000 });
  };

  await play.page.locator('[data-ui-action="cloud-pause"]').click();
  const reference = await play.waitFor(state => state.paused && adopted(state, 'shape'), { read });
  const textureGuids = new Set(Object.values(reference.textureGuids));
  const shots = [await play.screenshot('generated-clouds')];
  assert.ok(shots[0].rendered);
  for (const mode of modes) {
    shots.push(await play.step(`Switch only the four texture bindings for ${mode}`, async () => {
      const state = await switchTo(mode);
      assertSharedSettings(state, reference);
      assert.ok(state.instanceGuid);
      assert.deepEqual(Object.keys(state.textureGuids).sort(), Object.keys(reference.textureGuids).sort());
      assert.deepEqual(state.authoring.instanceOverrides, state.textureGuids);
      for (const guid of Object.values(state.textureGuids)) {
        assert.ok(typeof guid === 'string' && !textureGuids.has(guid));
        textureGuids.add(guid);
      }
      const image = await play.screenshot(mode);
      assert.equal(image.rendered, true);
      return image;
    }));
  }
  const restored = await switchTo('shape');
  assertSharedSettings(restored, reference);
  assert.deepEqual(restored.textureGuids, reference.textureGuids);
  await play.step('Keep user edits through a Nubis round trip', async () => {
    await play.page.locator('.properties details').evaluateAll(items => items.forEach(item => { item.open = true; }));
    const blueNoise = play.page.locator('[data-ui-part="cloud-blue-noise"]');
    await blueNoise.check();
    const sun = play.page.locator('[data-ui-part="sun-elevation"]');
    await sun.fill('45');
    const edited = await play.waitFor(state => state.viewBlueNoise && Math.abs(state.sunElevation - 45) < 1e-4, { read });
    assertSharedSettings(await switchTo('nubis-boss'), edited);
    assertSharedSettings(await switchTo('shape'), edited);
    await blueNoise.uncheck();
    await play.waitFor(state => state.viewBlueNoise === false, { read });
  });
  return { shots, textureCount: textureGuids.size - 4 };
}
