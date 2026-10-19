import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
await mkdir('artifacts/three-compat', { recursive: true });
const launch = JSON.parse(await readFile('scripts/ci/browser-launch.json', 'utf8'));
const workerSource = `let preparedDevice;
(async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('adapter unavailable');
  preparedDevice = await adapter.requestDevice();
  postMessage('ready');
})().catch(error=>postMessage({error:String(error)}));
onmessage = async ({data}) => {
  const status = new Int32Array(data, 0, 1);
  const output = new Uint8Array(data, 4);
  let device;
  try {
    device = preparedDevice;
    const texture = device.createTexture({size: [1,1], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
    const buffer = device.createBuffer({size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({colorAttachments: [{view: texture.createView(), clearValue: [0.25,0.5,0.75,1], loadOp:'clear',storeOp:'store'}]});
    pass.end();
    encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:256},[1,1]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    output.set(new Uint8Array(buffer.getMappedRange()).subarray(0,4));
    buffer.unmap(); buffer.destroy(); texture.destroy();
    Atomics.store(status,0,1);
  } catch(error) {
    output.set(new TextEncoder().encode(String(error)).subarray(0,output.length));
    Atomics.store(status,0,-1);
  } finally { device?.destroy(); }
};`;
const browser = await chromium.launch({
  ...launch,
  headless: true,
  args: [...launch.args, '--use-angle=swiftshader', '--disable-gpu-watchdog'],
  chromiumSandbox: true,
});
try {
  const page = await browser.newPage();
  await page.route('http://localhost:5190/sync-bridge-spike', (route) =>
    route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/html',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
      body: '<!doctype html><title>Synchronous readback bridge feasibility</title>',
    }),
  );
  await page.goto('http://localhost:5190/sync-bridge-spike');
  const report = await page.evaluate(async (code) => {
    if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined')
      return { status: 'unavailable', crossOriginIsolated };
    const shared = new SharedArrayBuffer(1028),
      status = new Int32Array(shared, 0, 1);
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const worker = new Worker(url);
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('worker initialization deadline')), 15000);
      worker.onmessage = ({ data }) => {
        clearTimeout(deadline);
        data === 'ready' ? resolve() : reject(new Error(JSON.stringify(data)));
      };
      worker.onerror = (event) => {
        clearTimeout(deadline);
        reject(new Error(event.message));
      };
    });
    const start = performance.now();
    let reads = 0;
    try {
      worker.postMessage(shared);
      // Deliberately synchronous: no await and no event-loop yield on the calling thread.
      while (Atomics.load(status, 0) === 0) {
        reads++;
        if ((reads & 65535) === 0 && performance.now() - start > 20000)
          throw new Error('worker GPU readback deadline');
      }
      const state = Atomics.load(status, 0);
      if (state !== 1)
        throw new Error(new TextDecoder().decode(new Uint8Array(shared, 4)).replace(/\0+$/, ''));
      return {
        status: 'passed',
        crossOriginIsolated,
        callerWait: 'bounded synchronous spin',
        elapsedMs: performance.now() - start,
        atomicReads: reads,
        pixels: [...new Uint8Array(shared, 4, 4)],
        scope:
          'Preinitialized WebGPU Worker only; asynchronous initialization must finish before the synchronous caller. Not an integrated Forgeax renderer bridge',
      };
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  }, workerSource);
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.pixels, [64, 128, 191, 255]);
  await writeFile(
    'artifacts/three-compat/sync-readback-spike.json',
    JSON.stringify(report, null, 2),
  );
  console.log(report);
} finally {
  await browser.close();
}
