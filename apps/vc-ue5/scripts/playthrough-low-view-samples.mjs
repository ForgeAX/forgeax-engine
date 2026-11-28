import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const read = 'vc-ue5.cloud';
const rates = [1, 0.75, 0.5, 0.25];

export default async function lowViewSampling(play) {
  const output = process.env.FORGEAX_LOW_RAY_OUT ?? await mkdtemp(join(tmpdir(), 'forgeax-low-ray-'));
  await mkdir(output, { recursive: true });
  await play.waitFor((state) => state.completed?.frameId > 8 && state.mode === 'shape', { read });
  await play.page.locator('[data-ui-action="cloud-pause"]').click();
  await play.waitFor((state) => state.paused, { read });
  await play.page.locator('.properties > details').filter({
    has: play.page.locator('[data-ui-part="group-tracing"]'),
  }).locator(':scope > summary').click();

  const rows = [];
  for (const mode of ['shape', 'sample-ue']) {
    if (mode === 'sample-ue') await play.page.locator('[data-ui-action="cloud-sample-ue"]').click();
    await play.waitFor((state) => state.mode === mode, { read });
    for (const rate of rates) {
      const slider = play.page.locator('[data-ui-part="cloud-samples"]');
      await slider.fill(String(rate));
      await slider.press('Tab');
      const applied = await play.waitFor((state) => state.viewSampleCountScale === rate, { read });
      const ready = await play.waitFor((state) => state.completed?.frameId >= applied.completed.frameId + 12 &&
        state.mode === mode && state.viewSampleCountScale === rate &&
        Object.values(state.renderer?.layer ?? {}).some((layer) => layer.mode0?.historyValid), { read });
      let frame = ready.completed.frameId;
      const frames = [];
      for (let index = 0; index < 8; index++) {
        const state = await play.waitFor((value) => value.completed?.frameId > frame, { read });
        frame = state.completed.frameId;
        await play.page.screenshot({ path: join(output, `${mode}-${rate}-${index}.png`) });
        frames.push({ frame, history: Object.values(state.renderer?.layer ?? {}).map((layer) => layer.mode0) });
      }
      assert.equal(ready.paused, true);
      rows.push({ rate, mode, frames, camera: ready.configuration.camera, wind: ready.windOffsetMeters });
    }
  }
  const movement = await play.step('Move, cut, resize and restore clouds at the lowest budget', async () => {
    const ground = 'vc-ue5.ground';
    const start = await play.state(ground);
    const cameraDistance = (state) => Math.hypot(state.position[0] - start.position[0], state.position[2] - start.position[2]);
    await play.page.locator('canvas').first().click();
    await play.keyboard.hold('KeyD', (state) => cameraDistance(state) > 1, { read: ground });
    assert.ok((await play.screenshot('low-budget-side-step')).rendered);
    const beforeCut = await play.state(ground);
    await play.page.locator('[data-ui-action="cut"]').click();
    await play.waitFor((state) => Math.abs(state.yaw - beforeCut.yaw) > 0.1 ||
      Math.hypot(state.position[0] - beforeCut.position[0], state.position[2] - beforeCut.position[2]) > 1,
    { read: ground });
    const target = play.page.viewportSize();
    await play.page.setViewportSize({ width: 960, height: 720 });
    await play.waitFor((state) => Math.abs(state.aspect - 4 / 3) < 1e-6, { read: ground });
    assert.ok((await play.screenshot('low-budget-after-cut-and-resize')).rendered);
    await play.page.setViewportSize(target);
    await play.page.locator('[data-ui-action="reset"]').click();
    await play.page.locator('[data-ui-action="cloud-off"]').click();
    await play.waitFor((state) => state.mode === 'off', { read });
    await play.page.locator('[data-ui-action="cloud-textured"]').click();
    const restored = await play.waitFor((state) => state.mode === 'sample-ue' &&
      state.viewSampleCountScale === 0.25 && Object.values(state.renderer?.layer ?? {}).some(
        (layer) => layer.mode0?.historyValid), { read });
    assert.ok((await play.screenshot('low-budget-cloud-history-restored')).rendered);
    return { frame: restored.completed.frameId, ratio: restored.viewSampleCountScale };
  });
  return { output, rows, movement };
}
