// Browser host for the same frozen App lifecycle, served by level-streaming-preview.mjs.
import { createBrowserPlatform } from '../../packages/platform-browser/dist/index.mjs';
import { runLevelStreamingRuntime } from './level-streaming-runtime.mjs';

const button = document.querySelector('button'),
  status = document.querySelector('#status');
const saveReport = async (report) => {
  globalThis.levelStreamingResult = report;
  const saved = await (
    await fetch('/__level/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    })
  ).json();
  status.textContent = `${report.qualified ? 'Qualified' : 'Unqualified'}: ${saved.path}`;
};
button.addEventListener('click', async () => {
  button.disabled = true;
  const controller = new AbortController();
  const query = new URLSearchParams(location.search);
  const diagnosis = query.get('diagnose');
  const traceLogic = query.get('logic-timing') === '1';
  let restoreSurface;
  try {
    const fixture = await (await fetch('/__level/fixture')).json();
    const canvas = document.querySelector('canvas');
    if (query.get('execution') === 'split') {
      const { runSplitLevelBenchmark } = await import('./level-streaming-split.mjs');
      await saveReport(
        await runSplitLevelBenchmark(canvas, fixture, {
          firstCycle: diagnosis === 'first-cycle',
          isolateCopies:
            diagnosis === 'one-hidden' ? 1 : diagnosis === 'four-hidden' ? 4 : undefined,
          shadowWorkload: query.get('shadow-workload') === '1',
          traceLogic,
          progress({ phase, frames }) {
            status.textContent = `${phase} (${frames} observations)`;
          },
        }),
      );
      return;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) throw Error('Browser WebGPU adapter unavailable');
    const info = adapter.info;
    const surface = canvas.getContext('webgpu');
    if (surface === null) throw Error('Browser WebGPU canvas context unavailable');
    const getCurrentTexture = surface.getCurrentTexture;
    const surfaceTextures = new WeakSet();
    surface.getCurrentTexture = function () {
      const texture = getCurrentTexture.call(this);
      surfaceTextures.add(texture);
      return texture;
    };
    restoreSurface = () => {
      surface.getCurrentTexture = getCurrentTexture;
    };
    const report = await runLevelStreamingRuntime({
      ...fixture,
      traceLogic,
      canvas,
      surfaceTextures,
      platform: createBrowserPlatform(canvas).unwrap(),
      backend: 'chromium-webgpu',
      shaderManifestUrl: '/__level/shaders',
      signal: controller.signal,
      fetcher: (uri, options) => fetch(`/__level/package?uri=${encodeURIComponent(uri)}`, options),
      identity: {
        ...fixture.hostIdentity,
        userAgent: navigator.userAgent,
        crossOriginIsolated,
        adapter: {
          vendor: info.vendor,
          architecture: info.architecture,
          device: info.device,
          description: info.description,
        },
        heapObservation:
          'Chromium precise JS heap plus isolated-agent memory including external backing/WASM',
      },
      progress: (event) => {
        status.textContent = `${event.phase} (${event.frames} observations)`;
        if (diagnosis === 'first-cycle' && event.phase === 'copies-0/cycle-1/prepare')
          controller.abort(
            Error(
              'first complete cycle diagnostic ends; original full profile remains unqualified',
            ),
          );
      },
      heap: async () => {
        if (typeof globalThis.gc !== 'function' || performance.memory === undefined)
          throw Error(
            'retained heap observation unavailable; launch with --js-flags=--expose-gc and --enable-precise-memory-info',
          );
        globalThis.gc();
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (typeof performance.measureUserAgentSpecificMemory !== 'function')
          throw Error('isolated-agent external backing/WASM memory observation unavailable');
        const agent = await performance.measureUserAgentSpecificMemory();
        return { jsHeapBytes: performance.memory.usedJSHeapSize, agentBytes: agent.bytes };
      },
    });
    await saveReport(report);
  } catch (cause) {
    status.textContent = cause.stack ?? String(cause);
    globalThis.levelStreamingFailure = { message: cause.message, stack: cause.stack };
  } finally {
    restoreSurface?.();
    button.disabled = false;
  }
});
