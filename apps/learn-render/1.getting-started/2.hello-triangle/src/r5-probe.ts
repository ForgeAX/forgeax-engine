// apps/learn-render/1.getting-started/2.hello-triangle/src/r5-probe.ts
// R5 WebKit stability probe page (dev-only, not in dawn smoke roster).
//
// Two modes via URL hash:
//   #mode=a  over-capacity: spawn 15000 mesh entities, verify non-black frame
//                           after SSBO ceiling truncation (WS1 graceful degrade).
//   #mode=b  bad-submit:    submit a command buffer referencing a destroyed buffer,
//                           verify onError receives queue-submit-failed + no panic +
//                           next frame still renders (WS2 on_uncaptured_error isolation).
//
// Exposes window.__r5Probe for the e2e script to read results.

import { World } from '@forgeax/engine-ecs';
import { HANDLE_TRIANGLE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const statusEl = document.getElementById('status')!;

function log(msg: string): void {
  statusEl.textContent += msg + '\n';
}

function win(): Record<string, unknown> {
  return window as unknown as Record<string, unknown>;
}

const MODE = location.hash.slice(1) || 'default';
const R5_ONERROR_WAIT_MS = 2000;
const errors: Array<{ code: string; hint: string; detail?: unknown }> = [];

function serializableDetail(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...('code' in value && typeof value.code === 'string' ? { code: value.code } : {}),
    };
  }
  if (Array.isArray(value)) return value.map((entry) => serializableDetail(entry, depth + 1, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, serializableDetail(entry, depth + 1, seen)]),
  );
}

interface R5ProbeResult {
  mode: string;
  ready: boolean;
  readyError: { code: string; hint?: string } | null;
  errors: typeof errors;
  overCapacitySpawned: number;
  ceilingHitCount: number;
  exceededHitCount: number;
  drawFailures: Array<{ code: string; hint: string; detail?: unknown }>;
  badSubmitDone: boolean;
  badSubmitResult: { ok: boolean; code?: string; hint?: string; reason?: string; message?: string } | null;
  nextFrameAfterBadSubmit: boolean;
  onErrorEvents: Array<{ code: string; hint: string; timestamp: number }>;
}

const P: R5ProbeResult = {
  mode: MODE,
  ready: false,
  readyError: null,
  errors,
  overCapacitySpawned: 0,
  ceilingHitCount: 0,
  exceededHitCount: 0,
  drawFailures: [],
  badSubmitDone: false,
  badSubmitResult: null,
  nextFrameAfterBadSubmit: false,
  onErrorEvents: [],
};
win().__r5Probe = P;

function hasMatchingOnError(code: string, fromIndex: number): boolean {
  return P.onErrorEvents.slice(fromIndex).some((event) => event.code === code);
}

async function waitForMatchingOnError(code: string, fromIndex: number): Promise<boolean> {
  const deadline = performance.now() + R5_ONERROR_WAIT_MS;
  while (!hasMatchingOnError(code, fromIndex) && performance.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
  return hasMatchingOnError(code, fromIndex);
}

let _resolveReady: () => void;
const readyPromise = new Promise<void>((resolve) => {
  _resolveReady = resolve;
});
win().__r5Ready = readyPromise;

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#app');
  if (!canvas) {
    log('missing canvas#app');
    _resolveReady();
    return;
  }

  try {
    const constructed = await constructRuntimeRendererHost(canvas, {}, forgeaxBundlerAdapter());
    if (!constructed.ok) {
      const error = constructed.error;
      const code = 'code' in error ? error.code : 'engine-environment-error';
      const hint = 'hint' in error ? error.hint : error.reason;
      P.readyError = { code, hint };
      log('renderer construction failed: ' + code);
      _resolveReady();
      return;
    }
    const renderer = constructed.value.renderer;
    const host = constructed.value.debugDrawHost;
    // Module-lifetime keepalive for the renderer. hello-triangle's index.ts
    // holds its renderer reachable via an infinite recursive rAF closure;
    // this probe runs finite loops and lets main() return, so without a
    // persistent reference the renderer wrapper becomes GC-eligible. On the
    // Channel-3 (wgpu-wasm WebGL2) WebKit path, wasm-bindgen finalization
    // then drops the Rust-side Surface and the next present/lookup panics
    // with `Surface[Id(0,2)] does not exist`. Pinning to window keeps the
    // Surface alive for the page lifetime (the lifetime contract index.ts
    // gets for free from its perpetual rAF) and doubles as the e2e read hook.
    win().__r5Renderer = renderer;
    renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      const e = event.error;
      const detail = serializableDetail((e as { detail?: unknown }).detail ?? null);
      errors.push({ code: e.code, hint: e.hint || '', detail });
      P.onErrorEvents.push({
        code: e.code,
        hint: e.hint || '',
        timestamp: Date.now(),
      });
      log('onError: ' + e.code + ' ' + (e.hint || ''));
    });

    P.ready = true;
    log('render host ready, backend=' + renderer.inspect().capabilities.backendKind);

    const world = new World();
    const worldAttachment1 = renderer.attach(world);
    if (!worldAttachment1.ok) throw worldAttachment1.error;
    const lease = worldAttachment1.value;
    const drawFrame = (label = 'frame'): void => {
      const frame = renderer.draw({
        leases: [lease],
        camera: { lease },
        environment: { lease },
      });
      if (frame.ok) return;
      const detail = serializableDetail((frame.error as { detail?: unknown }).detail ?? null);
      P.drawFailures.push({ code: frame.error.code, hint: frame.error.hint || '', detail });
      log(`${label} draw failed: ${frame.error.code} ${frame.error.hint || ''}`);
      log(`draw detail: ${JSON.stringify(detail)}`);
      throw new Error(`${label} draw failed: ${frame.error.code}`);
    };
    const nextAnimationFrame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));

    // Camera at z=3, same as hello-triangle defaults.
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
      },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 1000000 } },
    );

    if (MODE === 'mode=a') {
      const N = 15000;
      log('mode a: spawning ' + N + ' entities...');
      for (let i = 0; i < N; i++) {
        world.spawn(
          {
            component: Transform,
            data: {
              pos: [(i % 200) * 0.02 - 2, Math.floor(i / 200) * 0.02 - 2, -1], quat: [0, 0, 0, 1], scale: [0.01, 0.01, 0.01],},
          },
          { component: MeshFilter, data: { assetHandle: HANDLE_TRIANGLE } },
          { component: MeshRenderer, data: {} },
        );
      }
      P.overCapacitySpawned = N;

      for (let f = 0; f < 10; f++) {
        world.update().unwrap();
        await nextAnimationFrame();
        drawFrame(`mode-a frame ${f + 1}`);
        await new Promise((r) => requestAnimationFrame(r));
      }

      P.ceilingHitCount = errors.filter((e) => e.code === 'mesh-ssbo-ceiling-reached').length;
      P.exceededHitCount = errors.filter((e) => e.code === 'mesh-ssbo-capacity-exceeded').length;
      log('done. errors=' + errors.length + ' ceiling=' + P.ceilingHitCount + ' exceeded=' + P.exceededHitCount);

      // One more draw + rAF to flush a frame for screenshot.
      world.update().unwrap();
      await nextAnimationFrame();
      drawFrame('mode-a screenshot frame');
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
      log('READY_FOR_SCREENSHOT');
    } else if (MODE === 'mode=b') {
      // Spawn visible triangle first frame.
      world.spawn(
        {
          component: Transform,
          data: {
            pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_TRIANGLE } },
        { component: MeshRenderer, data: {} },
      );

      world.update().unwrap();
      await nextAnimationFrame();
      drawFrame('mode-b baseline frame');
      await new Promise((r) => requestAnimationFrame(r));

      // Trigger a submit-period validation error on the engine's OWN live
      // device (host-owned device), not a freshly-spun second device. On the
      // Channel-3 (wgpu-wasm WebGL2) path a second adapter request without a
      // compatibleSurface fails `adapter-unavailable` (rhi-wgpu requestAdapter
      // requires a compatible surface for GL adapter enumeration), so a
      // second-device approach can never reach the bad submit on WebKit.
      // Reusing the host-owned device is also exactly what AC-06 asks: the
      // SAME host instance must survive the bad submit and render the next frame.
      try {
        const dev = host.device;

        // Buffer with COPY_SRC | COPY_DST so copyBufferToBuffer is structurally
        // valid; destroying it before submit makes the submitted command buffer
        // reference a destroyed resource -> submit-period validation error.
        const bRes = dev.createBuffer({
          label: 'r5p',
          size: 64,
          usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        if (!bRes.ok) {
          P.badSubmitResult = { ok: false, reason: 'buffer-create-failed', code: bRes.error.code };
          log('badSubmit: buffer failed ' + bRes.error.code);
          log('READY_FOR_SCREENSHOT');
          _resolveReady();
          return;
        }
        const buf = bRes.value;

        const eRes = dev.createCommandEncoder({ label: 'r5p-enc' });
        if (!eRes.ok) {
          P.badSubmitResult = { ok: false, reason: 'encoder-create-failed', code: eRes.error.code };
          log('badSubmit: encoder failed ' + eRes.error.code);
          log('READY_FOR_SCREENSHOT');
          _resolveReady();
          return;
        }
        const enc = eRes.value;
        enc.copyBufferToBuffer(buf, 0, buf, 0, 64);
        const cbRes = enc.finish();
        if (!cbRes.ok) {
          P.badSubmitResult = { ok: false, reason: 'finish-failed', code: cbRes.error.code };
          log('badSubmit: finish failed ' + cbRes.error.code);
          log('READY_FOR_SCREENSHOT');
          _resolveReady();
          return;
        }
        const cb = cbRes.value;

        // Destroy the buffer AFTER recording / finishing but BEFORE submit so
        // the in-flight command buffer references a destroyed resource.
        dev.destroyBuffer(buf);

        const submitOnErrorStart = P.onErrorEvents.length;
        const sRes = dev.queue.submit([cb]);
        P.badSubmitDone = true;
        P.badSubmitResult = sRes.ok
          ? { ok: true }
          : { ok: false, code: sRes.error.code, hint: sRes.error.hint || '' };
        log('badSubmit: ok=' + sRes.ok + ' code=' + (sRes.ok ? 'none' : sRes.error.code));

        const matchingOnError = sRes.ok
          ? false
          : await waitForMatchingOnError(sRes.error.code, submitOnErrorStart);
        log('badSubmit: matching onError=' + matchingOnError);

        // Next frame with the same renderer must still render (AC-06).
        await new Promise((r) => requestAnimationFrame(r));
        world.update().unwrap();
        drawFrame('mode-b recovery frame');
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
        P.nextFrameAfterBadSubmit = true;
        log('next frame rendered, instance survived');
        log('READY_FOR_SCREENSHOT');
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log('badSubmit exception: ' + msg);
        P.badSubmitResult = { ok: false, reason: 'exception', message: msg };
        log('READY_FOR_SCREENSHOT');
      }
    } else {
      // Default baseline: render one triangle frame.
      world.spawn(
        {
          component: Transform,
          data: {
            pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_TRIANGLE } },
        { component: MeshRenderer, data: {} },
      );
      world.update().unwrap();
      await nextAnimationFrame();
      drawFrame('default frame');
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
      log('READY_FOR_SCREENSHOT');
    }
  } catch (err: unknown) {
    if (err instanceof EngineEnvironmentError) {
      log('EngineEnvironmentError: ' + err.message);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      log('crash: ' + msg);
    }
  }
  _resolveReady();
}

main();
