import * as backend from '@probe/rhi-backend';
import { createBlitzUi, gpuShaders } from '@probe/ui-blitz';
import { createUiCompositor } from '@probe/ui-compositor';
import * as scene from '@probe/scene';
import { benchmarkHost as host } from '@probe/host';
import { identity, sceneName } from '@probe/identity';
import { describeBenchmarkError } from './driver.js';

// The same production sparse-strip raster/compositor used by the GPU benchmark.
// The host owns a canvas and native input; the retained UI owns layout and state.
export async function startInteractiveUi() {
  let phase = 'loading',
    ui,
    device,
    surface,
    compositor,
    detach,
    mounted,
    cancelFrame;
  let live = true,
    display,
    submitted = 0,
    completed = 0,
    receipt = null,
    work = null;
  let completion = Promise.resolve();
  const errors = [];
  const canvas = host.createGpuCanvas();
  const now = () => host.performance.now();
  const fail = (error) => {
    phase = 'failed';
    live = false;
    errors.push(describeBenchmarkError(error));
    console.error(`FORGEAX_UI_${sceneName.toUpperCase()}_FAILURE`, JSON.stringify(read()));
  };
  const read = () => ({
    phase,
    identity,
    composition: 'production-gpu-ui-compositor',
    engineGameAcceptance: false,
    host: host.facts,
    display,
    backend: device?.caps.backendKind,
    submitted,
    completed,
    receipt,
    work,
    errors: errors.slice(),
  });
  const rect = (element) => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const point = (element) => {
    const r = rect(element);
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const snapshot = () => ({ ...read(), ...(mounted?.snapshot() ?? {}) });
  async function dispose() {
    if (phase === 'disposed') return read();
    live = false;
    cancelFrame?.();
    const failures = [];
    try {
      await completion;
    } catch (error) {
      failures.push(error);
    }
    for (const release of [
      detach,
      () => mounted?.dispose(),
      () => compositor?.dispose(),
      () => surface?.unconfigure(),
      () => ui?.dispose(),
      () => host.dispose(),
    ]) {
      try {
        release?.();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      fail(new AggregateError(failures, 'GPU UI fixture cleanup failed'));
    } else phase = 'disposed';
    return read();
  }
  globalThis[`__forgeaxUi${sceneName}`] = {
    read,
    snapshot,
    dispose,
    scrollTo(top) {
      if (!Number.isFinite(top)) throw new TypeError('Scroll offset must be finite');
      mounted.scrollTo(top);
      return snapshot();
    },
  };
  const updateDisplay = () => {
    const next = host.display();
    const safeArea = next.safeArea ?? { x: 0, y: 0, width: next.width, height: next.height };
    if (
      display &&
      next.width === display.width &&
      next.height === display.height &&
      next.pixelRatio === display.pixelRatio &&
      safeArea.x === display.safeArea.x &&
      safeArea.y === display.safeArea.y &&
      safeArea.width === display.safeArea.width &&
      safeArea.height === display.safeArea.height
    )
      return;
    display = { width: next.width, height: next.height, pixelRatio: next.pixelRatio, safeArea };
    canvas.width = Math.round(next.width * next.pixelRatio);
    canvas.height = Math.round(next.height * next.pixelRatio);
    if (canvas.style) {
      canvas.style.width = `${next.width}px`;
      canvas.style.height = `${next.height}px`;
      canvas.style.touchAction = 'none';
    }
    ui?.resize(canvas.width, canvas.height, next.pixelRatio);
    mounted?.display?.(display);
  };
  async function paint() {
    if (!live) return;
    try {
      updateDisplay();
      const time = now();
      compositor.prepare(time, canvas.width, canvas.height, true, 'srgb', false);
      const encoder = device.createCommandEncoder().unwrap();
      compositor.encode(encoder, surface.getCurrentTexture().unwrap());
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      receipt = {
        sequence: ++submitted,
        submittedAt: now(),
        completedAt: null,
        width: canvas.width,
        height: canvas.height,
      };
      const current = receipt;
      completion = device.queue.onSubmittedWorkDone().then(() => {
        current.completedAt = now();
        completed++;
      });
      compositor.submitted(completion);
      await completion;
      if (phase === 'loading') {
        phase = 'ready';
        console.info(`FORGEAX_UI_${sceneName.toUpperCase()}_READY`, JSON.stringify(snapshot()));
      }
      if (live) cancelFrame = host.requestAnimationFrame(paint);
    } catch (error) {
      fail(error);
    }
  }
  try {
    updateDisplay();
    const resources = await host.resources;
    ui = await createBlitzUi({
      ...resources,
      html: scene.html,
      fontFamily: scene.fontFamily,
      width: canvas.width,
      height: canvas.height,
      pixelRatio: display.pixelRatio,
      onError: fail,
    });
    mounted = scene.mount(ui.document, { now, rect, point });
    mounted.display?.(display);
    detach = host.attachInput(ui, fail, canvas);
    await host.initializeWgpu(backend, canvas);
    device = (
      await (await backend.requestAdapter(undefined, canvas)).unwrap().requestDevice()
    ).unwrap();
    surface = backend.rhi.acquireCanvasContext(canvas).unwrap();
    surface
      .configure({
        device,
        format: 'rgba8unorm',
        usage: 0x10,
        alphaMode: 'opaque',
        colorSpace: 'srgb',
      })
      .unwrap();
    compositor = await createUiCompositor({
      device,
      format: 'rgba8unorm',
      source: {
        kind: 'sparse-strips',
        shaders: gpuShaders,
        paint: (time) => {
          const frame = ui.paintGpu(time);
          if (frame)
            work = {
              width: frame.width,
              height: frame.height,
              imageCount: frame.images.length,
              images: frame.images.map(({ id, width, height }) => ({ id, width, height })),
              passes: frame.passes.map(({ kind, instances }) => ({
                kind,
                bytes: instances.byteLength,
              })),
            };
          return frame;
        },
      },
      createShaderModule: async (owner, code) =>
        (await backend.createShaderModule(owner, { code })).unwrap(),
    });
    host.showGpuCanvas(canvas);
    await paint();
  } catch (error) {
    fail(error);
  }
  return read();
}
