// Real browser compositor checks; this fixture owns its frame marker and contains no Engine.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserCapture } from '../dist/index.mjs';

const root = await mkdtemp(join(tmpdir(), 'forgeax-capture-policy-'));
const lightweight = process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1';
const positiveEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
const viewport = lightweight
  ? {
      width: positiveEnv('FORGEAX_BROWSER_CI_VIEWPORT_WIDTH', 320),
      height: positiveEnv('FORGEAX_BROWSER_CI_VIEWPORT_HEIGHT', 180),
    }
  : {};
await writeFile(
  join(root, 'forge.json'),
  JSON.stringify({
    schemaVersion: '3.0.0',
    id: 'capture-policy',
    name: 'Capture policy',
    roots: {},
  }),
);
await writeFile(join(root, 'package.json'), '{"name":"capture-policy","type":"module"}');
await writeFile(join(root, 'main.ts'), 'export default {};');
const gpuScene = `<!doctype html><style>body{margin:0}</style><canvas width="256" height="256"></canvas><script>
(async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', event => console.error(event.error.message));
  const context = document.querySelector('canvas').getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  const module = device.createShaderModule({ code:
    '@vertex fn vs(@builtin(vertex_index) id:u32)->@builtin(position) vec4f {' +
    'var p=array<vec2f,3>(vec2f(0,0.8),vec2f(-0.8,-0.8),vec2f(0.8,-0.8));return vec4f(p[id],0,1);}' +
    '@fragment fn fs()->@location(0) vec4f{return vec4f(1,0.2,0.1,1);}' });
  const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] } });
  let frame = 0;
  function draw() {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(),
      loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.1, g: 0.2, b: 0.8, a: 1 } }] });
    pass.setPipeline(pipeline); pass.draw(3); pass.end(); device.queue.submit([encoder.finish()]);
    document.documentElement.dataset.forgeaxFrameSubmitted = String(++frame);
    requestAnimationFrame(draw);
  }
  draw();
})().catch(error => { console.error(error); throw error; });
</script>`;
let interruptedProbes = 0;
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html');
  if (request.url === '/probe-navigation') {
    response.end(`<canvas width="64" height="64"></canvas><script>
      navigator.gpu.requestAdapter = () => {
        location.replace('/gpu?probe-navigation');
        return new Promise(() => {});
      };
    </script>`);
    return;
  }
  if (request.url === '/gpu?probe-navigation') interruptedProbes++;
  response.end(
    request.url?.startsWith('/gpu')
      ? gpuScene
      : '<canvas width="64" height="64"></canvas><script>document.querySelector("canvas").getContext("2d").fillRect(0,0,64,64);document.documentElement.dataset.forgeaxFrameSubmitted="1";</script>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = createBrowserCapture(root);
const results = [];
let watchdog;
try {
  const help = JSON.parse(
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('../dist/cli.mjs', import.meta.url)),
        'help',
        `--root=${root}`,
        '--json=true',
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(help.ok, true);
  assert.ok(Array.isArray(help.value.nodes));
  const session = await browser.open({
    headless: true,
    backend: 'software',
    serverUrl: `http://127.0.0.1:${server.address().port}`,
    ...viewport,
  });
  watchdog = setTimeout(() => void session.close(), 15_000);
  await session.page.evaluate(() => console.error('capture-policy diagnostic'));
  const observed = await session.capture(undefined, { purpose: 'observe', timeoutMs: 5_000 });
  assert.equal(observed.ok, true);
  assert.equal(observed.pixels.rendered, false);
  assert.deepEqual(session.report().consoleErrors, ['capture-policy diagnostic']);
  assert.equal(
    (await readFile(observed.output)).subarray(0, 8).toString('hex'),
    '89504e470d0a1a0a',
  );
  results.push({
    operation: 'observe',
    ok: observed.ok,
    rendered: observed.pixels.rendered,
    consoleErrors: session.report().consoleErrors,
  });
  await assert.rejects(session.capture(undefined, { timeoutMs: 3_000 }), (error) => {
    assert.equal(error.code, 'software-capture-runtime-failed');
    results.push({ operation: 'validate', code: error.code });
    return true;
  });
  await assert.rejects(
    session.capture('absent', { purpose: 'observe', timeoutMs: 300 }),
    (error) => {
      assert.equal(error.code, 'browser-capture-timeout');
      assert.equal(error.detail.condition, 'the requested checkpoint');
      results.push({ operation: 'checkpoint', code: error.code, detail: error.detail });
      return true;
    },
  );
  clearTimeout(watchdog);
  await session.close();
  // A real document replacement destroys the asynchronous startup probe.
  // The replacement must provide fresh readiness and real GPU pixels.
  const navigated = await browser.open({
    headless: true,
    backend: 'software',
    serverUrl: `http://127.0.0.1:${server.address().port}/probe-navigation`,
    ...viewport,
  });
  try {
    const capture = await navigated.capture(undefined, { timeoutMs: 10_000 });
    assert.equal(interruptedProbes, 1);
    assert.equal(capture.pixels.rendered, true);
    assert.deepEqual(navigated.report().pageErrors, []);
    assert.deepEqual(navigated.report().consoleErrors, []);
    results.push({ operation: 'startup-probe-navigation', rendered: true });
  } finally {
    await navigated.close();
  }
  for (const headless of [true, false]) {
    const gpu = await browser.open({
      headless,
      backend: 'software',
      serverUrl: `http://127.0.0.1:${server.address().port}/gpu`,
      ...viewport,
    });
    try {
      const capture = await gpu.capture(undefined, { timeoutMs: 10_000 });
      assert.equal(capture.pixels.rendered, true);
      assert.deepEqual(gpu.report().pageErrors, []);
      assert.deepEqual(gpu.report().consoleErrors, []);
      results.push({
        operation: 'webgpu-compositor',
        headless,
        rendered: capture.pixels.rendered,
        backend: gpu.report().backend,
      });
    } finally {
      await gpu.close();
    }
  }
  console.log(JSON.stringify({ ok: true, results }));
} catch (error) {
  console.log(
    JSON.stringify({ ok: false, results, error: { code: error.code, message: error.message } }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
