import assert from 'node:assert/strict';
import { QUALITY_PRESETS, QUALITY_PRESET_IDS } from '../assets/quality-presets.ts';
import { WEATHER_PRESETS, WEATHER_PRESET_IDS, weatherAtmosphereParameters } from '../assets/weather-presets.ts';

const read = 'vc-ue5.cloud';
const part = (play, key) => play.page.locator(`[data-ui-part="${key}"]`);
const button = (play, id) => play.page.locator(`[data-preset="${id}"]`);
const matches = (state, fields) => Object.entries(fields).every(([key, value]) =>
  typeof value === 'number' ? Math.fround(state[key]) === Math.fround(value) : state[key] === value);

async function select(play, id, expected) {
  const before = await play.state(read);
  await button(play, id).click();
  const state = await play.waitFor(state => state.request?.id > (before.request?.id ?? 0) &&
    state.request.status === 'cpu-applied' && matches(state, expected), { read });
  await play.page.locator(`[data-preset="${id}"][aria-pressed="true"]`).waitFor();
  return state;
}

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function qualityPresets(play) {
  const initial = await play.waitFor(state => state.mode === 'shape' && state.completed !== null, { read });
  assert.ok((await play.screenshot('quality-baseline')).rendered);
  if (!initial.paused) await play.page.locator('[data-ui-action="cloud-pause"]').click();
  const paused = await play.waitFor(state => state.paused === true, { read });
  const combinations = [];
  await play.step('Quality and weather selections preserve both axes in all nine combinations', async () => {
    for (const qualityId of QUALITY_PRESET_IDS) {
      const quality = QUALITY_PRESETS[qualityId].parameters;
      const selected = await select(play, qualityId, quality);
      assert.equal(selected.qualityPreset, qualityId);
      assert.deepEqual(selected.configuration.clock, paused.configuration.clock);
      for (const weatherId of WEATHER_PRESET_IDS) {
        const atmosphere = weatherAtmosphereParameters(WEATHER_PRESETS[weatherId].forgeax.parameters);
        const weather = await select(play, weatherId, atmosphere);
        assert.ok(matches(weather, quality), `${weatherId} overwrote ${qualityId}`);
        assert.equal(weather.qualityPreset, qualityId);
        assert.equal(weather.preset, weatherId);
        assert.deepEqual(weather.configuration.clock, paused.configuration.clock);
        assert.deepEqual(weather.configuration.camera, paused.configuration.camera);
        await play.page.locator(`[data-preset="${qualityId}"][aria-pressed="true"]`).waitFor();
        const reapplied = await select(play, qualityId, quality);
        assert.ok(matches(reapplied, atmosphere), `${qualityId} overwrote ${weatherId}`);
        assert.equal(reapplied.preset, weatherId);
        combinations.push({ qualityId, weatherId });
      }
    }
  });
  const savedSnapshot = await play.step('Manual quality edits clear only quality selection and snapshots restore both axes', async () => {
    await select(play, 'backlit', weatherAtmosphereParameters(WEATHER_PRESETS.backlit.forgeax.parameters));
    await select(play, 'quality-low', QUALITY_PRESETS['quality-low'].parameters);
    await play.page.locator('.properties > details').filter({ has: part(play, 'group-tracing') })
      .locator(':scope > summary').click();
    await part(play, 'cloud-samples').fill('0.75');
    await play.waitFor(state => state.qualityPreset === null && state.viewSampleCountScale === 0.75, { read });
    await play.page.locator('[data-quality][aria-pressed="true"]').waitFor({ state: 'detached' });
    await play.page.locator('[data-preset="backlit"][aria-pressed="true"]').waitFor();
    await select(play, 'clear', weatherAtmosphereParameters(WEATHER_PRESETS.clear.forgeax.parameters));
    assert.equal((await play.state(read)).viewSampleCountScale, 0.75);
    assert.equal((await play.state(read)).qualityPreset, null);
    await select(play, 'backlit', weatherAtmosphereParameters(WEATHER_PRESETS.backlit.forgeax.parameters));
    await select(play, 'quality-low', QUALITY_PRESETS['quality-low'].parameters);
    await play.page.getByText('快照', { exact: true }).click();
    await play.page.locator('[data-ui-action="cloud-snapshot-save"]').click();
    await play.waitFor(state => state.snapshot?.preset === 'backlit' &&
      state.snapshot.config.parameters.viewSampleCountScale === 0.5, { read });
    await play.page.waitForFunction(() => [...document.querySelectorAll('#game-ui *')]
      .some(node => node.shadowRoot?.querySelector('[data-ui-part="snapshot-json"]')?.value));
    const saved = await part(play, 'snapshot-json').inputValue();
    await select(play, 'quality-high', QUALITY_PRESETS['quality-high'].parameters);
    await select(play, 'clear', weatherAtmosphereParameters(WEATHER_PRESETS.clear.forgeax.parameters));
    await part(play, 'snapshot-json').fill(saved);
    await play.page.locator('[data-ui-action="cloud-snapshot-load"]').click();
    await play.waitFor(state => state.request?.action === 'cloud-snapshot-load' &&
      state.request.status === 'cpu-applied' && state.qualityPreset === 'quality-low' && state.preset === 'backlit', { read });
    await play.page.locator('[data-preset="quality-low"][aria-pressed="true"]').waitFor();
    await play.page.locator('[data-preset="backlit"][aria-pressed="true"]').waitFor();
    return saved;
  });
  await play.step('Quality presets and snapshots also work with non-textured cloud materials', async () => {
    for (const mode of ['uniform', 'band', 'band-wide']) {
      await play.page.locator(`[data-ui-action="cloud-${mode}"]`).click();
      await play.waitFor(state => state.mode === mode, { read });
      await select(play, 'quality-low', QUALITY_PRESETS['quality-low'].parameters);
      const before = await play.state(read);
      await play.page.locator('[data-ui-action="cloud-snapshot-save"]').click();
      const saved = await play.waitFor(state => state.request?.id > before.request.id &&
        state.request.action === 'cloud-snapshot-save', { read });
      assert.equal(saved.snapshot.config.parameters.useDetail, undefined);
      const json = JSON.stringify(saved.snapshot);
      await select(play, 'quality-medium', QUALITY_PRESETS['quality-medium'].parameters);
      await part(play, 'snapshot-json').fill(json);
      await play.page.locator('[data-ui-action="cloud-snapshot-load"]').click();
      await play.waitFor(state => state.request?.action === 'cloud-snapshot-load' &&
        state.request.status === 'cpu-applied' && state.mode === mode && state.qualityPreset === 'quality-low', { read });
    }
    await part(play, 'snapshot-json').fill(savedSnapshot);
    await play.page.locator('[data-ui-action="cloud-snapshot-load"]').click();
    await play.waitFor(state => state.mode === 'shape' && state.qualityPreset === 'quality-low' && state.preset === 'backlit', { read });
  });
  await play.step('The header controls remain a three-column row on desktop and mobile', async () => {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 360, height: 800 }]) {
      await play.page.setViewportSize(viewport);
      await play.page.locator('.properties').evaluate(node => { node.scrollTop = 0; });
      const layout = await part(play, 'quality-presets').evaluate(node => {
        const rect = node.getBoundingClientRect();
        const buttons = [...node.querySelectorAll('button')].map(button => {
          const box = button.getBoundingClientRect();
          return { x: box.x, y: box.y, right: box.right, width: box.width, text: button.textContent,
            scroll: button.scrollWidth, client: button.clientWidth };
        });
        return { left: rect.left, right: rect.right, buttons };
      });
      assert.ok(layout.left >= 0 && layout.right <= viewport.width);
      assert.equal(layout.buttons.length, 3);
      assert.deepEqual(layout.buttons.map(item => item.text), ['低', '中', '高']);
      assert.ok(layout.buttons.every(item => item.y === layout.buttons[0].y && item.width > 0 && item.scroll <= item.client));
      assert.ok(layout.buttons.slice(1).every((item, i) => item.x >= layout.buttons[i].right));
      const weather = await part(play, 'weather-presets').boundingBox();
      const quality = await part(play, 'quality-presets').boundingBox();
      assert.ok(weather && quality && weather.y >= quality.y + quality.height);
      assert.equal(await part(play, 'weather-presets').locator('button').count(), 6);
      assert.equal(await part(play, 'weather-presets').isVisible(), true);
      assert.ok((await play.screenshot(`quality-header-${viewport.width}`)).rendered);
    }
    await play.page.setViewportSize({ width: 1280, height: 720 });
  });
  return { combinations, final: await play.state(read) };
}
