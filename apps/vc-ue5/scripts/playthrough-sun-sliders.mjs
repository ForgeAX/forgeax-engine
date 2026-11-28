import assert from 'node:assert/strict';

export default async function sunSliders(play) {
  const read = 'vc-ue5.cloud';
  const part = name => play.page.locator(`[data-ui-part="${name}"]`);
  await play.page.locator('html[data-forgeax-input="open"]').waitFor();
  const original = await play.state(read);
  await play.page.locator('.properties details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  await play.page.locator('[data-ui-action="cloud-initialize"]').click();
  await play.waitFor(state => state.initializationRevision > original.initializationRevision, { read });
  const before = await play.state(read);
  assert.equal(before.sunElevation, original.sunElevation);
  assert.equal(before.sunAzimuth, original.sunAzimuth);
  await part('exposure').fill('0.00031');
  await play.waitFor(state => Math.abs(state.exposure - 0.00031) < 1e-8, { read });
  const stable = async () => {
    const state = await play.state(read);
    assert.equal(state.initializationRevision, before.initializationRevision);
    assert.deepEqual(state.windOffsetMeters, before.windOffsetMeters);
    assert.equal(state.referenceTimeSeconds, before.referenceTimeSeconds);
    assert.ok(Math.abs(state.exposure - 0.00031) < 1e-8);
    assert.equal(await part('exposure').inputValue(), '0.00031');
    return state;
  };
  const drag = async (name, fraction, key) => {
    const control = part(name);
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    assert.ok(box && box.width > 40 && box.height > 8);
    const value = Number(await control.inputValue());
    const old = await play.state(read);
    const min = Number(await control.getAttribute('min'));
    const max = Number(await control.getAttribute('max'));
    const x = box.x + 8 + (box.width - 16) * (value - min) / (max - min);
    await play.page.mouse.move(x, box.y + box.height / 2);
    await play.page.mouse.down();
    await play.page.mouse.move(box.x + 8 + (box.width - 16) * fraction, box.y + box.height / 2, { steps: 8 });
    await play.page.mouse.up();
    await play.waitFor(state => Math.abs(state[key] - old[key]) > 0.5, { read });
    await stable();
    await control.focus();
    const prior = await play.state(read);
    await control.press('ArrowRight');
    await play.waitFor(state => state[key] > prior[key], { read });
    await stable();
  };
  await play.step('Drag and keyboard-adjust both solar sliders without cloud initialization', async () => {
    await drag('sun-elevation', 0.7, 'sunElevation');
    await drag('sun-azimuth', 0.35, 'sunAzimuth');
    await part('sun-elevation').scrollIntoViewIfNeeded();
    const shot = await play.screenshot('sun-sliders-dragged');
    assert.ok(shot.rendered);
    const current = await stable();
    for (const [name, key] of [['sun-elevation', 'sunElevation'], ['sun-azimuth', 'sunAzimuth']]) {
      assert.ok(Math.abs(Number(await part(name).inputValue()) - current[key]) < 1e-5);
      assert.ok(Math.abs(Number(await part(`${name}-number`).inputValue()) - current[key]) < 1e-5);
    }
  });
  await play.step('Commit decimal solar inputs and restore invalid edits', async () => {
    for (const [name, key, value] of [['sun-elevation', 'sunElevation', -3.125], ['sun-azimuth', 'sunAzimuth', 127.375]]) {
      const number = part(`${name}-number`);
      await number.fill(String(value));
      await number.press('Enter');
      await play.waitFor(state => Math.abs(state[key] - value) < 1e-4, { read });
      assert.ok(Math.abs(Number(await part(name).inputValue()) - value) < 1e-4);
      await number.fill('999');
      await number.press('Tab');
      assert.ok(Math.abs(Number(await number.inputValue()) - value) < 1e-4);
      assert.ok(Math.abs((await stable())[key] - value) < 1e-4);
    }
  });
  await play.step('Camera switches keep the committed solar controls synchronized', async () => {
    const solar = await play.state(read);
    for (const [action, view] of [['camera-shadow', 'shadow'], ['camera-ground-shadow', 'ground-shadow'], ['reset', 'ground']]) {
      await play.page.locator(`[data-ui-action="${action}"]`).click();
      const state = await play.waitFor(state => state.cameraView === view, { read });
      assert.equal(state.sunElevation, solar.sunElevation);
      assert.equal(state.sunAzimuth, solar.sunAzimuth);
      assert.equal(state.initializationRevision, before.initializationRevision);
    }
    assert.ok(Math.abs(Number(await part('sun-elevation').inputValue()) - solar.sunElevation) < 1e-5);
    assert.ok(Math.abs(Number(await part('sun-azimuth').inputValue()) - solar.sunAzimuth) < 1e-5);
  });
  await play.step('The latest solar or comparison action wins when queued together', async () => {
    await part('sun-elevation').evaluate(input => {
      input.value = '70';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.getRootNode().querySelector('[data-ui-action="shadow-comparison"]').click();
    });
    await play.waitFor(state => state.mode === 'band' && Math.abs(state.sunElevation - 36) < 1e-4 && Math.abs(state.sunAzimuth - 90) < 1e-4, { read });
    await part('sun-elevation').evaluate(input => {
      input.getRootNode().querySelector('[data-ui-action="shadow-comparison"]').click();
      input.value = '44';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await play.waitFor(state => Math.abs(state.sunElevation - 44) < 1e-4, { read });
    assert.ok((await play.screenshot('sun-sliders-ordering')).rendered);
    assert.ok(Math.abs(Number(await part('sun-elevation').inputValue()) - 44) < 1e-4);
  });
  return { before, after: await play.state(read), scope: 'Real mouse and keyboard solar controls; screenshots require visual inspection; shadow H1 acceptance remains the prior human verdict.' };
}
