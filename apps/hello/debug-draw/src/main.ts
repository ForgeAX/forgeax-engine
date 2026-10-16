// hello-debug-draw main entry (feat-20260615-debug-draw M4 / M5)
//
// 6-mode URL router:
//   ?mode=low         - low-path RHI: createDebugDraw + 4 shapes + manual flush (w24)
//   ?mode=empty       - empty frame: no draw calls, control for no-op overlay (w24)
//   ?mode=runtime     - createApp + app.debugDraw.* auto-attach (w32)
//   ?mode=cap-recovery - low-path hard-cap truncation + same-device recovery (M31)
//   ?mode=depth       - two DebugDraw instances (always + less-equal) (w32)
//   ?mode=standard-tonemap - Standard pipeline overlay after tonemap (w32)
//
// Canvas: 256x256 (plan-strategy R-6 lavapipe soft-raster CI control)

import { createDebugDraw } from '@forgeax/engine-debug-draw';
import { Update } from '@forgeax/engine-ecs';
import type { Mat4 } from '@forgeax/engine-math';
import { mat4, vec3 } from '@forgeax/engine-math';
import type { TextureView } from '@forgeax/engine-rhi';
import { createShaderModule, _internal_getRawDevice, rhi } from '@forgeax/engine-rhi-webgpu';
import { Camera, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') ?? 'low';
const falsify = params.get('falsify') === '1';

const canvas = document.getElementById('app') as HTMLCanvasElement | null;
if (!canvas) throw new Error('Canvas #app not found');

// ---------------------------------------------------------------------------
// Common camera helpers
// ---------------------------------------------------------------------------

function buildViewProj(): Mat4 {
  const cameraPos = vec3.create(0, 2, 5);
  const target = vec3.create(0, 0, 0);
  const up = vec3.create(0, 1, 0);
  const view = mat4.lookAt(mat4.create(), cameraPos, target, up);
  const proj = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 4, 1, 0.1, 100);
  const vp = mat4.create();
  mat4.multiply(vp, proj, view);
  return vp;
}

// ---------------------------------------------------------------------------
// low-path: createDebugDraw + 4 shapes + manual flush (w24, already implemented)
// ---------------------------------------------------------------------------

async function runLow(): Promise<void> {
  const adapterResult = await rhi.requestAdapter();
  if (!adapterResult.ok) throw new Error(`requestAdapter failed: ${adapterResult.error.code}`);
  const adapter = adapterResult.value;

  const deviceResult = await adapter.requestDevice({ requiredFeatures: [] });
  if (!deviceResult.ok) throw new Error(`requestDevice failed: ${deviceResult.error.code}`);
  const device = deviceResult.value;

  const fmt = navigator.gpu.getPreferredCanvasFormat();
  const ctx = canvas!.getContext('webgpu');
  if (!ctx) throw new Error('WebGPU not available');

  const rawDevice = _internal_getRawDevice(device)!;
  ctx.configure({ device: rawDevice, format: fmt, alphaMode: 'premultiplied' });

  const ddResult = await createDebugDraw({
    device,
    queue: device.queue,
    createShaderModule,
    format: fmt,
  });
  if (!ddResult.ok) throw new Error(`createDebugDraw failed: ${ddResult.error.code}`);
  const dd = ddResult.value;

  const viewProj = buildViewProj();

  // 4 shapes (identical to w24)
  dd.line(vec3.create(-1.5, -0.7, 0), vec3.create(1.5, -0.7, 0), [1, 0, 0, 1]);
  dd.sphere(vec3.create(0, 0.5, 0), 0.6, [0, 1, 0, 1]);
  dd.aabb(vec3.create(-0.4, -0.4, -0.4), vec3.create(0.4, 0.4, 0.4), [0, 0, 1, 1]);
  // Yellow frustum: independent second virtual camera
  const up = vec3.create(0, 1, 0);
  const fcamPos = vec3.create(0, 1, 2);
  const fcamTarget = vec3.create(0, 0, 0);
  const fcamView = mat4.lookAt(mat4.create(), fcamPos, fcamTarget, up);
  const fcamProj = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.5, 3);
  const fcamViewProj = mat4.multiply(mat4.create(), fcamProj, fcamView);
  dd.frustum(fcamViewProj, [1, 1, 0, 1]);

  const encResult = device.createCommandEncoder();
  if (!encResult.ok) throw new Error(`createCommandEncoder failed: ${encResult.error.code}`);
  const encoder = encResult.value;

  const ctxView = ctx.getCurrentTexture().createView();
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle -> raw WebGPU view
  const flushResult = dd.flush(encoder, ctxView as any, viewProj);
  if (!flushResult.ok) throw new Error(`flush failed: ${flushResult.error.code}`);

  const cbResult = encoder.finish();
  if (!cbResult.ok) throw new Error(`finish failed: ${cbResult.error.code}`);

  const submitResult = device.queue.submit([cbResult.value]);
  if (!submitResult.ok) throw new Error(`submit failed: ${submitResult.error.code}`);

  dd.destroy();
}

// ---------------------------------------------------------------------------
// cap-recovery mode: hard-cap truncation + same-device next-frame recovery
// ---------------------------------------------------------------------------

type CapRecoveryPhase = 'initializing' | 'baseline' | 'overflow' | 'recovery';

async function runCapRecovery(): Promise<void> {
  const adapterResult = await rhi.requestAdapter();
  if (!adapterResult.ok) throw new Error(`requestAdapter failed: ${adapterResult.error.code}`);
  const deviceResult = await adapterResult.value.requestDevice({ requiredFeatures: [] });
  if (!deviceResult.ok) throw new Error(`requestDevice failed: ${deviceResult.error.code}`);
  const device = deviceResult.value;
  const rawDevice = _internal_getRawDevice(device)!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  const ctx = canvas!.getContext('webgpu');
  if (!ctx) throw new Error('WebGPU not available');
  ctx.configure({ device: rawDevice, format, alphaMode: 'premultiplied' });

  const maxVertexCapacity = 10;
  const ddResult = await createDebugDraw({
    device,
    queue: device.queue,
    createShaderModule,
    format,
    initialVertexCapacity: maxVertexCapacity,
    maxVertexCapacity,
  });
  if (!ddResult.ok) throw new Error(`createDebugDraw failed: ${ddResult.error.code}`);
  const dd = ddResult.value;
  const viewProj = buildViewProj();
  let phase: CapRecoveryPhase = 'initializing';
  let deviceErrors = 0;
  let lastQueued = 0;
  rawDevice.addEventListener('uncapturederror', () => {
    deviceErrors++;
  });

  const updateHud = (staged: number, draw: number, cleanup = false, queued = staged): void => {
    document.getElementById('debug-draw-hud')!.textContent =
      `debug-draw: cap-recovery phase=${phase} cap=${maxVertexCapacity} ` +
      `queued=${queued} staged=${staged} draw=${draw} deviceErrors=${deviceErrors} sameDevice=1 ` +
      `cleanup=${cleanup ? 'ok' : 'pending'}`;
  };

  const renderStage = async (nextPhase: Exclude<CapRecoveryPhase, 'initializing'>): Promise<void> => {
    const encResult = device.createCommandEncoder();
    if (!encResult.ok) throw new Error(`createCommandEncoder failed: ${encResult.error.code}`);
    const encoder = encResult.value;
    const view = ctx!.getCurrentTexture().createView();

    encoder.beginRenderPass({
      colorAttachments: [{
        // The low-path demo intentionally obtains the swap-chain view from the
        // browser context; the RHI brand is an opaque compile-time boundary.
        view: view as unknown as TextureView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    }).end();

    if (nextPhase === 'baseline') {
      dd.line(vec3.create(-1.4, -0.55, 0), vec3.create(1.4, -0.55, 0), [1, 0, 0, 1]);
      dd.line(vec3.create(0, -1.1, 0), vec3.create(0, 1.1, 0), [0, 1, 0, 1]);
    } else if (nextPhase === 'overflow') {
      for (let i = 0; i < 5; i++) {
        const y = -0.8 + i * 0.4;
        dd.line(vec3.create(-1.35, y, 0), vec3.create(1.35, y, 0), [1, 0, 0, 1]);
      }
      dd.line(vec3.create(-1.2, -1.1, 0), vec3.create(1.2, -1.1, 0), [1, 1, 0, 1]);
      dd.aabb(vec3.create(-0.3, -0.3, 0), vec3.create(0.3, 0.3, 0), [0, 1, 0, 1]);
    } else {
      dd.line(vec3.create(-1.1, 0.8, 0), vec3.create(1.1, -0.8, 0), [0, 0, 1, 1]);
    }

    const queued = dd._stagingVertexCount;
    lastQueued = queued;
    const flushResult = dd.flush(encoder, view as any, viewProj);
    if (!flushResult.ok) throw new Error(`flush failed: ${flushResult.error.code}`);
    const draw = dd._lastFlushVertexCount;
    const cbResult = encoder.finish();
    if (!cbResult.ok) throw new Error(`finish failed: ${cbResult.error.code}`);
    const submitResult = device.queue.submit([cbResult.value]);
    if (!submitResult.ok) throw new Error(`submit failed: ${submitResult.error.code}`);
    await rawDevice.queue.onSubmittedWorkDone();

    phase = nextPhase;
    updateHud(dd._stagingVertexCount, draw, false, queued);
  };

  const advance = async (): Promise<void> => {
    if (phase === 'baseline') {
      await renderStage('overflow');
      return;
    }
    if (phase === 'overflow') {
      await renderStage('recovery');
      const recoveryDraw = dd._lastFlushVertexCount;
      dd.destroy();
      dd.destroy();
      updateHud(dd._stagingVertexCount, recoveryDraw, true, lastQueued);
      return;
    }
    throw new Error(`cap-recovery cannot advance from phase=${phase}`);
  };
  Object.assign(globalThis as Record<string, unknown>, {
    __forgeax_debug_draw__: { advance },
  });

  await renderStage('baseline');
}

// ---------------------------------------------------------------------------
// empty mode: no shape calls, flush skips GPU pass (w24)
// ---------------------------------------------------------------------------

async function runEmpty(): Promise<void> {
  const adapterResult = await rhi.requestAdapter();
  if (!adapterResult.ok) throw new Error(`requestAdapter failed: ${adapterResult.error.code}`);
  const adapter = adapterResult.value;

  const deviceResult = await adapter.requestDevice({ requiredFeatures: [] });
  if (!deviceResult.ok) throw new Error(`requestDevice failed: ${deviceResult.error.code}`);
  const device = deviceResult.value;

  const fmt = navigator.gpu.getPreferredCanvasFormat();
  const ctx = canvas!.getContext('webgpu');
  if (!ctx) throw new Error('WebGPU not available');

  const rawDevice = _internal_getRawDevice(device)!;
  ctx.configure({ device: rawDevice, format: fmt, alphaMode: 'premultiplied' });

  const ddResult = await createDebugDraw({
    device,
    queue: device.queue,
    createShaderModule,
    format: fmt,
  });
  if (!ddResult.ok) throw new Error(`createDebugDraw failed: ${ddResult.error.code}`);
  const dd = ddResult.value;

  const viewProj = buildViewProj();

  const encResult = device.createCommandEncoder();
  if (!encResult.ok) throw new Error(`createCommandEncoder failed: ${encResult.error.code}`);
  const encoder = encResult.value;

  const ctxView = ctx.getCurrentTexture().createView();
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle -> raw WebGPU view
  const flushResult = dd.flush(encoder, ctxView as any, viewProj);
  if (!flushResult.ok) throw new Error(`empty flush failed: ${flushResult.error.code}`);

  const cbResult = encoder.finish();
  if (!cbResult.ok) throw new Error(`finish failed: ${cbResult.error.code}`);

  const submitResult = device.queue.submit([cbResult.value]);
  if (!submitResult.ok) throw new Error(`submit failed: ${submitResult.error.code}`);

  dd.destroy();
}

// ---------------------------------------------------------------------------
// runtime mode: createApp + app.debugDraw.* auto-attach (w32 / AC-05)
// ---------------------------------------------------------------------------

async function runRuntime(): Promise<void> {
  // Use the canvas-form createApp which auto-creates debug-draw via
  // createDebugDrawOnReady and attaches it to app.debugDraw.
  const { createApp } = await import('@forgeax/engine-app/browser');
  const appResult = await createApp(canvas!, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) throw appResult.error;
  const app = appResult.value;

  if (!app.debugDraw) throw new Error('app.debugDraw missing — debug-draw auto-attach failed');

  const cameraEntity = app.world
    .spawn(
      { component: Transform, data: { pos: [0, 2, 5] } },
      { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: canvas!.width / canvas!.height }) },
    )
    .unwrap();

  const cameraPositions = {
    base: [0, 2, 5],
    pan: [1.25, 2, 5],
  } as const;
  let cameraPan = false;
  let viewportMode: 'base' | 'wide' = 'base';
  let zoomMode: 'base' | 'zoom' = 'base';
  let clipMode: 'base' | 'near' | 'far' = 'base';
  let rollMode: 'base' | 'roll' = 'base';
  const updateHud = (): void => {
    document.getElementById('debug-draw-hud')!.textContent =
      `debug-draw: mode=runtime state=ready (createApp + app.debugDraw) camera=${cameraPan ? 'pan' : 'base'} viewport=${viewportMode} zoom=${zoomMode} clip=${clipMode} roll=${rollMode}`;
  };
  const setCameraPan = (pan: boolean): void => {
    const result = app.world.set(cameraEntity, Transform, { pos: [...(pan ? cameraPositions.pan : cameraPositions.base)] });
    if (!result.ok) {
      console.error(`[debug-draw] camera ${pan ? 'pan' : 'reset'} failed: ${result.error.code}`);
      return;
    }
    cameraPan = pan;
    updateHud();
  };
  const setCameraViewport = (mode: 'base' | 'wide'): void => {
    const result = app.world.set(cameraEntity, Camera, mode === 'wide'
      ? { aspect: 4 / 3, autoAspect: false }
      : { aspect: canvas!.width / canvas!.height, autoAspect: true });
    if (!result.ok) {
      console.error(`[debug-draw] camera viewport ${mode} failed: ${result.error.code}`);
      return;
    }
    viewportMode = mode;
    updateHud();
  };
  const setCameraZoom = (mode: 'base' | 'zoom'): void => {
    const result = app.world.set(cameraEntity, Camera, { fov: mode === 'zoom' ? Math.PI / 8 : Math.PI / 4 });
    if (!result.ok) {
      console.error(`[debug-draw] camera zoom ${mode} failed: ${result.error.code}`);
      return;
    }
    zoomMode = mode;
    updateHud();
  };
  const setCameraClip = (mode: 'base' | 'near' | 'far'): void => {
    const result = app.world.set(cameraEntity, Camera, mode === 'near'
      ? { near: 4.75, far: 100 }
      : mode === 'far'
        ? { near: 0.1, far: 4.75 }
        : { near: 0.1, far: 100 });
    if (!result.ok) {
      console.error(`[debug-draw] camera clip ${mode} failed: ${result.error.code}`);
      return;
    }
    clipMode = mode;
    updateHud();
  };
  const setCameraRoll = (mode: 'base' | 'roll'): void => {
    const halfTurn = Math.PI / 24;
    const result = app.world.set(cameraEntity, Transform, {
      quat: mode === 'roll' ? [0, 0, Math.sin(halfTurn), Math.cos(halfTurn)] : [0, 0, 0, 1],
    });
    if (!result.ok) {
      console.error(`[debug-draw] camera roll ${mode} failed: ${result.error.code}`);
      return;
    }
    rollMode = mode;
    updateHud();
  };
  Object.assign(globalThis as Record<string, unknown>, {
    __forgeax_debug_draw__: { setCameraPan, setCameraViewport, setCameraZoom, setCameraClip, setCameraRoll },
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'p' || event.key === 'P') setCameraPan(true);
    if (event.key === 'r' || event.key === 'R') setCameraPan(false);
  });

  // Register an update callback that draws the four shapes every frame.
  // DebugDraw is immediate-mode: the auto-attached debug-overlay pass flushes
  // the current staging buffer and clears it at the end of each frame.
  const ddRuntime = app.debugDraw;
  app.world
    .addSystem(Update, {
      name: 'debug-draw-runtime-shapes',
      queries: [],
      fn: () => {
        if (falsify) return;
        ddRuntime.line(vec3.create(-1.5, -0.7, 0), vec3.create(1.5, -0.7, 0), [1, 0, 0, 1]);
        ddRuntime.sphere(vec3.create(0, 0.5, 0), 0.6, [0, 1, 0, 1]);
        ddRuntime.aabb(vec3.create(-0.4, -0.4, -0.4), vec3.create(0.4, 0.4, 0.4), [0, 0, 1, 1]);
        const up = vec3.create(0, 1, 0);
        const fcamPos = vec3.create(0, 1, 2);
        const fcamTarget = vec3.create(0, 0, 0);
        const fcamView = mat4.lookAt(mat4.create(), fcamPos, fcamTarget, up);
        const fcamProj = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.5, 3);
        const fcamViewProj = mat4.multiply(mat4.create(), fcamProj, fcamView);
        ddRuntime.frustum(fcamViewProj, [1, 1, 0, 1]);
      },
    })
    .unwrap();

  app.start();
  setCameraPan(false);
  setCameraViewport('base');
  setCameraZoom('base');
  setCameraClip('base');
  setCameraRoll('base');
  // Keep the canvas loop alive: the browser front door observes the live
  // overlay, and the page owns teardown when it is closed.
}

// ---------------------------------------------------------------------------
// depth mode: two DebugDraw instances (always + less-equal), w32 / AC-06
//
// Visual contract:
//   always  — all 4 shapes visible on black background (depth ignored)
//   less-equal — logical distance comparison; native Reverse-Z depth clears
//     to 0.0 and uses greater-equal, so all in-range shapes pass.
//     Shape positions offset from always-mode for visual distinction.
//     Genuine z-occlusion requires a prior depth-write pass.
// ---------------------------------------------------------------------------

let _depthTex: GPUTexture | undefined;

async function runDepth(): Promise<void> {
  const adapterResult = await rhi.requestAdapter();
  if (!adapterResult.ok) throw new Error(`requestAdapter failed: ${adapterResult.error.code}`);
  const adapter = adapterResult.value;

  const deviceResult = await adapter.requestDevice({ requiredFeatures: [] });
  if (!deviceResult.ok) throw new Error(`requestDevice failed: ${deviceResult.error.code}`);
  const device = deviceResult.value;

  const fmt = navigator.gpu.getPreferredCanvasFormat();
  const ctx = canvas!.getContext('webgpu');
  if (!ctx) throw new Error('WebGPU not available');

  const rawDevice = _internal_getRawDevice(device)!;
  ctx.configure({ device: rawDevice, format: fmt, alphaMode: 'premultiplied' });

  // Shared depth texture (reused across both modes)
  _depthTex = rawDevice.createTexture({
    size: { width: canvas!.width, height: canvas!.height, depthOrArrayLayers: 1 },
    format: 'depth24plus' as GPUTextureFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  // Two DebugDraw instances: always (draws on top of everything) and
  // less-equal (respects depth buffer).
  const ddAlwaysResult = await createDebugDraw({
    device,
    queue: device.queue,
    createShaderModule,
    format: fmt,
    depthMode: 'always',
  });
  if (!ddAlwaysResult.ok) throw new Error(`createDebugDraw always failed: ${ddAlwaysResult.error.code}`);
  const ddAlways = ddAlwaysResult.value;

  const ddLessEqualResult = await createDebugDraw({
    device,
    queue: device.queue,
    createShaderModule,
    format: fmt,
    depthFormat: 'depth24plus',
    depthMode: 'less-equal',
  });
  if (!ddLessEqualResult.ok) throw new Error(`createDebugDraw less-equal failed: ${ddLessEqualResult.error.code}`);
  const ddLessEqual = ddLessEqualResult.value;

  // Wire the depth view into the less-equal instance so flush() includes
  // the depth-stencil attachment with loadOp='load'.
  // biome-ignore lint/suspicious/noExplicitAny: raw GPUTextureView -> opaque RHI TextureView
      ddLessEqual._setDepthView(_depthTex.createView() as any);

  const up = vec3.create(0, 1, 0);
  const fcamPos = vec3.create(0, 1, 2);
  const fcamTarget = vec3.create(0, 0, 0);

  // === always-mode shapes (visible on plain black background) ============
  const viewProj = buildViewProj();
  ddAlways.line(vec3.create(-1.5, 0, -0.5), vec3.create(1.5, 0, 0.5), [1, 0, 0, 1]);
  ddAlways.sphere(vec3.create(0, 0, 0), 0.5, [0, 1, 0, 1]);
  ddAlways.aabb(vec3.create(-0.4, -0.4, -0.4), vec3.create(0.4, 0.4, 0.4), [0, 0, 1, 1]);
  const fcamViewA = mat4.lookAt(mat4.create(), fcamPos, fcamTarget, up);
  const fcamProjA = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.5, 3);
  ddAlways.frustum(mat4.multiply(mat4.create(), fcamProjA, fcamViewA), [1, 1, 0, 1]);

  // === less-equal mode shapes (offset positions for visual distinction) ===
  // Depth cleared to 0.0 (far plane); all shapes pass the nearer comparison.
  // Shape positions differ from always-mode to produce visually distinct PNGs.
  ddLessEqual.line(vec3.create(-1.5, 0.2, -0.5), vec3.create(1.5, 0.2, 0.5), [1, 0, 0, 1]);
  ddLessEqual.sphere(vec3.create(0, -0.2, 0), 0.5, [0, 1, 0, 1]);
  ddLessEqual.aabb(vec3.create(-0.4, -0.4, 0.6), vec3.create(0.4, 0.4, 1.4), [0, 0, 1, 1]);
  const fcamViewL = mat4.lookAt(mat4.create(), fcamPos, fcamTarget, up);
  const fcamProjL = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.5, 3);
  ddLessEqual.frustum(mat4.multiply(mat4.create(), fcamProjL, fcamViewL), [1, 1, 0, 1]);

  // Render always-mode (PNG 1) — no depth, flat overlay on black
  {
    const encResult = device.createCommandEncoder();
    if (!encResult.ok) throw new Error(`createCommandEncoder failed: ${encResult.error.code}`);
    const encoder = encResult.value;

    const ctxView = ctx.getCurrentTexture().createView();
    encoder.beginRenderPass({
      colorAttachments: [{
        view: ctxView as unknown as TextureView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    }).end();

    const flushResult = ddAlways.flush(
      // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
      encoder, ctxView as any, viewProj,
    );
    if (!flushResult.ok) throw new Error(`always flush failed: ${flushResult.error.code}`);

    const cbResult = encoder.finish();
    if (!cbResult.ok) throw new Error(`finish failed: ${cbResult.error.code}`);
    device.queue.submit([cbResult.value]);
    await rawDevice.queue.onSubmittedWorkDone();
  }

  // Render less-equal mode (PNG 2) — depth cleared to 0.5, overlay with occlusion
  {
    const encResult = device.createCommandEncoder();
    if (!encResult.ok) throw new Error(`createCommandEncoder failed: ${encResult.error.code}`);
    const encoder = encResult.value;

    const ctxView = ctx.getCurrentTexture().createView();
    // Pre-clear color (black) + depth (far plane) so the less-equal flush loads both.
    encoder.beginRenderPass({
      colorAttachments: [{
        view: ctxView as unknown as TextureView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
      depthStencilAttachment: {
        view: _depthTex.createView() as unknown as TextureView,
        depthClearValue: 0.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    }).end();

    const flushResult = ddLessEqual.flush(
      // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
      encoder, ctxView as any, viewProj,
    );
    if (!flushResult.ok) throw new Error(`less-equal flush failed: ${flushResult.error.code}`);

    const cbResult = encoder.finish();
    if (!cbResult.ok) throw new Error(`finish failed: ${cbResult.error.code}`);
    device.queue.submit([cbResult.value]);
    await rawDevice.queue.onSubmittedWorkDone();
  }

  ddAlways.destroy();
  ddLessEqual.destroy();
  _depthTex.destroy();
  _depthTex = undefined;
}

// ---------------------------------------------------------------------------
// standard-tonemap mode: Standard pipeline overlay after tonemap (w32 / AC-07)
// ---------------------------------------------------------------------------

async function runStandardTonemap(): Promise<void> {
  const { createApp } = await import('@forgeax/engine-app/browser');

  const appResult = await createApp(canvas!);
  if (!appResult.ok) throw appResult.error;
  const app = appResult.value;

  if (!app.debugDraw) throw new Error('app.debugDraw missing');

  // Draw 4 shapes (same as low-mode) via app.debugDraw. The overlay renders
  // after tonemap, so the red channel of red-colored primitives should be
  // >= 0.85 (AC-07).
  const debugDraw = app.debugDraw;
  let drawn = false;
  app.world
    .addSystem(Update, {
      name: 'debug-draw-standard-shapes',
      queries: [],
      fn: () => {
        if (drawn) return;
        drawn = true;
        debugDraw.line(vec3.create(-1.5, -0.7, 0), vec3.create(1.5, -0.7, 0), [1, 0, 0, 1]);
        debugDraw.sphere(vec3.create(0, 0.5, 0), 0.6, [0, 1, 0, 1]);
        debugDraw.aabb(vec3.create(-0.4, -0.4, -0.4), vec3.create(0.4, 0.4, 0.4), [0, 0, 1, 1]);
        const upH = vec3.create(0, 1, 0);
        const fcamPosH = vec3.create(0, 1, 2);
        const fcamTargetH = vec3.create(0, 0, 0);
        const fcamViewH = mat4.lookAt(mat4.create(), fcamPosH, fcamTargetH, upH);
        const fcamProjH = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.5, 3);
        const fcamViewProjH = mat4.multiply(mat4.create(), fcamProjH, fcamViewH);
        debugDraw.frustum(fcamViewProjH, [1, 1, 0, 1]);
      },
    })
    .unwrap();

  app.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  app.stop();
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  switch (mode) {
    case 'low':
      document.getElementById('debug-draw-hud')!.textContent = 'debug-draw: low-path (RHI manual flush)';
      await runLow();
      break;
    case 'empty':
      document.getElementById('debug-draw-hud')!.textContent = 'debug-draw: empty (no shape, no-op flush)';
      await runEmpty();
      break;
    case 'runtime':
      document.getElementById('debug-draw-hud')!.textContent =
        'debug-draw: mode=runtime state=initializing (createApp + app.debugDraw)';
      await runRuntime();
      break;
    case 'cap-recovery':
      await runCapRecovery();
      break;
    case 'depth':
      document.getElementById('debug-draw-hud')!.textContent = 'debug-draw: depth (always vs less-equal)';
      await runDepth();
      break;
    case 'standard-tonemap':
      document.getElementById('debug-draw-hud')!.textContent = 'debug-draw: standard-tonemap (overlay after tonemap)';
      await runStandardTonemap();
      break;
    default:
      document.getElementById('debug-draw-hud')!.textContent = `unknown mode: ${mode}`;
  }
}

main().catch((err: unknown) => {
  const hud = document.getElementById('debug-draw-hud');
  if (hud) hud.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
