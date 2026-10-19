import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import ts from 'typescript';
import launch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };

const url = process.argv[2] ?? 'http://127.0.0.1:4277/scene-authoring.html';
const output = resolve(process.argv[3] ?? 'artifacts/scene-authoring');
await mkdir(output, { recursive: true });
// Match ANGLE to Vulkan's software device so visible WebGPU swap buffers work.
const browser = await chromium.launch({
  ...launch,
  args: [...launch.args, '--use-angle=swiftshader'],
  chromiumSandbox: true,
});
const report = { url, browser: browser.version(), errors: [], states: {}, effects: {} };

function difference(a, b) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) if (i % 4 !== 3) sum += Math.abs(a.data[i] - b.data[i]);
  return sum / (a.width * a.height * 3 * 255);
}
function sourceStats(source) {
  const file = ts.createSourceFile(
    'scene.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source,
  );
  const lines = new Set();
  let tokens = 0;
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    tokens++;
    lines.add(file.getLineAndCharacterOfPosition(scanner.getTokenPos()).line);
  }
  return {
    lexicalTokens: tokens,
    linesWithCode: lines.size,
    importModules: file.statements
      .filter(ts.isImportDeclaration)
      .map((item) => item.moduleSpecifier.text),
  };
}
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1050 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (error) => report.errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') report.errors.push(message.text());
  });
  // Test-only completion evidence. Scene programs contain no verification hooks.
  await page.addInitScript(() => {
    globalThis.__sceneDevices = [];
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (descriptor) {
      const device = await request.call(this, descriptor);
      globalThis.__sceneDevices.push(device);
      return device;
    };
  });
  await page.goto(url);
  await page.waitForFunction(
    () => globalThis.__sceneAuthoring || globalThis.__sceneAuthoringError,
    undefined,
    { timeout: 120000 },
  );
  assert.equal(await page.evaluate(() => globalThis.__sceneAuthoringError), undefined);
  Object.assign(
    report,
    await page.evaluate(() => ({
      productHead: globalThis.__sceneAuthoring.productHead,
      sources: globalThis.__sceneAuthoring.sources,
    })),
  );
  report.code = Object.fromEntries(
    Object.entries(report.sources).map(([name, source]) => [name, sourceStats(source)]),
  );
  delete report.sources;

  async function capture(name) {
    let previous;
    for (let attempt = 0; attempt < 90; attempt++) {
      assert.equal(await page.evaluate(() => globalThis.__sceneAuthoringError), undefined);
      await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        await Promise.all(
          globalThis.__sceneDevices.map((device) => device.queue.onSubmittedWorkDone()),
        );
      });
      const current = {};
      for (const engine of ['three', 'forgeax']) {
        current[engine] = PNG.sync.read(await page.locator(`#${engine}`).screenshot());
      }
      if (
        previous &&
        ['three', 'forgeax'].every(
          (engine) => difference(previous[engine], current[engine]) < 0.00001,
        )
      ) {
        for (const [engine, png] of Object.entries(current)) {
          const colors = new Set();
          for (let i = 0; i < png.data.length; i += 4) colors.add(png.data.readUInt32LE(i));
          assert.ok(
            colors.size > 100,
            `${name}/${engine}: expected shaded geometry, got ${colors.size} colors`,
          );
          await writeFile(resolve(output, `${name}-${engine}.png`), PNG.sync.write(png));
        }
        report.states[name] = {
          width: current.three.width,
          height: current.three.height,
          crossEngineMeanAbsoluteRgb: difference(current.three, current.forgeax),
        };
        return current;
      }
      previous = current;
      await page.waitForTimeout(150);
    }
    throw new Error(`${name}: output did not settle`);
  }
  function effect(name, before, after) {
    report.effects[name] = {};
    for (const engine of ['three', 'forgeax']) {
      const delta = difference(before[engine], after[engine]);
      assert.ok(delta > 0.0001, `${name}/${engine}: toggle must visibly change pixels (${delta})`);
      report.effects[name][engine] = delta;
    }
  }
  const direct = await capture('direct');
  await page.locator('#shadows').uncheck();
  effect('shadowReception', direct, await capture('no-shadows'));
  await page.locator('#shadows').check();
  await page.locator('#ambient').check();
  effect('ambientApiDiagnostic', direct, await capture('ambient-diagnostic'));
  await page.locator('#ambient').uncheck();
  await page.selectOption('#mode', 'post');
  const post = await capture('post');
  effect('acesAndFxaa', direct, post);
  await page.selectOption('#mode', 'bloom');
  const glow = await capture('bloom');
  effect('bloom', post, glow);
  await page.screenshot({ path: resolve(output, 'comparison.png'), fullPage: true });
  await page.locator('#view').check();
  effect('camera', glow, await capture('opposite'));
  await page.setViewportSize({ width: 1000, height: 1000 });
  const resized = await capture('resized');
  assert.notEqual(resized.three.width, glow.three.width);
  await page.click('#restart');
  await page.waitForFunction(
    () => globalThis.__sceneAuthoring.generation === 2 || globalThis.__sceneAuthoringError,
    undefined,
    { timeout: 120000 },
  );
  const rebuilt = await capture('rebuilt');
  for (const engine of ['three', 'forgeax']) {
    assert.ok(
      difference(resized[engine], rebuilt[engine]) < 0.001,
      `${engine}: recreation changed the scene`,
    );
  }
  await page.evaluate(() => globalThis.__sceneAuthoring.dispose());
  assert.deepEqual(report.errors, []);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.failure = String(error.stack ?? error);
  throw error;
} finally {
  await writeFile(resolve(output, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
