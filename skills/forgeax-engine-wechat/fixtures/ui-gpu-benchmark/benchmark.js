import { createGuideProbe } from './guide.js';
import { describeBenchmarkError, waitForStartupState } from './driver.js';
import * as backend from '@probe/rhi-backend';
import { createGpuUiRaster } from '@probe/gpu-ui-raster';
import { createUiCompositor } from '@probe/ui-compositor';
import { gpuShaders } from '@probe/ui-blitz';
import { compareUiRaster } from '@probe/ui-oracle';
import { benchmarkHost } from '@probe/host';
const { performance, requestAnimationFrame } = benchmarkHost;
const canvas = benchmarkHost.referenceCanvas,
  context = canvas.getContext('2d');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const raf = () => new Promise(requestAnimationFrame);
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};
const stats = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0],
    median: s[Math.floor(s.length / 2)],
    p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
    max: s.at(-1),
    mean: values.reduce((a, b) => a + b, 0) / values.length,
  };
};
const facts = {
  kind: 'Real GPU UI owner',
  scope:
    'Actual startup/guide/controls. Fixture game messages, no 3D scene. CPU oracle/readback excluded from timed 60 updates.',
  width: 2532,
  height: 1170,
  pixelRatio: 3,
  host: benchmarkHost.facts,
  phases: [],
};
let device,
  raster,
  compositor,
  surface,
  gl,
  preparedFrame,
  captureNext = false,
  gpu,
  cpu,
  lastCpu,
  sequence = 0,
  pending = [];
const receipts = [];
const background = [32, 48, 64, 255];
function frameFacts(frame) {
  if (frame === null) return null;
  return {
    width: frame.width,
    height: frame.height,
    layerWidth: frame.layerWidth,
    layerHeight: frame.layerHeight,
    layerPages: frame.layerPages,
    scratch: frame.scratch,
    images: frame.images.map((image) => ({
      id: image.id,
      width: image.width,
      height: image.height,
      bytes: image.data.byteLength,
    })),
    passes: frame.passes.map((pass) => ({
      kind: pass.kind,
      target: pass.target,
      instanceBytes: pass.instances.byteLength,
    })),
    textures: Object.fromEntries(
      Object.entries(frame)
        .filter(
          ([, value]) => value && typeof value === 'object' && 'width' in value && 'data' in value,
        )
        .map(([key, value]) => [
          key,
          { width: value.width, height: value.height, bytes: value.data.byteLength },
        ]),
    ),
  };
}
async function observeGl(run) {
  if (!gl) return { value: run(), calls: null };
  const calls = {},
    restore = [];
  for (const name of [
    'drawArrays',
    'drawArraysInstanced',
    'drawElements',
    'drawElementsInstanced',
    'bindFramebuffer',
    'useProgram',
    'bindTexture',
    'bufferSubData',
    'texImage2D',
    'texSubImage2D',
    'clear',
    'blitFramebuffer',
    'readPixels',
    'getBufferSubData',
  ]) {
    const original = gl[name];
    gl[name] = function (...args) {
      const row = (calls[name] ??= { count: 0, arguments: [] });
      row.count++;
      if (row.arguments.length < 12)
        row.arguments.push(
          args.map((value) =>
            ArrayBuffer.isView(value)
              ? { bytes: value.byteLength }
              : value instanceof ArrayBuffer
                ? { bytes: value.byteLength }
                : typeof value === 'object'
                  ? value === null
                    ? null
                    : value.constructor.name
                  : value,
          ),
        );
      return original.apply(this, args);
    };
    restore.push(() => {
      gl[name] = original;
    });
  }
  try {
    const value = run();
    // The RHI presents its real surface in a microtask after submit.
    await Promise.resolve();
    return { value, calls };
  } finally {
    for (const release of restore.reverse()) release();
  }
}
function readPresentedWebGlCanvas() {
  const width = facts.width,
    height = facts.height;
  const bindings = [
    [gl.PACK_ALIGNMENT, 1],
    [gl.PACK_ROW_LENGTH, 0],
    [gl.PACK_SKIP_PIXELS, 0],
    [gl.PACK_SKIP_ROWS, 0],
  ].map(([name, value]) => [name, value, gl.getParameter(name)]);
  const framebuffer = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  const buffer = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
  const bottomUp = new Uint8Array(width * height * 4);
  try {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    for (const [name, value] of bindings) gl.pixelStorei(name, value);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp);
  } finally {
    for (const [name, , value] of bindings) gl.pixelStorei(name, value);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
  }
  const topDown = new Uint8Array(bottomUp.length),
    stride = width * 4;
  for (let y = 0; y < height; y++)
    topDown.set(bottomUp.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride);
  return topDown;
}
function clearBackground(encoder) {
  const texture = surface.getCurrentTexture().unwrap();
  const view = device.createTextureView(texture, { format: 'rgba8unorm' }).unwrap();
  const clear = encoder.beginRenderPass({
    label: 'benchmark-background',
    colorAttachments: [
      {
        view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: {
          r: background[0] / 255,
          g: background[1] / 255,
          b: background[2] / 255,
          a: 1,
        },
      },
    ],
  });
  clear.end();
  return texture;
}
const renderGpu = (ui, time) => {
  const start = performance.now(),
    frame = ui.paintGpu(time),
    paintEnd = performance.now();
  if (frame === null && !compositor)
    return { time, rgba: false, bytes: 0, rasterMs: paintEnd - start };
  preparedFrame = frame;
  const prepareStart = performance.now();
  if (compositor) compositor.prepare(time, facts.width, facts.height, false, 'srgb', false);
  else raster.prepare(frame);
  const prepareEnd = performance.now();
  const encoder = device.createCommandEncoder().unwrap();
  let texture;
  if (compositor) {
    texture = clearBackground(encoder);
    compositor.encode(encoder, texture);
  } else raster.encode(encoder);
  let readback;
  const captureSurface = captureNext && compositor;
  captureNext = false;
  if (captureSurface && !gl) {
    const stride = Math.ceil((facts.width * 4) / 256) * 256;
    readback = {
      buffer: device.createBuffer({ size: stride * facts.height, usage: 0x01 | 0x08 }).unwrap(),
      stride,
    };
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: readback.buffer, bytesPerRow: stride, rowsPerImage: facts.height },
      { width: facts.width, height: facts.height, depthOrArrayLayers: 1 },
    );
  }
  const command = encoder.finish().unwrap(),
    encodeEnd = performance.now();
  const submitStart = performance.now();
  device.queue.submit([command]).unwrap();
  const submitEnd = performance.now();
  const receipt = {
    sequence: ++sequence,
    time,
    start,
    submittedAt: submitEnd,
    paintGpuMs: paintEnd - start,
    prepareMs: prepareEnd - prepareStart,
    encodeMs: encodeEnd - prepareEnd,
    submitCpuMs: submitEnd - submitStart,
    passes: frame?.passes.length ?? 0,
    compositePasses: compositor ? 1 : 0,
    backgroundClearPasses: compositor ? 1 : 0,
    instanceBytes: frame?.passes.reduce((n, p) => n + p.instances.byteLength, 0) ?? 0,
    completedAt: null,
  };
  const completed = device.queue.onSubmittedWorkDone().then(() => {
    receipt.completedAt = performance.now();
  });
  (compositor ?? raster).submitted(completed);
  pending.push(completed);
  receipts.push(receipt);
  if (captureSurface && gl) {
    // WebGL surfaces expose only RENDER_ATTACHMENT. Read the real presented
    // canvas after the RHI present microtask, before the browser discards it.
    readback = { pixels: Promise.resolve().then(readPresentedWebGlCanvas) };
  }
  return { time, rgba: frame !== null, bytes: 0, rasterMs: paintEnd - start, receipt, readback };
};
const renderCpu = (ui, time) => {
  const start = performance.now(),
    rgba = ui.paint(time),
    elapsed = performance.now() - start;
  if (rgba) lastCpu = rgba;
  return { time, rgba: rgba !== null, bytes: rgba?.length ?? 0, rasterMs: elapsed };
};
const center = (element) => {
  const r = element.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};
const touchBoth = (phase, id, x, y) => {
  for (const probe of [gpu, cpu]) probe?.pointer(phase, id, x, y);
};
const tapBoth = (part) => {
  const p = center(gpu.element(part));
  touchBoth('down', 9, p.x, p.y);
  touchBoth('up', 9, p.x, p.y);
};
const flush = async () => {
  const waits = pending;
  pending = [];
  await Promise.all(waits);
};
function compositeSemantics(source, expected, actual, width) {
  let transparent = -1,
    translucent = -1,
    separation = 0;
  for (let i = 0; i < source.length; i += 4) {
    const alpha = source[i + 3] / 255;
    if (alpha === 0 && transparent === -1) transparent = i;
    const distance = Math.max(source[i], source[i + 1], source[i + 2]) * (1 - alpha);
    if (alpha > 0 && alpha < 1 && distance > separation) {
      translucent = i;
      separation = distance;
    }
  }
  check(
    transparent >= 0 && translucent >= 0 && separation > 255 * 0.05,
    'Reference must distinguish background preservation and premultiplied blending',
  );
  const sample = (i) => ({
    x: (i / 4) % width,
    y: Math.floor(i / 4 / width),
    source: Array.from(source.subarray(i, i + 4)),
    expected: Array.from(expected.subarray(i, i + 4)),
    actual: Array.from(actual.subarray(i, i + 4)),
  });
  const result = {
    background: sample(transparent),
    premultiplied: sample(translucent),
    wrongStraightAlphaSeparation: separation / 255,
  };
  check(
    result.background.actual.every((value, channel) => Math.abs(value - background[channel]) <= 1),
    'Composite load must retain the colored background',
  );
  check(
    result.premultiplied.actual.every(
      (value, channel) => Math.abs(value - result.premultiplied.expected[channel]) / 255 <= 0.05,
    ),
    'Composite must blend premultiplied UI exactly once',
  );
  return result;
}
async function capture(name, time) {
  captureNext = !!compositor;
  const rendered = gpu.paint(time);
  cpu?.paint(time);
  await flush();
  const width = 2532,
    height = 1170,
    stride = Math.ceil((width * 4) / 256) * 256;
  let actual;
  if (rendered.readback?.pixels) actual = await rendered.readback.pixels;
  else {
    const buffer =
      rendered.readback?.buffer ??
      device.createBuffer({ size: stride * height, usage: 0x01 | 0x08 }).unwrap();
    try {
      if (!compositor) {
        const encoder = device.createCommandEncoder().unwrap();
        encoder.copyTextureToBuffer(
          { texture: raster.texture },
          { buffer, bytesPerRow: stride, rowsPerImage: height },
          { width, height, depthOrArrayLayers: 1 },
        );
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        const complete = device.queue.onSubmittedWorkDone();
        raster.submitted(complete);
        await complete;
      }
      const mapped = (await buffer.mapAsync(1)).unwrap();
      try {
        const bytes = new Uint8Array(mapped.getMappedRange().unwrap());
        actual = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++)
          actual.set(bytes.subarray(y * stride, y * stride + width * 4), y * width * 4);
      } finally {
        mapped.unmap();
      }
    } finally {
      device.destroyBuffer(buffer).unwrap();
    }
  }
  let expected = lastCpu;
  if (cpu && compositor) {
    expected = new Uint8Array(lastCpu.length);
    for (let i = 0; i < expected.length; i += 4) {
      for (let c = 0; c < 3; c++)
        expected[i + c] = Math.round(lastCpu[i + c] + background[c] * (1 - lastCpu[i + 3] / 255));
      expected[i + 3] = 255;
    }
  }
  const difference = cpu ? compareUiRaster(expected, actual) : null;
  const semantics = cpu && compositor ? compositeSemantics(lastCpu, expected, actual, width) : null;
  if (difference)
    check(difference.maxError <= 0.05, `${name} parity ${JSON.stringify(difference)}`);
  const pixels = context.createImageData(width, height);
  pixels.data.set(actual);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const a = pixels.data[i + 3];
    if (a)
      for (let c = 0; c < 3; c++)
        pixels.data[i + c] = Math.min(255, Math.round((pixels.data[i + c] * 255) / a));
  }
  if (!compositor) context.putImageData(pixels, 0, 0);
  const result = {
    name,
    difference,
    semantics,
    width,
    height,
    completionReceipts: receipts.length,
  };
  facts.phases.push(result);
  return result;
}
export const nativeUiProbe = {
  facts,
  async initialize({ backend: requestedBackend, cpuReference = true, includeComposite = false }) {
    const gpuCanvas = benchmarkHost.createGpuCanvas();
    gpuCanvas.width = facts.width;
    gpuCanvas.height = facts.height;
    if (requestedBackend === 'wgpu-webgl2') {
      await benchmarkHost.initializeWgpu(backend, gpuCanvas);
    }
    device = (
      await (await backend.requestAdapter(undefined, gpuCanvas)).unwrap().requestDevice()
    ).unwrap();
    facts.backend = device.caps.backendKind;
    facts.timestampQuery = device.caps.timestampQuery;
    facts.includeComposite = includeComposite;
    facts.scope = includeComposite
      ? 'Production UI raster + screen-ui-composite into actual canvas surface over a constant diagnostic background; no 3D scene or simulator bridge.'
      : facts.scope;
    check(facts.backend === requestedBackend, `expected ${requestedBackend}, got ${facts.backend}`);
    facts.cpuReference = cpuReference
      ? 'measured'
      : 'skipped; matching-source evidence must be supplied separately';
    if (requestedBackend === 'wgpu-webgl2') {
      gl = gpuCanvas.getContext('webgl2');
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      facts.webgl = {
        width: gl.drawingBufferWidth,
        height: gl.drawingBufferHeight,
        renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
        disjointTimerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
      };
      check(
        gl.drawingBufferWidth === facts.width && gl.drawingBufferHeight === facts.height,
        'Actual drawing buffer must retain the frozen benchmark extent',
      );
    }
    if (includeComposite) {
      surface = backend.rhi.acquireCanvasContext(gpuCanvas).unwrap();
      surface
        .configure({
          device,
          format: 'rgba8unorm',
          usage: gl ? 0x10 : 0x10 | 0x01,
          alphaMode: 'opaque',
          colorSpace: 'srgb',
        })
        .unwrap();
      compositor = await createUiCompositor({
        device,
        format: 'rgba8unorm',
        source: { kind: 'sparse-strips', shaders: gpuShaders, paint: () => preparedFrame },
        createShaderModule: async (owner, code) =>
          (await backend.createShaderModule(owner, { code })).unwrap(),
      });
      benchmarkHost.showGpuCanvas(gpuCanvas);
      facts.readback = gl
        ? 'Diagnostic readPixels on actual presented canvas; restored GL state, outside timing'
        : 'Same-submission surface copy to map-readable buffer, outside timing';
    } else
      raster = await createGpuUiRaster({
        device,
        shaders: gpuShaders,
        createShaderModule: async (owner, code) =>
          (await backend.createShaderModule(owner, { code })).unwrap(),
      });
    gpu = createGuideProbe(includeComposite ? gpuCanvas : canvas, renderGpu);
    facts.gpuStartup = await gpu.initialize();
    if (cpuReference) {
      cpu = createGuideProbe(canvas, renderCpu);
      facts.cpuStartup = await cpu.initialize();
      try {
        facts.initialStateSync = await waitForStartupState(
          gpu.ui.document,
          cpu.ui.document,
          () => performance.now(),
        );
      } catch (error) {
        facts.initialStateSync = { error: describeBenchmarkError(error) };
        throw error;
      }
    }
    return await capture('guide-idle', 4000);
  },
  async active() {
    const element = gpu.element('move-stick'),
      p = center(element),
      r = element.getBoundingClientRect();
    touchBoth('down', 1, p.x, p.y);
    touchBoth('move', 1, p.x + r.width * 0.255, p.y);
    await pause(0);
    return await capture('guide-joystick-active', 5000);
  },
  async form() {
    const p = center(gpu.element('move-stick'));
    touchBoth('up', 1, p.x, p.y);
    tapBoth('vase-toggle');
    await pause(0);
    return await capture('guide-vase-form', 6000);
  },
  async performance() {
    tapBoth('vase-toggle');
    gpu.paint(7000);
    await flush();
    const element = gpu.element('move-stick'),
      p = center(element),
      r = element.getBoundingClientRect(),
      radius = Math.min(r.width, r.height) * 0.3;
    gpu.pointer('down', 2, p.x, p.y);
    for (let i = 0; i < 8; i++) {
      await raf();
      gpu.pointer('move', 2, p.x + radius * 0.5 * Math.cos(i), p.y + radius * 0.5 * Math.sin(i));
      gpu.paint(8000 + i * 16.667);
    }
    await flush();
    const diagnostic = await observeGl(() => {
      gpu.pointer('move', 2, p.x + radius * 0.7, p.y);
      return gpu.paint(9500);
    });
    facts.dynamicGl = { calls: diagnostic.calls, frame: frameFacts(preparedFrame) };
    await flush();
    const moveBefore = gpu.movementIntents().length,
      before = receipts.length,
      started = performance.now(),
      ticks = [];
    let previous = started;
    for (let i = 0; i < 60; i++) {
      await raf();
      const tick = performance.now();
      ticks.push(tick - previous);
      previous = tick;
      const a = (i * Math.PI * 2) / 60,
        inputStart = performance.now();
      gpu.pointer('move', 2, p.x + radius * 0.85 * Math.cos(a), p.y + radius * 0.85 * Math.sin(a));
      const inputEnd = performance.now();
      const result = gpu.paint(10000 + i * 16.667);
      check(result.rgba, 'every joystick change must produce new GPU UI');
      result.receipt.inputMs = inputEnd - inputStart;
    }
    await flush();
    const elapsed = performance.now() - started,
      frames = receipts.slice(before),
      completionIntervals = [];
    let last = started;
    for (const receipt of frames) {
      check(receipt.completedAt !== null, 'real queue completion required');
      completionIntervals.push(receipt.completedAt - last);
      last = receipt.completedAt;
    }
    const throughput = (frames.length * 1000) / (last - started),
      intervals = stats(completionIntervals),
      callbackIntervals = stats(ticks);
    await pause(0);
    const moves = gpu.movementIntents().slice(moveBefore);
    check(moves.length >= 60, 'real controller must emit all 60 movement intents');
    check(
      moves.some((m) => m.horizontal > 0.8) && moves.some((m) => m.horizontal < -0.8),
      'real joystick must move both ways',
    );
    const result = {
      frames: frames.length,
      movementIntentCount: moves.length,
      elapsedMs: elapsed,
      completedThroughputFps: throughput,
      completionIntervalMs: intervals,
      callbackIntervalMs: callbackIntervals,
      inputMs: stats(frames.map((r) => r.inputMs)),
      paintGpuMs: stats(frames.map((r) => r.paintGpuMs)),
      prepareMs: stats(frames.map((r) => r.prepareMs)),
      encodeMs: stats(frames.map((r) => r.encodeMs)),
      submitCpuMs: stats(frames.map((r) => r.submitCpuMs)),
      submissionToCompletionMs: stats(frames.map((r) => r.completedAt - r.submittedAt)),
      rasterPasses: frames.reduce((n, r) => n + r.passes, 0),
      compositePasses: frames.reduce((n, r) => n + r.compositePasses, 0),
      backgroundClearPasses: frames.reduce((n, r) => n + r.backgroundClearPasses, 0),
      receipts: frames,
      readbacksDuringMeasurement: 0,
      gpuTiming: 'not measured; completion wall includes driver and notification',
      minimumFps: 30,
      maximumP95IntervalMs: 33.34,
      pass:
        frames.length === 60 &&
        throughput >= 30 &&
        intervals.p95 <= 33.34 &&
        callbackIntervals.p95 <= 33.34,
    };
    facts.performance = result;
    gpu.pointer('up', 2, p.x, p.y);
    return result;
  },
  async cachedPerformance() {
    check(compositor !== undefined, 'Cached production composition requires --include-composite');
    gpu.paint(12000);
    await flush();
    const diagnostic = await observeGl(() => gpu.paint(12500));
    check(!diagnostic.value.rgba, 'Cached UI must produce no raster work');
    facts.cachedGl = { calls: diagnostic.calls, frame: null };
    await flush();
    const before = receipts.length,
      started = performance.now(),
      ticks = [];
    let previous = started;
    for (let i = 0; i < 60; i++) {
      await raf();
      const tick = performance.now();
      ticks.push(tick - previous);
      previous = tick;
      const frame = gpu.paint(13000 + i * 16.667);
      check(
        !frame.rgba && frame.receipt.compositePasses === 1,
        'Every cached frame must retain final composition',
      );
    }
    await flush();
    const frames = receipts.slice(before);
    const completionIntervals = frames.map(
      (frame, index) => frame.completedAt - (index ? frames[index - 1].completedAt : started),
    );
    const result = {
      frames: frames.length,
      completedThroughputFps: (frames.length * 1000) / (frames.at(-1).completedAt - started),
      completionIntervalMs: stats(completionIntervals),
      callbackIntervalMs: stats(ticks),
      submissionToCompletionMs: stats(frames.map((r) => r.completedAt - r.submittedAt)),
      paintGpuMs: stats(frames.map((r) => r.paintGpuMs)),
      prepareMs: stats(frames.map((r) => r.prepareMs)),
      encodeMs: stats(frames.map((r) => r.encodeMs)),
      submitCpuMs: stats(frames.map((r) => r.submitCpuMs)),
      rasterPasses: frames.reduce((n, r) => n + r.passes, 0),
      compositePasses: frames.reduce((n, r) => n + r.compositePasses, 0),
      backgroundClearPasses: frames.reduce((n, r) => n + r.backgroundClearPasses, 0),
      readbacksDuringMeasurement: 0,
      receipts: frames,
      gpuTiming: 'not measured; completion wall includes driver and notification',
      pass:
        frames.length === 60 &&
        frames.every((r) => r.completedAt !== null && r.passes === 0 && r.compositePasses === 1),
    };
    facts.cachedPerformance = result;
    return result;
  },
  async backgroundControl() {
    check(compositor !== undefined, 'Background control requires --include-composite');
    const controlFrame = () => {
      const start = performance.now(),
        encoder = device.createCommandEncoder().unwrap();
      clearBackground(encoder);
      const command = encoder.finish().unwrap(),
        encodeEnd = performance.now();
      device.queue.submit([command]).unwrap();
      const submittedAt = performance.now();
      const receipt = {
        encodeMs: encodeEnd - start,
        submitCpuMs: submittedAt - encodeEnd,
        submittedAt,
        completedAt: null,
      };
      pending.push(
        device.queue.onSubmittedWorkDone().then(() => {
          receipt.completedAt = performance.now();
        }),
      );
      return receipt;
    };
    const diagnostic = await observeGl(controlFrame);
    await flush();
    facts.backgroundGl = { calls: diagnostic.calls };
    const frames = [],
      started = performance.now();
    for (let i = 0; i < 60; i++) {
      await raf();
      frames.push(controlFrame());
    }
    await flush();
    const result = {
      scope:
        'Diagnostic surface-clear control with no UI; not a game or UI quality result. Do not subtract asynchronously queued wall latencies as GPU time.',
      frames: frames.length,
      completedThroughputFps: (frames.length * 1000) / (frames.at(-1).completedAt - started),
      encodeMs: stats(frames.map((r) => r.encodeMs)),
      submitCpuMs: stats(frames.map((r) => r.submitCpuMs)),
      submissionToCompletionMs: stats(frames.map((r) => r.completedAt - r.submittedAt)),
      readbacksDuringMeasurement: 0,
      receipts: frames,
      pass: frames.length === 60 && frames.every((r) => r.completedAt !== null),
    };
    facts.backgroundControl = result;
    return result;
  },
  async dispose() {
    try {
      await flush();
      gpu?.dispose();
      cpu?.dispose();
      raster?.dispose();
      compositor?.dispose();
      surface?.unconfigure();
      return facts;
    } finally {
      benchmarkHost.dispose();
    }
  },
};
