import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildFrameModel, decodeTape } from '@forgeax/engine/rhi-debug';
import { chromium } from 'playwright';

const [nativeUrl = 'http://127.0.0.1:5193/', referenceUrl = 'http://127.0.0.1:5192/reference/', directory = 'artifacts/three-compat/github/verification'] = process.argv.slice(2);
const output = resolve(directory);
await mkdir(output, { recursive: true });
const launch = JSON.parse(await readFile('scripts/ci/browser-launch.json', 'utf8'));
const browser = await chromium.launch({ ...launch, headless: true,
  args: [...launch.args, '--use-angle=swiftshader', '--disable-gpu-watchdog'], chromiumSandbox: true });
const report = { modes: {}, comparisons: [], passed: false };
const compare = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  let error = 0, outside = 0, activeError = 0, activeChannels = 0;
  for (let i = 0; i < actual.length; i++) {
    const delta = Math.abs(actual[i] - expected[i]) / 255;
    error += delta;
    if (delta > 0.05) outside++;
    if (i % 4 !== 3 && (actual[i] > 8 || expected[i] > 8)) { activeError += delta; activeChannels++; }
  }
  const result = { meanAbsoluteError: error / actual.length,
    channelsOutsideEpsilon: outside / actual.length, foregroundError: activeError / activeChannels };
  assert.ok(result.meanAbsoluteError <= 0.05, JSON.stringify(result));
  assert.ok(result.channelsOutsideEpsilon <= 0.03, JSON.stringify(result));
  assert.ok(result.foregroundError <= 0.05, JSON.stringify(result));
  return result;
};
try {
  for (const [mode, url] of [['reference', referenceUrl], ['forgeax', nativeUrl]]) {
    const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
    const errors = [];
    report.modes[mode] = { url, errors };
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const wait = async condition => {
      await page.waitForFunction(condition, undefined, { timeout: 120000 });
      assert.deepEqual(errors, []);
      assert.deepEqual(await page.evaluate(() => window.threeMigration.errors), []);
    };
    try {
      await page.goto(url);
      await wait(() => window.threeMigration?.readyFrames >= 60);
      assert.equal(await page.evaluate(() => window.THREE.REVISION), '184');
      assert.equal(await page.evaluate(() => window.game.cubes.length), 27);
      assert.equal(await page.locator('.command-btn').count(), 12);
      const snapshot = async (name) => {
        await page.locator('#migration-capture').click();
        await page.locator('[data-artifact="frame.rgba"]').waitFor({ timeout: 120000 });
        for (const artifact of ['frame.rgba', ...(mode === 'forgeax' && name === 'initial' ? ['frame.rhitape', 'frame.sources.json'] : [])]) {
          const pending = page.waitForEvent('download');
          await page.locator(`[data-artifact="${artifact}"]`).click();
          await (await pending).saveAs(`${output}/${mode}-${name}.${artifact.slice(6)}`);
        }
        assert.deepEqual(errors, []);
        await page.screenshot({ path: `${output}/${mode}-${name}.png` });
      };
      await snapshot('initial');
      await page.locator('.command-btn[data-color-index="0"][data-clockwise="1"]').click();
      await wait(() => window.game.movesHistory.length === 1 && window.game.movesToMake.length === 0);
      await snapshot('turn');
      await page.locator('.command-btn[data-color-index="0"][data-clockwise="0"]').click();
      await wait(() => window.game.movesHistory.length === 2 && window.game.movesToMake.length === 0);
      await snapshot('restored');
      const pick = await page.evaluate(() => {
        const { game, THREE, camera } = window;
        game.raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
        return game.raycaster.intersectObjects(game.RubiksCube.children, true).map(hit => hit.object.uuid);
      });
      assert.ok(pick.length > 0, 'The real source scene must remain pickable');
      const types = await page.evaluate(() => {
        window.migrationPointerEvents = [];
        for (const type of ['mousedown', 'mousemove', 'mouseup'])
          window.game.scene.on(type, event => window.migrationPointerEvents.push({ type, hits: event.intersects.length }));
        return [...new Set(window.game.cubes.map(cube => cube.type))];
      });
      // Upstream computes the cubie type before assigning its face colors, so
      // every cubie is F1 and its drag handler explicitly cancels a face turn.
      assert.deepEqual(types, ['F1']);
      await page.mouse.move(470, 385);
      await page.mouse.down();
      await page.mouse.move(560, 390, { steps: 18 });
      await page.mouse.up();
      await wait(() => window.migrationPointerEvents.some(event => event.type === 'mouseup'));
      const pointerEvents = await page.evaluate(() => window.migrationPointerEvents);
      for (const type of ['mousedown', 'mousemove', 'mouseup'])
        assert.ok(pointerEvents.some(event => event.type === type && event.hits > 0), `${mode}: missing picked ${type}`);
      assert.equal(await page.evaluate(() => window.game.movesHistory.length), 2);
      await snapshot('drag');
      report.modes[mode] = { url, errors, pickCount: pick.length,
        upstreamDragLimitation: "All cubies are F1; upstream cancels mouse face turns",
        ...await page.evaluate(() => ({ readyFrames: window.threeMigration.readyFrames,
          moves: window.game.movesHistory.length, cubeCount: window.game.cubes.length })) };
    } finally { await page.close(); }
  }
  for (const state of ['initial', 'turn', 'restored', 'drag']) {
    report.comparisons.push({ state, ...compare(
      await readFile(`${output}/forgeax-${state}.rgba`),
      await readFile(`${output}/reference-${state}.rgba`)) });
  }
  for (const mode of ['reference', 'forgeax']) {
    const initial = await readFile(`${output}/${mode}-initial.rgba`);
    const turn = await readFile(`${output}/${mode}-turn.rgba`);
    assert.ok(!initial.equals(turn), `${mode}: a face turn must change the rendered image`);
    compare(initial, await readFile(`${output}/${mode}-restored.rgba`));
  }
  const tape = decodeTape(new Uint8Array(await readFile(`${output}/forgeax-initial.rhitape`))).unwrap();
  const model = buildFrameModel(tape);
  const mapping = JSON.parse(await readFile(`${output}/forgeax-initial.sources.json`, 'utf8'));
  assert.ok(model.works.length > 10, 'Capture must include source geometry work');
  assert.ok(mapping.sources.filter(source => source.type === 'Mesh').length >= 189);
  report.capture = { works: model.works.length, resources: model.resources.length,
    sources: mapping.sources.length, frameId: mapping.frameId };
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await browser.close();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
