import assert from 'node:assert/strict';

const read = 'vc-ue5.cloud';

function adopted(state, mode) {
  const frame = state.completed;
  return state.mode === mode && frame && Object.values(state.renderer?.layer ?? {}).some(({ resourceStage, mode0 }) =>
    resourceStage === 'accepted' && mode0?.materialIdentity === `${state.programIdentity}:${state.cookIdentity}` &&
    mode0.deviceGeneration === frame.deviceGeneration && mode0.acceptedFrame > 0 && mode0.acceptedFrame <= frame.frameId);
}

async function verifyMaterial(play, mode, checkpoint) {
  const state = await play.waitFor(value => adopted(value, mode), { read, timeoutMs: 60000 });
  assert.equal(state.castCloudShadows, true);
  assert.equal(state.groundShadowEnabled, true);
  assert.equal(state.atmosphereShadowEnabled, true);
  assert.match(state.cookIdentity, /\S+/);
  assert.match(state.programIdentity, /\S+/);
  assert.equal(Object.keys(state.textureGuids).length, 4);
  const image = await play.screenshot(checkpoint);
  assert.equal(image.rendered, true);
  return { mode, materialGuid: state.materialGuid, cookIdentity: state.cookIdentity,
    publication: state.authoring.materialPublication, frame: state.completed,
    textureGuids: state.textureGuids, image };
}

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function sharedAssets(play) {
  const generated = await play.step('render the procedural shared material', async () => {
    // The demo starts on Low, which intentionally disables atmospheric shadows.
    await play.page.locator('[data-preset="quality-medium"]').click();
    await play.waitFor(state => state.qualityPreset === 'quality-medium', { read });
    return verifyMaterial(play, 'shape', 'shared-procedural-clouds');
  });
  const ue = await play.step('switch to the shared UE texture material', async () => {
    await play.page.locator('[data-ui-action="cloud-sample-ue"]').click();
    const state = await verifyMaterial(play, 'sample-ue', 'shared-ue-clouds');
    assert.equal(state.materialGuid, generated.materialGuid);
    assert.notDeepEqual(state.textureGuids, generated.textureGuids);
    return state;
  });
  const restored = await play.step('restore the procedural material', async () => {
    await play.page.locator('[data-ui-action="cloud-shape"]').click();
    const state = await verifyMaterial(play, 'shape', 'shared-procedural-restored');
    assert.equal(state.materialGuid, generated.materialGuid);
    return state;
  });
  return { release: play.release, generated, ue, restored };
}
