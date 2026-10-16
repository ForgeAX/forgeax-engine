import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
const { values } = parseArgs({
  options: { out: { type: 'string' }, 'engine-root': { type: 'string' } },
});
if (!values.out)
  throw Error(
    'Usage: node verify_canvas_reader_browser.mjs --out NEW_DIRECTORY [--engine-root CHECKOUT]',
  );
const out = resolve(values.out);
const engine = resolve(
  values['engine-root'] ??
    resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
);
const require = createRequire(join(engine, 'package.json'));
await mkdir(out, { mode: 0o700 });
const { chromium } = require('playwright');
const { build } = createRequire(
  await realpath(join(engine, 'node_modules/tsup/dist/index.js')),
)('esbuild');
const inspectionBundle = await build({
  entryPoints: [join(engine, 'packages/ui/src/inspection.ts')],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'EngineUiInspection',
});
const browser = await chromium.launch({
  channel: 'chrome-beta',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  chromiumSandbox: true,
});
try {
  const page = await browser.newPage();
  await page.setContent('<canvas width="256" height="128"></canvas>');
  await page.addScriptTag({ content: inspectionBundle.outputFiles[0].text });
  await page.evaluate(() => {
    const prefix = document.createElement('section');
    for (let i = 0; i < 48; i++) prefix.append(document.createElement('div'));
    document.body.append(prefix);
    const host = document.createElement('section');
    const shadow = host.attachShadow({ mode: 'open' });
    for (let i = 0; i < 5; i++) shadow.append(document.createElement('span'));
    const control = document.createElement('button');
    control.className = 'control';
    control.textContent = 'OK';
    control.style.cssText =
      'position:fixed;left:112px;top:72px;width:32px;height:32px;box-sizing:border-box';
    shadow.append(control);
    document.body.append(host);
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
    if (!gl) throw Error('real WebGL2 required');
    let frame = 0;
    const draw = () => {
      frame++;
      gl.clearColor(1, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(112, 24, 32, 32);
      gl.clearColor(0, 1, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.SCISSOR_TEST);
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, gl.createFramebuffer());
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, gl.createBuffer());
    gl.pixelStorei(gl.PACK_ALIGNMENT, 8);
    gl.pixelStorei(gl.PACK_ROW_LENGTH, 64);
    gl.pixelStorei(gl.PACK_SKIP_ROWS, 2);
    gl.pixelStorei(gl.PACK_SKIP_PIXELS, 3);
    globalThis.GameGlobal = {
      document,
      __gameContextWindow: {
        wx: {
          getWindowInfo: () => ({
            windowWidth: 256,
            windowHeight: 128,
            pixelRatio: 1,
          }),
        },
        requestAnimationFrame: (callback) => requestAnimationFrame(callback),
        cancelAnimationFrame: (id) => cancelAnimationFrame(id),
        __forgeaxGameInspection: {
          renderer: () => ({ frame, completed: frame, presented: frame }),
          ui: (request) => EngineUiInspection.inspectUi(document.body, request),
        },
      },
    };
  });
  const limited = await page.evaluate(() =>
    EngineUiInspection.inspectUi(document.body, {
      selector: '.control',
      limit: 8,
      styles: [],
    }),
  );
  assert.equal(limited.ok, true);
  assert.equal(limited.value.visited, 8);
  assert.equal(limited.value.truncated, true);
  assert.deepEqual(limited.value.nodes, []);
  const source = await readFile(
    new URL('read_canvas.js', import.meta.url),
    'utf8',
  );
  const result = await page.evaluate(
    (source) =>
      new Function(
        `return (${source})({region:[0,0,256,12],selector:'.control'})`,
      )(),
    source,
  );
  assert.equal(result.status, 'captured');
  assert.ok(result.ui.value.visited > 48);
  assert.equal(result.ui.value.truncated, false);
  assert.equal(result.ui.value.nodes.length, 1);
  assert.ok(result.ui.value.nodes[0].path.includes('/shadow/'));
  assert.equal(result.bindingsRestored, true);
  assert.equal(result.pixels.length, 2);
  for (const [index, crop] of result.pixels.entries()) {
    const bytes = Buffer.from(crop.rgbaBase64, 'base64');
    const expected = index === 0 ? [255, 0, 0, 255] : [0, 255, 0, 255];
    for (let i = 0; i < bytes.length; i++)
      assert.equal(bytes[i], expected[i % 4]);
  }
  const error = await page.evaluate(() =>
    document.querySelector('canvas').getContext('webgl2').getError(),
  );
  assert.equal(error, 0);
  const envelopeBytes = Buffer.byteLength(
    JSON.stringify({ ok: true, result: { success: true, result } }),
  );
  assert.ok(envelopeBytes < 30000);
  const forcedFailure = await page.evaluate(async (source) => {
    const gl = document.querySelector('canvas').getContext('webgl2');
    const original = gl.readPixels;
    gl.readPixels = () => {
      throw Error('forced-reader-failure');
    };
    try {
      return await new Function(
        `return (${source})({region:[0,0,256,12],selector:'.control'})`,
      )();
    } finally {
      gl.readPixels = original;
    }
  }, source);
  assert.equal(forcedFailure.status, 'unavailable');
  assert.equal(forcedFailure.reason, 'forced-reader-failure');
  assert.equal(forcedFailure.bindingsRestored, true);
  const invalid = await page.evaluate(
    (source) =>
      new Function(
        `return (${source})({region:[0,0,4097,1],selector:'.control'})`,
      )(),
    source,
  );
  assert.equal(invalid.status, 'unavailable');
  assert.equal(invalid.reason, 'bounded-region-and-positive-selector-required');
  await page.evaluate(() => {
    const tail = document.createElement('section');
    for (let i = 0; i < 260; i++) tail.append(document.createElement('span'));
    document.body.append(tail);
  });
  const truncated = await page.evaluate(
    (source) =>
      new Function(
        `return (${source})({region:[0,0,256,12],selector:'.control'})`,
      )(),
    source,
  );
  assert.equal(truncated.status, 'unavailable');
  assert.equal(truncated.reason, 'visible-positive-control-required');
  assert.equal(truncated.ui.value.visited, 256);
  assert.equal(truncated.ui.value.truncated, true);
  assert.equal(truncated.ui.value.nodes.length, 1);
  await writeFile(
    join(out, 'observed.json'),
    JSON.stringify(
      { limited, result, forcedFailure, invalid, truncated },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  await writeFile(
    join(out, 'result.json'),
    JSON.stringify(
      {
        scope:
          'collector-only; real sandboxed desktop WebGL2 and Engine inspectUi over live DOM with 48 preceding elements and an open ShadowRoot; synthetic renderer receipts',
        passed: true,
        chromiumSandbox: true,
        bindingsRestored: true,
        forcedFailureRestored: true,
        glError: error,
        envelopeBytes,
        inspectionVisited: result.ui.value.visited,
        shadowPath: result.ui.value.nodes[0].path,
        truncatedObservationRejected: true,
        crops: result.pixels.map(({ rgbaBase64, ...value }) => value),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      passed: true,
      out,
      bindingsRestored: true,
      forcedFailureRestored: true,
      glError: error,
      envelopeBytes,
    }),
  );
} finally {
  await browser.close();
}
