import assert from 'node:assert/strict';

const read = 'vc-ue5.cloud';

function shadowAfter(state, before, rawResolution, traceSamples) {
  if (state.completed?.worldIdentity !== before.worldIdentity ||
    state.completed?.deviceGeneration !== before.deviceGeneration ||
    state.completed?.frameId <= before.frameId) return;
  return Object.values(state.renderer?.layer ?? {}).find(({ mode0 }) =>
    mode0?.deviceGeneration === before.deviceGeneration &&
    mode0?.acceptedFrame > before.frameId &&
    mode0?.shadowMap?.rawResolution === rawResolution &&
    Math.abs(mode0.shadowMap.traceSamples - traceSamples) < 0.1)?.mode0.shadowMap;
}

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function cloudShadowReference(play) {
  const before = await play.waitFor(state => !!state.completed, { read });
  const reference = await play.step('render the UE BSM comparison preset', async () => {
    await play.page.locator('[data-preset="bsm-reference"]').click();
    const state = await play.waitFor(value => value.preset === 'bsm-reference' &&
      value.mode === 'sample-ue' && shadowAfter(value, before.completed, 512, 22.4), { read, timeoutMs: 60000 });
    const shadow = shadowAfter(state, before.completed, 512, 22.4);
    assert.equal(shadow.filteredResolution, 256);
    assert.equal(shadow.fullWidthMeters, 160_000);
    assert.equal(state.paused, true);
    const image = await play.screenshot('ue-bsm-reference');
    assert.equal(image.rendered, true);
    return { shadow, image, frame: state.completed };
  });
  const baseline = await play.step('reduce only the BSM resolution', async () => {
    const start = (await play.state(read)).completed;
    await play.page.getByText('追踪与重建', { exact: true }).click();
    await play.page.locator('[data-ui-part="shadow-resolution"]').fill('128');
    const state = await play.waitFor(value => shadowAfter(value, start, 128, 22.4), { read, timeoutMs: 60000 });
    const shadow = shadowAfter(state, start, 128, 22.4);
    assert.equal(shadow.filteredResolution, 64);
    const image = await play.screenshot('ue-bsm-128');
    assert.equal(image.rendered, true);
    return { shadow, image };
  });
  const horizon = await play.step('increase midpoint sampling for a low sun', async () => {
    const start = (await play.state(read)).completed;
    await play.page.locator('[data-ui-part="sun-elevation"]').fill('5');
    const state = await play.waitFor(value => shadowAfter(value, start, 128, 32), { read, timeoutMs: 60000 });
    const shadow = shadowAfter(state, start, 128, 32);
    assert.ok(Math.abs(state.sunElevation - 5) < 0.1);
    const image = await play.screenshot('ue-bsm-5-degrees');
    assert.equal(image.rendered, true);
    return { shadow, image };
  });
  const spatial = await play.step('toggle zero through four UE spatial passes on an odd map', async () => {
    const page = play.page;
    const control = page.locator('[data-ui-part="shadow-map-spatial-passes"]');
    await page.locator('[data-ui-part="shadow-resolution"]').fill('129');
    const receipts = [];
    for (const [rounds, expected] of [[0, 129], [1, 64], [2, 32], [3, 16], [4, 8], [1, 64]]) {
      const before = (await play.state(read)).completed;
      await control.fill(String(rounds));
      const state = await play.waitFor(value => {
        const map = shadowAfter(value, before, 129, 32);
        return map?.spatialPasses === rounds && map?.filteredResolution === expected;
      }, { read, timeoutMs: 60000 });
      receipts.push(shadowAfter(state, before, 129, 32));
    }
    const image = await play.screenshot('ue-bsm-odd-spatial');
    assert.equal(image.rendered, true);
    return { receipts, image };
  });
  return { reference, baseline, horizon, spatial };
}
