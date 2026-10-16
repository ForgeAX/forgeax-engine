import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '../../../apps/shared/src/asset-runtime-config.ts';
import { captureCanvasPixels } from '../../../apps/shared/src/canvas-capture.ts';
import { createApp } from '../../../packages/app/dist/index.mjs';
import { quat } from '../../../packages/math/dist/index.mjs';
import { AssetGuid } from '../../../packages/pack/dist/guid.mjs';
import {
  Camera,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
} from '../../../packages/render/dist/index.mjs';
import { Transform } from '../../../packages/scene/dist/index.mjs';

const canvas = document.querySelector('#app');
const status = document.querySelector('#status');
const errors = [];
const cameraSettings = {
  origin: [-8, 1.6, 0],
  target: [2, 3, 0],
  up: [0, 1, 0],
  verticalFov: 1.05,
};
const query = new URLSearchParams(location.search);
const validationScene = query.get('scene') === 'room' ? 'room' : 'sponza';
if (validationScene === 'room') {
  cameraSettings.origin = [0, 1.6, 4.5];
  cameraSettings.target = [0, 1.5, -1];
}
const baseCameraOrigin = [...cameraSettings.origin];
const size = Number(query.get('resolution') ?? 384);
const timingEnabled = query.get('timings') === '1';
const visibleSurface = query.get('surfaces') === '1';
if (!Number.isInteger(size) || size < 32 || size > 1024)
  throw new Error('Resolution must be 32..1024');
canvas.width = canvas.height = size;
canvas.style.width = `${size}px`;
canvas.style.imageRendering = size < 384 ? 'pixelated' : 'auto';
try {
  const app = (
    await createApp(
      canvas,
      {
        assetRuntimeBinding: runtimeBinding,
        ...(timingEnabled ? { gpuPassTiming: { maxPassesPerFrame: 2048 } } : {}),
        standardProfile: {
          ...DEFAULT_STANDARD_PROFILE,
          renderPath: 'deferred',
          visibleSurface,
          ibl: false,
          ssao: false,
        },
      },
      {
        ...forgeaxBundlerAdapter(),
        importTransport: createRuntimeAssetImportTransport(runtimeBinding),
      },
    )
  ).unwrap();
  app.onError((error) => {
    errors.push(error);
    status.textContent = JSON.stringify(error);
  });
  const { world, assets, renderer } = app;
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const sceneGuid = AssetGuid.parse(
    validationScene === 'room'
      ? '01a0e4fa-a486-7f09-a9f5-33415b3c48b3'
      : '019e4fe2-523b-7506-99e5-ccd39795ecda',
  );
  if (!sceneGuid.ok) throw sceneGuid.error;
  const scene = (await assets.loadByGuid(sceneGuid.value)).unwrap();
  assets.instantiate(world.allocSharedRef('SceneAsset', scene), world).unwrap();
  const light = world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0.45, -1, -0.2],
        color: [1, 0.95, 0.85],
        intensity: 4,
        mapSize: 1024,
        cascadeCount: 4,
        shadowDistance: 36,
        depthBias: 0.00001,
      },
    })
    .unwrap();
  const camera = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: cameraSettings.origin,
          quat: quat.fromLookAt(
            quat.create(),
            cameraSettings.origin,
            cameraSettings.target,
            cameraSettings.up,
          ),
        },
      },
      {
        component: Camera,
        data: {
          fov: cameraSettings.verticalFov,
          aspect: 1,
          near: 0.08,
          far: 120,
          exposure: 1,
        },
      },
    )
    .unwrap();
  app.start().unwrap();
  const settle = async () => {
    const deadline = performance.now() + 120000;
    while (app.execution.report().frame.inFlight > 0) {
      if (performance.now() > deadline) throw new Error('Frame receipt did not settle');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (errors.length) throw errors[0];
  };
  const warm = async () => {
    app.pause().unwrap();
    await settle();
    for (let i = 0; i < 12; i++) {
      app.stepFrame(1 / 60).unwrap();
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const inspect = () => {
    const state = renderer.inspect();
    return {
      camera: cameraSettings,
      validationScene,
      width: canvas.width,
      height: canvas.height,
      errors,
      profile: state.profile,
      diffuseGi: state.diffuseGi,
      passes: state.perFramePassNames,
      shadows: state.directionalShadow,
      light: world.get(light, DirectionalLight).unwrap(),
      scene: state.renderScene,
      recorderEnabled: app.rhiCapture !== undefined,
      observations: state.observation.resourceStats,
      allocation: {
        graph: state.renderGraphResourceAllocation,
        generations: state.renderGraphGenerationAllocation,
      },
    };
  };
  // Measure the ordinary App submission path. GPU pass sums and serial
  // step-to-completion latency are separate facts; neither is presented as FPS.
  const benchmark = async ({ warmup = 30, samples = 60 } = {}) => {
    if (
      !Number.isInteger(warmup) ||
      warmup < 0 ||
      warmup > 120 ||
      !Number.isInteger(samples) ||
      samples < 1 ||
      samples > 300
    ) {
      throw new Error('Benchmark requires 0..120 warmup and 1..300 measured frames');
    }
    app.pause().unwrap();
    await settle();
    const frames = [];
    for (let index = 0; index < warmup + samples; index++) {
      let unsubscribe;
      let timeout;
      const receiptPromise = new Promise((resolve, reject) => {
        unsubscribe = renderer.subscribe((event) => {
          if (event.kind === 'frame-submitted') resolve(event.receipt);
          if (event.kind === 'error') reject(event.error);
        });
      });
      const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Timed frame did not complete')), 30000);
      });
      const started = performance.now();
      try {
        app.stepFrame(1 / 60).unwrap();
        const receipt = await Promise.race([
          receiptPromise.then(async (receipt) => {
            (await receipt.completed).unwrap();
            return receipt;
          }),
          deadline,
        ]);
        const stepToCompletionMs = performance.now() - started;
        const timing = timingEnabled
          ? (
              await Promise.race([renderer.observe(receipt, { include: ['timings'] }), deadline])
            ).unwrap().timings
          : undefined;
        if (
          receipt.presentation !== 'ready' ||
          (timingEnabled && timing?.status !== 'complete' && timing?.status !== 'partial')
        ) {
          throw new Error(
            JSON.stringify({
              reason: 'incomplete timed frame',
              presentation: receipt.presentation,
              timing,
            }),
          );
        }
        if (index >= warmup)
          frames.push({
            stepToCompletionMs,
            timingStatus: timing?.status ?? 'not-requested',
            ...(timing?.status === 'partial' ? { reason: timing.reason } : {}),
            ...(timing === undefined ? {} : { timing: timing.frame }),
          });
      } finally {
        clearTimeout(timeout);
        unsubscribe?.();
      }
    }
    if (errors.length) throw errors[0];
    return {
      status: !timingEnabled
        ? 'not-requested'
        : frames.every((frame) => frame.timingStatus === 'complete')
          ? 'complete'
          : 'partial',
      width: canvas.width,
      height: canvas.height,
      warmup,
      samples,
      frames,
      report: inspect(),
    };
  };
  const encode = (bytes) => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(binary);
  };
  const capture = async (runId, { persist = false, captureTape = true } = {}) => {
    if (captureTape && !app.rhiCapture)
      throw new Error('RHI Debug must be installed for tape capture');
    app.pause().unwrap();
    await settle();
    status.textContent = 'Capturing frame resources';
    if (!renderer.requestObservation) throw new Error('Renderer observation is required');
    const domains = ['linear-hdr', 'final-display', ...(visibleSurface ? ['visible-surface'] : [])];
    renderer.requestObservation(domains).unwrap();
    const receipts = [];
    const unsubscribe = renderer.subscribe((event) => {
      if (event.kind === 'frame-submitted') receipts.push(event.receipt);
    });
    let tape;
    try {
      if (captureTape) {
        tape = (
          await app.rhiCapture.captureFrame({
            byteBudget: 1024 * 1024 * 1024,
            snapshotTimeoutMs: 120000,
          })
        ).unwrap();
      } else {
        app.stepFrame(1 / 60).unwrap();
        await settle();
      }
    } finally {
      unsubscribe();
    }
    status.textContent = 'Reading captured frame observations';
    console.log('capture-stage: frame captured', tape?.bytes.byteLength);
    if (receipts.length !== 1)
      throw new Error(`Expected one captured receipt, received ${receipts.length}`);
    const observed = (await renderer.observe(receipts[0], { include: domains })).unwrap();
    console.log('capture-stage: observations read');
    const observations = observed.observations.map(({ domain, bytes, metadata, records }) => ({
      domain,
      bytes: encode(bytes),
      ...(records === undefined
        ? {}
        : {
            records: encode(new Uint8Array(records.buffer, records.byteOffset, records.byteLength)),
          }),
      metadata,
    }));
    const final = observed.observations.find((item) => item.domain === 'final-display');
    if (!final) throw new Error('Missing raw final-display observation');
    const raw = new Uint8Array(canvas.width * canvas.height * 4);
    for (let y = 0; y < canvas.height; y++) {
      const row = final.bytes.subarray(
        y * final.metadata.bytesPerRow,
        y * final.metadata.bytesPerRow + canvas.width * 4,
      );
      raw.set(row, y * canvas.width * 4);
    }
    if (final.metadata.format.startsWith('bgra')) {
      for (let i = 0; i < raw.length; i += 4) [raw[i], raw[i + 2]] = [raw[i + 2], raw[i]];
    }
    console.log('capture-stage: observations encoded');
    status.textContent = 'Reading the live display';
    const pixels = await captureCanvasPixels(canvas);
    if (!pixels.ok) throw pixels.error;
    status.textContent = 'Saving the frame tape';
    console.log('capture-stage: display read');
    let artifact = tape === undefined ? undefined : { kind: tape.kind, digest: tape.digest };
    if (tape !== undefined && persist) {
      const response = await fetch(`/__forgeax-debug/tape?runId=${encodeURIComponent(runId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-forgeax-rhitape' },
        body: new Blob([tape.bytes], { type: 'application/x-forgeax-rhitape' }),
      });
      console.log('capture-stage: tape upload responded', response.status);
      const stored = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(stored));
      artifact = stored;
    } else if (tape !== undefined) {
      const url = URL.createObjectURL(
        new Blob([tape.bytes], { type: 'application/x-forgeax-rhitape' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `${runId}.rhitape`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    status.textContent = 'Capture saved';
    return {
      artifact,
      pixels: encode(raw),
      canvasPixels: encode(pixels.value),
      observations,
      report: inspect(),
    };
  };
  const set = async ({
    sun = true,
    shadows = true,
    side = 0,
    direction = [0.45, -1, -0.2],
  } = {}) => {
    app.pause().unwrap();
    await settle();
    world
      .set(light, DirectionalLight, { intensity: sun ? 4 : 0, castShadow: shadows, direction })
      .unwrap();
    document.querySelector('#light').checked = sun;
    document.querySelector('#shadows').checked = shadows;
    document.querySelector('#camera').value = String(side);
    cameraSettings.origin = [baseCameraOrigin[0], baseCameraOrigin[1], baseCameraOrigin[2] + side];
    world
      .set(camera, Transform, {
        pos: cameraSettings.origin,
        quat: quat.fromLookAt(
          quat.create(),
          cameraSettings.origin,
          cameraSettings.target,
          cameraSettings.up,
        ),
      })
      .unwrap();
  };
  const update = () =>
    set({
      sun: document.querySelector('#light').checked,
      shadows: document.querySelector('#shadows').checked,
      side: Number(document.querySelector('#camera').value),
    })
      .then(() => app.resume().unwrap())
      .catch(console.error);
  const setDiffuseGi = async (settings) => {
    app.pause().unwrap();
    await settle();
    const { diffuseGi: _previous, ...profile } = renderer.inspect().profile;
    renderer
      .setProfile({
        ...profile,
        ...(settings === undefined ? {} : { diffuseGi: settings }),
      })
      .unwrap();
    const deadline = performance.now() + 180000;
    do {
      app.stepFrame(1 / 60).unwrap();
      await settle();
      const gi = renderer.inspect().diffuseGi;
      if (gi?.state === 'failed') throw new Error(JSON.stringify(gi.error));
      if (settings === undefined || (gi?.state === 'ready' && gi.submittedFrames > 0)) {
        document.querySelector('#mode').textContent =
          `Original Standard materials · ${canvas.width}×${canvas.height} internal pixels · ` +
          (settings === undefined
            ? 'GI disabled'
            : `1 raw sample per frame · ${settings.reconstruction ?? 'raw'} diffuse`);
        status.textContent =
          settings === undefined
            ? 'Raster direct lighting. Diffuse GI disabled.'
            : `Raster direct lighting + diffuse GI (${settings.reconstruction ?? 'raw'}).`;
        return inspect();
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (performance.now() < deadline);
    throw new Error('Ordinary Renderer diffuse GI preparation did not settle');
  };
  for (const id of ['light', 'shadows', 'camera'])
    document.querySelector(`#${id}`).onchange = update;
  const button = document.querySelector('#capture');
  button.disabled = app.rhiCapture === undefined;
  button.onclick = () =>
    capture(`sponza-raster-${Date.now()}`)
      .then((result) => {
        status.textContent = JSON.stringify(result.artifact, null, 2);
      })
      .catch(console.error);
  window.__sponzaRaster = {
    app,
    inspect,
    capture,
    set,
    warm,
    benchmark,
    setDiffuseGi,
    errors,
    dispose: () => app.dispose(),
  };
  status.textContent = `${validationScene} loaded. Raster direct lighting; no Skylight, AO, probes or traced indirect light.`;
} catch (error) {
  window.__sponzaRasterFailure = error.stack ?? JSON.stringify(error);
  errors.push(error);
  status.textContent = error.stack ?? JSON.stringify(error);
  console.error(error);
}
