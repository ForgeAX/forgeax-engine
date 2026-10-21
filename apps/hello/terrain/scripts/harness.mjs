import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { setupGpuShim } from '../../triangle/scripts/smoke-helpers.mjs';
import { createApp } from '@forgeax/engine-app/browser';
import { physicsPlugin } from '@forgeax/engine-physics';
import { Terrain, terrainHeight } from '@forgeax/engine-terrain';
import { querySubmittedTerrainHeight } from '@forgeax/engine-render';
import { vec3 } from '@forgeax/engine-math';
import { buildTerrainWorld } from '../src/scene.ts';

export async function terrainHarness({
  width = 320,
  height = 180,
  backendArgs,
  appOptions = {},
  rootGuid,
} = {}) {
  const dist = resolve(import.meta.dirname, '../dist');
  assert(
    existsSync(resolve(dist, 'pack-index.json')),
    'build hello-terrain before running its Dawn smoke',
  );
  const shaderManifestBytes = readFileSync(resolve(dist, 'shaders/manifest.json'));
  const shaderManifest = JSON.parse(shaderManifestBytes.toString());
  assert(
    shaderManifest.materialShaders.some(
      (entry) => entry.identifier === 'forgeax::default-shadow-caster',
    ),
    'complete the app shader producer before GPU acceptance; use a full app build or materialize its CI transport',
  );
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://terrain.test',
    );
    if (url.origin !== 'http://terrain.test') return previousFetch(input, init);
    const path = resolve(dist, `.${url.pathname}`);
    assert(path.startsWith(dist + sep), 'asset URL must stay inside the emitted build');
    return existsSync(path) ? new Response(readFileSync(path)) : new Response('', { status: 404 });
  };
  const shim = await setupGpuShim({
    width,
    height,
    backendArgs,
    rerunCmd: 'pnpm --filter @forgeax/hello-terrain smoke',
  });
  Object.assign(shim.mockCanvas, {
    tagName: 'CANVAS',
    isConnected: true,
    clientWidth: width,
    clientHeight: height,
  });
  const errors = [];
  // Match the production publication identity so repeated Apps share admission.
  const manifest = 'http://terrain.test/shaders/manifest.json';
  const app = (
    await createApp(
      shim.mockCanvas,
      { platform: createSmokePlatform(shim.mockCanvas), plugins: [physicsPlugin('rapier-3d')], gpuPassTiming: {}, ...appOptions },
      { shaderManifestUrl: manifest },
    )
  ).unwrap();
  app.assets.configurePackIndex('http://terrain.test/pack-index.json');
  const subjects = await buildTerrainWorld(app, rootGuid);
  app.onError((error) => errors.push(error));
  // The harness calls Renderer.draw directly, outside the App frame error fan-out.
  app.renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  shim.sharedDevice.addEventListener('uncapturederror', (event) =>
    errors.push({ code: 'webgpu-validation', message: event.error.message }),
  );
  const lease = app.renderer.attach(app.world).unwrap();
  let completed = 0,
    firstReceipt;
  const frame = async () => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const frameStart = performance.now();
      app.world.update(1 / 60).unwrap();
      const diagnostic = process.env.TERRAIN_PERF_CPU_DIAGNOSTICS === '1';
      const threadBefore = diagnostic ? process.threadCpuUsage() : undefined;
      const usageBefore = diagnostic ? process.resourceUsage() : undefined;
      const drawStartedUtcMs = diagnostic ? Date.now() : undefined;
      const start = performance.now();
      const updateMs = start - frameStart;
      const receipt = app.renderer
        .draw({ leases: [lease], camera: { lease }, environment: { lease } })
        .unwrap();
      const cpuMs = performance.now() - start;
      const thread = diagnostic ? process.threadCpuUsage(threadBefore) : undefined;
      const usage = diagnostic ? process.resourceUsage() : undefined;
      const drawDiagnostics =
        thread === undefined || usage === undefined || usageBefore === undefined
          ? undefined
          : {
              drawStartedUtcMs,
              monotonicStartMs: start,
              wallMs: cpuMs,
              threadUserMs: thread.user / 1000,
              threadSystemMs: thread.system / 1000,
              processVoluntaryContextSwitches:
                usage.voluntaryContextSwitches - usageBefore.voluntaryContextSwitches,
              processInvoluntaryContextSwitches:
                usage.involuntaryContextSwitches - usageBefore.involuntaryContextSwitches,
            };
      (await receipt.completed).unwrap();
      const receiptCompletedMs = diagnostic ? performance.now() : undefined;
      await shim.sharedDevice.queue.onSubmittedWorkDone();
      const queueDrainedMs = diagnostic ? performance.now() : undefined;
      if (receipt.presentation !== 'ready') {
        assert.deepEqual(errors, []);
        await new Promise((resolve) => setImmediate(resolve));
        continue;
      }
      firstReceipt ??= receipt;
      completed++;
      return {
        receipt,
        cpuMs,
        ...(drawDiagnostics === undefined ? {} : { drawDiagnostics }),
        ...(receiptCompletedMs === undefined || queueDrainedMs === undefined
          ? {}
          : {
              completionDiagnostics: {
                frameId: receipt.frameId,
                frameStartMs: frameStart,
                drawStartMs: start,
                receiptCompletedMs,
                queueDrainedMs,
              },
            }),
        updateMs,
        drawToCompletedMs: performance.now() - start,
        frameToCompletedMs: performance.now() - frameStart,
      };
    }
    throw new Error('terrain source did not become ready within 60 seconds');
  };
  const pixels = async () => {
    const stride = Math.ceil((width * 4) / 256) * 256;
    const buffer = shim.sharedDevice.createBuffer({
      size: stride * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = shim.sharedDevice.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: shim.renderTarget },
      { buffer, bytesPerRow: stride },
      { width, height },
    );
    shim.sharedDevice.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buffer.getMappedRange()),
      out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      out.set(src.subarray(y * stride, y * stride + width * 4), y * width * 4);
    if (shim.renderTarget.format.startsWith('bgra'))
      for (let i = 0; i < out.length; i += 4) {
        const red = out[i];
        out[i] = out[i + 2];
        out[i + 2] = red;
      }
    buffer.unmap();
    buffer.destroy();
    return out;
  };
  const verify = async (receipt, view) => {
    const current = app.world.get(subjects.terrain, Terrain).unwrap();
    const root = app.assets.read(current.asset).unwrap();
    assert.equal(root.kind, 'terrain');
    const hit = app.physics.raycast(vec3.create(62, 50, 62), vec3.create(0, -1, 0), 100);
    assert(hit, 'actual heightfield must intersect the downward ray');
    assert(
      Math.abs(hit.point[1] - terrainHeight(root, 62, 62)) <= 1e-5,
      'Rapier must match the author triangle diagonal',
    );
    const submittedHeight = (
      await querySubmittedTerrainHeight(receipt, {
        worldId: 0,
        entity: subjects.terrain,
        x: 62,
        z: 62,
        ...(view === undefined ? {} : { view }),
      })
    ).unwrap();
    assert(Number.isFinite(submittedHeight));
    const bytes = await pixels();
    let covered = 0;
    for (let i = 0; i < bytes.length; i += 4)
      if (bytes[i] + bytes[i + 1] + bytes[i + 2] > 30) covered++;
    assert(covered > width * height * 0.15, 'terrain must cover a substantial nonblack region');
    assert.deepEqual(errors, [], 'WebGPU validation and runtime errors are fatal');
    return {
      gameplayHeight: terrainHeight(root, 62, 62),
      collisionHeight: hit.point[1],
      submittedHeight,
      coveredPixels: covered,
      width,
      height,
      completedFrames: completed,
    };
  };
  return {
    app,
    subjects,
    shim,
    errors,
    frame,
    draw: () => app.renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
    pixels,
    verify,
    get completed() {
      return completed;
    },
    get firstReceipt() {
      return firstReceipt;
    },
    async dispose() {
      try {
        (await app.dispose()).unwrap();
      } finally {
        shim.renderTarget?.destroy();
        shim.sharedDevice?.destroy();
        globalThis.fetch = previousFetch;
        delete globalThis.navigator.gpu;
      }
    },
  };
}
