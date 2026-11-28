import assert from 'node:assert/strict';

const read = 'vc-ue5.cloud';
const part = (play, key) => play.page.locator(`[data-ui-part="${key}"]`);

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function hud(play) {
  const initial = await play.waitFor(state => state.completed !== null, { read });
  assert.equal(await play.page.locator('[data-ui-action="cloud-apply"]').count(), 0);
  assert.equal(await play.page.locator('.properties > details[open]').count(), 2);
  await play.step('Check the six cloud modules and read-only Mode 0', async () => {
    const sections = play.page.locator('.properties > details');
    assert.deepEqual((await play.page.locator('.properties > details > summary').allTextContents()).slice(0, 6), [
      '云层配置与创作', '云密度与体积材质', '云光照模型', '云阴影与遮蔽', '相机光线步进与积分', '云画面重建与合成',
    ]);
    for (const [index, count] of [6, 8, 13, 17, 6, 0].entries()) {
      assert.equal(await sections.nth(index).locator('input, select, textarea').count(), count);
    }
    const shadows = sections.nth(3);
    assert.equal(await shadows.locator('[data-ui-part="group-shadow-ray"] input').count(), 2);
    assert.equal(await shadows.locator('[data-ui-part="group-shadow-map"] input').count(), 9);
    assert.equal(await sections.nth(2).locator('[data-ui-part="exposure"]').count(), 1);
    assert.equal(await sections.nth(4).locator('[data-ui-part="cloud-skip"]').count(), 1);
    assert.equal(await sections.nth(4).locator('[data-ui-part="cloud-blue-noise"]').count(), 1);
    const reconstruction = sections.nth(5);
    assert.match(await reconstruction.textContent(), /Mode 0（只读）/);
    assert.equal(await reconstruction.locator('[data-ui-part="history"]').count(), 1);
  });
  await play.step('Apply valid edits immediately without resetting time', async () => {
    await part(play, 'cloud-bottom').fill('6200');
    const state = await play.waitFor(state => state.bottomMeters === 6200, { read });
    assert.equal(state.initializationRevision, initial.initializationRevision);
    assert.equal(state.referenceTimeSeconds, initial.referenceTimeSeconds);
    assert.ok(state.elapsedSeconds >= initial.elapsedSeconds);
    await part(play, 'cloud-thickness').fill('4300');
    await part(play, 'sun-illuminance').fill('90000');
    await play.waitFor(state => state.thicknessMeters === 4300 && state.sunIlluminanceLux === 90000, { read });
  });
  await play.step('Preserve invalid drafts while unrelated valid edits apply', async () => {
    const before = await play.state(read);
    await part(play, 'cloud-bottom').fill('0');
    await part(play, 'cloud-thickness').fill('4400');
    const state = await play.waitFor(state => state.thicknessMeters === 4400, { read });
    assert.equal(state.bottomMeters, 6200);
    assert.equal(state.initializationRevision, before.initializationRevision);
    assert.equal(await part(play, 'cloud-bottom').inputValue(), '0');
    assert.equal(await part(play, 'cloud-bottom').getAttribute('aria-invalid'), 'true');
    assert.match(await part(play, 'cloud-status').textContent(), /云底高度.*允许范围/);
    await part(play, 'cloud-bottom').fill('');
    await part(play, 'exposure').fill('0.00031');
    await play.waitFor(state => Math.abs(state.exposure - 0.00031) < 1e-8, { read });
    assert.equal(await part(play, 'cloud-bottom').inputValue(), '');
    assert.equal((await play.state(read)).bottomMeters, 6200);
    await part(play, 'cloud-bottom').fill('5400');
    await play.waitFor(state => state.bottomMeters === 5400, { read });
    assert.equal(await part(play, 'cloud-bottom').getAttribute('aria-invalid'), 'false');
  });
  await play.step('Apply select and checkbox controls with dependent availability', async () => {
    await play.page.locator('.properties > details').filter({ has: play.page.locator('[data-ui-part="group-shadows"]') })
      .locator(':scope > summary').click();
    await part(play, 'self-shadow').setChecked(true);
    await part(play, 'shadow-mode').selectOption('0');
    await play.waitFor(state => state.selfShadow && state.shadowMode === 0, { read });
    await part(play, 'shadow-samples').fill('2.5');
    assert.equal(await part(play, 'shadow-samples').getAttribute('aria-invalid'), 'true');
    await part(play, 'shadow-samples').fill('12');
    await play.waitFor(state => state.shadowSamples === 12, { read });
    await play.page.locator('.properties > details').filter({ has: play.page.locator('[data-ui-part="group-density"]') })
      .locator(':scope > summary').click();
    await part(play, 'cloud-coverage').fill('0.2');
    await play.waitFor(state => Math.abs(state.coverageBias - 0.2) < 1e-7, { read });
    await part(play, 'cloud-bottom').focus();
    await play.page.locator('[data-ui-action="shadow-comparison"]').click();
    const compared = await play.waitFor(state => state.mode === 'band', { read });
    assert.ok(Math.abs(Number(await part(play, 'cloud-coverage').inputValue()) - compared.coverageBias) < 1e-7);
    await play.page.locator('[data-ui-action="cloud-textured"]').click();
    await play.waitFor(state => state.mode === 'shape', { read });
    const beforeTime = await play.state(read);
    await part(play, 'cloud-time').fill('13');
    const initialized = await play.waitFor(state => state.referenceTimeSeconds === 13, { read });
    assert.equal(initialized.initializationRevision, beforeTime.initializationRevision + 1);
    await part(play, 'cloud-wind-x').fill('5');
    const wind = await play.waitFor(state => state.windX === 5, { read });
    assert.equal(wind.initializationRevision, initialized.initializationRevision);
    await part(play, 'ms-octaves').fill('0');
    await play.waitFor(state => state.multiScatteringOctaves === 0, { read });
    await part(play, 'ms-octaves').fill('2.5');
    assert.equal(await part(play, 'ms-contribution').isDisabled(), true);
    await part(play, 'ms-octaves').fill('2');
    await play.waitFor(state => state.multiScatteringOctaves === 2, { read });
    assert.equal(await part(play, 'ms-contribution').isEnabled(), true);
    await play.page.locator('.properties > details').evaluateAll(items => items.forEach(item => { item.open = false; }));
    await play.page.locator('.properties > details').filter({ has: play.page.locator('[data-ui-part="group-layer"]') })
      .locator(':scope > summary').click();
    await play.page.locator('.properties > details').filter({ has: play.page.locator('[data-ui-part="group-sun"]') })
      .locator(':scope > summary').click();
  });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await play.page.setViewportSize(viewport);
    await play.page.locator('.properties').evaluate(node => { node.scrollTop = 0; });
    const bounds = await play.page.locator('.properties').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return { width: rect.width, left: rect.left, right: rect.right, scroll: node.scrollWidth, client: node.clientWidth };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= viewport.width);
    assert.ok(bounds.scroll <= bounds.client + 1, JSON.stringify(bounds));
    assert.ok((await play.screenshot(`hud-${viewport.width}`)).rendered);
  }
  return { initial, final: await play.state(read) };
}
