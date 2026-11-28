import type { EntityHandle } from '@forgeax/engine-ecs';
import { encodePng } from '@forgeax/engine-image/png';
import { halfFloat } from '@forgeax/engine-math';
import type { Renderer } from '@forgeax/engine-render';
import {
  ANTIALIAS_TAA,
  ANTIALIAS_TSR,
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  BLOOM_QUALITY_LOW,
  BLOOM_QUALITY_MEDIUM,
  CAMERA_EXPOSURE_MODE_AUTO_UE,
  CAMERA_EXPOSURE_MODE_MANUAL,
  Camera,
  CameraView,
  DynamicResolution,
  LensFlare,
} from '@forgeax/engine-render';
import type { RecorderAttachment } from '@forgeax/engine-rhi-debug';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
  summarizeFrame,
  summarizePasses,
  tapeDigest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { checkPixels, createDisplayP3Scene } from './display-p3.fixture';

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error), { cause: result.error });
  return result.value;
}
type EvidenceWriter = (name: string, bytes: Uint8Array | string) => Promise<void>;
const preview = (rgba: Uint8Array) => encodePng(64, 64, rgba);

function verifySeededTsrHistory(
  model: ReturnType<typeof buildFrameModel>,
  tape: ReturnType<ReturnType<typeof decodeTape>['unwrap']>,
): void {
  const retained = model.resources.filter(
    (r) =>
      r.kind === 'texture' && /tsr-(?:history|guide|moire)-/.test(JSON.stringify(r.descriptor)),
  );
  expect(retained).toHaveLength(10);
  for (const resource of retained) {
    expect(model.unseededResources.some((r) => r.resourceId === resource.resourceId)).toBe(false);
    expect(
      tape.bootstrap
        .find((r) => r.handleId === resource.resourceId)
        ?.initialData.some((b) => b.byteLength > 0),
    ).toBe(true);
  }
}

/** Both physical carriers execute exactly the same lifecycle and replay oracle. */
// 40 bytes of color, temporal and stability history plus two FP16 Guides, two FP16 Moire
// histories and two persistent resurrection snapshots (FP16 guide + FP16 color + RGBA8 stability).
const TSR_HISTORY_BYTES = 40 + 2 * (8 + 8) + 2 * (8 + 8 + 4);

function expectedTsrEntries(raster: boolean): readonly string[] {
  if (raster) {
    return [
      'tsr_measure_opaque',
      'tsr_dilate',
      'tsr_analyze',
      'tsr_resurrect_guide',
      'tsr_moire_clamp',
      'tsr_moire_measure',
      'tsr_moire_update',
      'tsr_moire_history',
      'tsr_clamp',
      'tsr_measure',
      'tsr_clamp',
      'tsr_resurrect_measure',
      'tsr_reject',
      'tsr_spatial',
      'tsr_reconstruct',
    ].map((entry) => `${entry}_fragment`);
  }
  return [
    'tsr_measure_opaque',
    'tsr_dilate',
    'tsr_analyze',
    'tsr_resurrect_guide',
    'tsr_moire',
    'tsr_reject_fused',
    'tsr_spatial',
    'tsr_reconstruct',
  ];
}

export async function verifyTsrRenderer(
  canvas: { width: number; height: number },
  shaderManifestUrl?: string,
  save?: EvidenceWriter,
  renderPath: 'forward' | 'deferred' = 'forward',
  backend: Parameters<typeof attachRecorder>[0] = webgpu,
  replayCanvas?: Parameters<typeof backend.rhi.requestAdapter>[1],
) {
  const recorder = attachRecorder(backend).unwrap();
  const errors: unknown[] = [];
  const host = value(
    await constructRuntimeRendererHost(
      canvas,
      {
        rhi: recorder.backend.rhi,
        rhiInstrumentation: {
          resolveSurfaceDevice: (device) =>
            ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
        },
      },
      shaderManifestUrl === undefined ? {} : { shaderManifestUrl },
    ),
  );
  value(await host.initialization);
  const renderer = host.renderer;
  value(renderer.setProfile({ ...renderer.inspect().profile, renderPath }));
  const scene = createDisplayP3Scene(renderer, errors);
  const camera = [...scene.world.query({ with: [Camera] }).unwrap()][0]?.entity;
  if (camera === undefined) throw new Error('missing camera');
  scene.world.set(camera, Camera, { antialias: ANTIALIAS_TSR }).unwrap();
  scene.world
    .addComponent(camera, { component: DynamicResolution, data: { minScale: 0.5, maxScale: 0.5 } })
    .unwrap();
  const verifyDisocclusion = async () => {
    // Disocclusion must remove old radiance immediately, even after settling.
    const mesh = scene.meshes[0];
    if (mesh === undefined) throw new Error('missing moving surface');
    scene.world.set(mesh, Transform, { pos: [5, 5, 0] }).unwrap();
    const uncoveredAlpha = 0.37;
    scene.world.set(camera, Camera, { clearColor: [0, 0, 0, uncoveredAlpha] }).unwrap();
    const uncoveredPending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const uncovered = await scene.readFinal();
    (await recorder.frameBoundary()).unwrap();
    const uncoveredArtifact = (await uncoveredPending).unwrap();
    const uncoveredModel = buildFrameModel(decodeTape(uncoveredArtifact.bytes).unwrap());
    if (save) {
      await save(`uncovered.rhitape`, uncoveredArtifact.bytes);
      await save(`uncovered-live.png`, preview(uncovered.rgba));
      await save(`uncovered-model.json`, JSON.stringify({ mesh, model: uncoveredModel }, null, 2));
    }

    const uncoveredPixel = (16 * 64 + 16) * 4;
    const alphaByte = Math.round(uncoveredAlpha * 255);
    expect([...uncovered.rgba.slice(uncoveredPixel, uncoveredPixel + 4)]).toEqual([
      0,
      0,
      0,
      alphaByte,
    ]);
    const history = uncoveredModel.resources.find(
      (r) => r.kind === 'texture' && /tsr-history-color-[ab]/.test(JSON.stringify(r.descriptor)),
    );
    expect(history?.descriptor).toMatchObject({ desc: { format: 'rgba16float' } });
    scene.world.set(camera, Camera, { clearColor: [0, 0, 0, 1] }).unwrap();
    scene.world.set(mesh, Transform, { pos: [-1, 1, 0] }).unwrap();
    await scene.drawReady();
  };
  try {
    const startup = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    try {
      await scene.drawReady();
    } catch (error) {
      if (save)
        await save(
          'startup-failure.json',
          JSON.stringify(
            {
              error: String(error),
              errors,
              inspection: renderer.inspect(),
            },
            null,
            2,
          ),
        );
      throw error;
    } finally {
      (await recorder.frameBoundary()).unwrap();
      const artifact = (await startup).unwrap();
      if (save) await save('startup.rhitape', artifact.bytes);
    }
    for (let i = 1; i < 60; i++) await scene.drawReady();
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const live = await scene.readFinal();
    (await recorder.frameBoundary()).unwrap();
    const artifact = (await pending).unwrap();
    const tape = decodeTape(artifact.bytes).unwrap();
    const model = buildFrameModel(tape);
    if (save) {
      await save(`stable.rhitape`, artifact.bytes);
      await save(`stable-model.json`, JSON.stringify(model, null, 2));
      await save(`stable-live.png`, preview(live.rgba));
    }
    const tsr = model.works.filter((w) =>
      w.pipeline.shaders.some((s) => s.entryPoint?.startsWith('tsr_')),
    );
    const { compute, storageTexture } = renderer.inspect().capabilities;
    const raster = !compute || !storageTexture;
    expect(
      tsr.map((w) => w.pipeline.shaders.find((s) => s.entryPoint !== 'tsr_fullscreen')?.entryPoint),
    ).toEqual(expectedTsrEntries(raster));
    if (raster) expect(model.works.some((work) => work.kind === 'dispatchWorkgroups')).toBe(false);
    verifySeededTsrHistory(model, tape);
    expect(checkPixels(live.rgba, 'srgb').every((c) => c.error <= 3)).toBe(true);
    const temporal = renderer.inspect().temporal;
    expect(temporal.mode).toBe('tsr');
    expect(temporal.historyValid).toBe(true);
    expect(temporal.coverage).toEqual({ width: 64, height: 64 });
    await verifyTsrReplay({
      tape,
      bytes: artifact.bytes,
      model,
      tsr,
      raster,
      live,
      temporal,
      backend,
      replayCanvas,
      save,
    });
    await verifyDisocclusion();
    // Fixed-input changes retain a valid color owner while rebuilding Guide capacity.
    scene.world.set(camera, DynamicResolution, { minScale: 0.75, maxScale: 0.75 }).unwrap();
    await scene.drawReady();
    expect(renderer.inspect().dynamicResolution?.extent?.internalWidth).toBe(48);
    expect(renderer.inspect().temporal.historyValid).toBe(true);
    scene.world.removeComponent(camera, DynamicResolution).unwrap();
    await scene.drawReady();
    expect(renderer.inspect().temporal.resources.activeBytes).toBe(TSR_HISTORY_BYTES * 64 * 64);
    scene.world.set(camera, Camera, { antialias: ANTIALIAS_TAA }).unwrap();
    await scene.drawReady();
    expect(renderer.inspect().temporal.mode).toBe('taa');
    // TAA keeps the 34-byte temporal history plus its 8-byte flickering history pair.
    expect(renderer.inspect().temporal.resources.activeBytes).toBe((34 + 8) * 64 * 64);
    const offPending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await scene.readFinal();
    (await recorder.frameBoundary()).unwrap();
    const offArtifact = (await offPending).unwrap();
    const offModel = buildFrameModel(decodeTape(offArtifact.bytes).unwrap());
    expect(
      offModel.works.some((w) =>
        w.pipeline.shaders.some((shader) => shader.entryPoint?.startsWith('tsr_')),
      ),
    ).toBe(false);
    if (save) await save(`taa-control.rhitape`, offArtifact.bytes);

    scene.world.set(camera, Camera, { antialias: ANTIALIAS_TSR }).unwrap();
    await scene.drawReady();
    expect(renderer.inspect().temporal.mode).toBe('tsr');
    const originalSize = [canvas.width, canvas.height] as const;
    canvas.width += 1;
    canvas.height += 1;
    // A second journey enables two consumers of the same post-TSR image.
    // Portable TSR writes its usual MRTs and the graph supplies a raster downsample.
    scene.world
      .set(camera, Camera, {
        bloom: BLOOM_ENABLED,
        bloomIntensity: 0.5,
        exposureMode: CAMERA_EXPOSURE_MODE_AUTO_UE,
      })
      .unwrap();
    for (let frame = 0; frame < 4; frame++) await scene.drawReady();
    const postPending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const post = await scene.readFinal();
    (await recorder.frameBoundary()).unwrap();
    const postBytes = (await postPending).unwrap().bytes;
    const postTape = decodeTape(postBytes).unwrap();
    const postModel = buildFrameModel(postTape);
    const postInspection = renderer.inspect().output;
    expect(postInspection.autoExposure?.receipt.committed).toBe(true);
    expect(postInspection.graphPassNames.includes('post-scene-color-half')).toBe(raster);
    expect(
      postModel.works.flatMap(({ pipeline }) =>
        pipeline.shaders.map(({ entryPoint }) => entryPoint),
      ),
    ).toContain(raster ? 'auto_exposure_classify_half' : 'auto_exposure_histogram_half');
    await verifyPostDownsampleReplay(
      postTape,
      postModel,
      backend,
      replayCanvas,
      raster,
      canvas.width,
      canvas.height,
      () => save?.('shared-exposure-bloom-failure.rhitape', postBytes),
    );
    expect(post.rgba.some((value, index) => index % 4 !== 3 && value > 0)).toBe(true);
    expect(post.rgba.some((value, index) => index % 4 !== 3 && value !== live.rgba[index])).toBe(
      true,
    );
    if (save) await save('shared-exposure-bloom.png', preview(post.rgba));
    for (const quality of [BLOOM_QUALITY_LOW, BLOOM_QUALITY_MEDIUM]) {
      scene.world.set(camera, Camera, { bloomQuality: quality }).unwrap();
      await scene.drawReady();
      expect(renderer.inspect().bloom).toMatchObject({
        graphStatus: 'valid',
        levelCount: quality,
        passCount: raster ? 3 * quality : 2 * quality + 1,
      });
    }
    scene.world.set(camera, Camera, { bloom: BLOOM_DISABLED }).unwrap();
    scene.world.addComponent(camera, { component: LensFlare, data: { threshold: 0.01 } }).unwrap();
    await scene.drawReady();
    const flarePending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await scene.drawReady();
    (await recorder.frameBoundary()).unwrap();
    const flareModel = buildFrameModel(decodeTape((await flarePending).unwrap().bytes).unwrap());
    const flarePass = summarizePasses(flareModel).find(
      ({ label }) => label === 'standard-lens-flare-prefilter',
    );
    expect(flarePass?.workCounts.draw).toBe(1);
    const flareWork = flareModel.works.find(({ passIndex }) => passIndex === flarePass?.passIndex);
    const flareSource = flareWork?.bindings.find(
      ({ groupIndex, binding }) => groupIndex === 1 && binding === 0,
    )?.resourceId;
    // The flare threshold consumes the already reduced HDR source.
    const halfPass = summarizePasses(flareModel).find(
      ({ label }) => label === 'post-scene-color-half' || label === 'post-scene-color-half-lens',
    );
    const halfDraw = flareModel.works.find(({ passIndex }) => passIndex === halfPass?.passIndex);
    const fusedHalf = flareModel.works
      .find(({ pipeline }) =>
        pipeline.shaders.some(({ entryPoint }) => entryPoint === 'tsr_reconstruct'),
      )
      ?.bindings.find(({ groupIndex, binding }) => groupIndex === 0 && binding === 17);
    expect(flareSource).toBeDefined();
    expect(flareSource).toBe(halfDraw?.attachments?.colorViewHandleIds[0] ?? fusedHalf?.resourceId);
    scene.world.removeComponent(camera, LensFlare).unwrap();
    scene.world.set(camera, Camera, { exposureMode: CAMERA_EXPOSURE_MODE_MANUAL }).unwrap();
    await scene.drawReady();
    [canvas.width, canvas.height] = originalSize;
    await scene.drawReady();
    await verifyTsrViews(
      scene,
      renderer,
      recorder,
      camera,
      save,
      raster ? 'tsr_reconstruct_fragment' : 'tsr_reconstruct',
    );
    expect(errors).toEqual([]);
  } catch (error) {
    if (save)
      await save(
        'runtime-failure.json',
        JSON.stringify(
          {
            error: String(error),
            errors,
            inspection: renderer.inspect(),
          },
          null,
          2,
        ),
      );
    throw error;
  } finally {
    scene.dispose();
    value(await renderer.dispose());
    (await recorder.dispose()).unwrap();
  }
}

async function verifyTsrViews(
  scene: ReturnType<typeof createDisplayP3Scene>,
  renderer: Renderer,
  recorder: RecorderAttachment,
  camera: EntityHandle,
  save?: EvidenceWriter,
  reconstructEntry = 'tsr_reconstruct',
) {
  // One submission carries independent views: first TSR+TAA, then two TSRs.
  scene.world
    .addComponent(camera, { component: CameraView, data: { viewport: [0, 0, 0.5, 1], order: 0 } })
    .unwrap();
  const second = scene.world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 10] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -2,
          right: 2,
          top: 2,
          bottom: -2,
          near: 0.1,
          far: 100,
          antialias: ANTIALIAS_TAA,
          tonemap: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
      { component: CameraView, data: { viewport: [0.5, 0, 0.5, 1], order: 1 } },
    )
    .unwrap();
  const startup = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  try {
    await scene.drawReady();
  } finally {
    (await recorder.frameBoundary()).unwrap();
    const artifact = (await startup).unwrap();
    if (save) await save('mixed-startup.rhitape', artifact.bytes);
  }
  for (let i = 1; i < 60; i++) await scene.drawReady();
  const mixed = renderer.inspect().views;
  expect(mixed?.map((v) => v.temporal.mode)).toEqual(['tsr', 'taa']);
  expect(mixed?.every((v) => v.temporal.historyValid)).toBe(true);
  expect(new Set(mixed?.map((v) => v.temporal.viewIdentity)).size).toBe(2);
  scene.world.set(second, Camera, { antialias: ANTIALIAS_TSR }).unwrap();
  for (let i = 0; i < 60; i++) await scene.drawReady();
  const views = renderer.inspect().views;
  expect(views?.map((v) => v.temporal.mode)).toEqual(['tsr', 'tsr']);
  expect(
    views?.every((v) => v.temporal.resources.activeBytes === (TSR_HISTORY_BYTES / 2) * 64 * 64),
  ).toBe(true);
  const multiPending = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  const multiLive = await scene.readFinal();
  (await recorder.frameBoundary()).unwrap();
  const multiArtifact = (await multiPending).unwrap();
  const multiModel = buildFrameModel(decodeTape(multiArtifact.bytes).unwrap());
  expect(
    multiModel.works.filter((w) =>
      w.pipeline.shaders.some((s) => s.entryPoint === reconstructEntry),
    ),
  ).toHaveLength(2);
  const multiHistories = multiModel.resources.filter(
    (r) =>
      r.kind === 'texture' && /tsr-(?:history|guide|moire)-/.test(JSON.stringify(r.descriptor)),
  );
  expect(multiHistories).toHaveLength(20);
  expect(new Set(multiHistories.map((r) => r.resourceId)).size).toBe(20);
  for (const resource of multiHistories)
    expect(multiModel.unseededResources.some((r) => r.resourceId === resource.resourceId)).toBe(
      false,
    );
  for (let lane = 0; lane < 3; lane++) {
    const left = multiLive.rgba[(16 * 64 + 8) * 4 + lane] ?? NaN;
    const right = multiLive.rgba[(16 * 64 + 40) * 4 + lane] ?? NaN;
    expect(left).toBeGreaterThan(120);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(3);
  }
  if (save) {
    await save('multi.rhitape', multiArtifact.bytes);
    await save('multi-live.png', preview(multiLive.rgba));
    await save('multi-model.json', JSON.stringify(multiModel, null, 2));
  }
  // Interleaved ordinary frames must not discard the retained observation graph.
  const observed = await scene.drawReady(['final-display']);
  expect(observed.graphGeneration).toBeTypeOf('number');
  for (let i = 0; i < 3; i++) await scene.drawReady();
  const observedAgain = await scene.drawReady(['final-display']);
  expect(observedAgain.graphGeneration).toBe(observed.graphGeneration);
  // Switching one resolver cannot invalidate the sibling's accepted history.
  scene.world.set(camera, Camera, { antialias: ANTIALIAS_TAA }).unwrap();
  await scene.drawReady();
  const switched = renderer.inspect().views;
  expect(switched?.map((v) => v.temporal.mode)).toEqual(['taa', 'tsr']);
  expect(switched?.[1]?.temporal.frameIndex).toBeGreaterThan(
    views?.[1]?.temporal.frameIndex ?? Infinity,
  );
}

async function verifyPostDownsampleReplay(
  tape: Parameters<typeof openReplay>[0],
  model: ReturnType<typeof buildFrameModel>,
  backend: Parameters<typeof attachRecorder>[0],
  replayCanvas: Parameters<typeof backend.rhi.requestAdapter>[1],
  raster: boolean,
  width: number,
  height: number,
  saveFailure: () => Promise<void> | undefined,
) {
  const adapter = (await backend.rhi.requestAdapter({}, replayCanvas)).unwrap();
  const device = (
    await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
  ).unwrap();
  const replay = (
    await openReplay(tape, { device, createShaderModule: backend.createShaderModule })
  ).unwrap();
  try {
    const reconstruct = model.works.find(({ pipeline }) =>
      pipeline.shaders.some(
        ({ entryPoint }) =>
          entryPoint === (raster ? 'tsr_reconstruct_fragment' : 'tsr_reconstruct'),
      ),
    );
    if (!reconstruct) throw new Error('missing captured TSR reconstruction');
    const result = (await replay.inspectWork(reconstruct.workIndex, ['outputs'])).unwrap();
    const full = result.outputs
      ?.find(({ name }) => name === (raster ? 'color0' : '@group(0)@binding(14)'))
      ?.result.unwrap();
    const halfPass = raster
      ? summarizePasses(model).find(({ label }) => label === 'post-scene-color-half')
      : undefined;
    const filtered =
      halfPass === undefined
        ? undefined
        : model.works.find(({ passIndex }) => passIndex === halfPass.passIndex);
    const half =
      filtered === undefined
        ? result.outputs?.find(({ name }) => name === '@group(0)@binding(17)')?.result.unwrap()
        : (await replay.inspectWork(filtered.workIndex, ['pixels'])).unwrap().attachment;
    expect(full?.width).toBe(width);
    expect(full?.height).toBe(height);
    verifyBoxReduction(full, half, 'post-scene-color-half');
    const passes = summarizePasses(model);
    let prior = half;
    for (let level = 1; level <= 4; level++) {
      const label = raster ? `bloom-downsample-${level}` : 'bloom-downsample';
      const pass = passes.find((entry) => entry.label === label);
      const work = model.works.find(({ passIndex }) => passIndex === pass?.passIndex);
      if (!work) throw new Error(`missing captured ${label}`);
      const reduced = (await replay.inspectWork(work.workIndex, ['outputs'])).unwrap();
      const target = reduced.outputs
        ?.find(({ name }) => name === (raster ? 'color0' : `@group(0)@binding(${level})`))
        ?.result.unwrap();
      verifyBoxReduction(prior, target, `bloom-downsample-${level}`);
      prior = target;
    }
  } catch (error) {
    await saveFailure();
    throw error;
  } finally {
    (await replay.dispose()).unwrap();
  }
}

function verifyBoxReduction(
  full: ReplayReadbackResult | undefined,
  half: ReplayReadbackResult | undefined,
  label: string,
) {
  if (!full || !half || !full.width || !full.height || !half.width || !half.height)
    throw new Error('missing post-processing HDR readback');
  expect(half.width).toBe(Math.ceil(full.width / 2));
  expect(half.height).toBe(Math.ceil(full.height / 2));
  const from = new DataView(full.bytes.buffer, full.bytes.byteOffset, full.bytes.byteLength);
  const to = new DataView(half.bytes.buffer, half.bytes.byteOffset, half.bytes.byteLength);
  const row = full.bytes.byteLength / full.height;
  const halfRow = half.bytes.byteLength / half.height;
  const texel = (x: number, y: number, c: number) =>
    halfFloat.f16ToF32(from.getUint16(y * row + x * 8 + c * 2, true));
  let maxUlp = 0;
  let worst:
    | { x: number; y: number; channel: number; expected: number; actual: number }
    | undefined;
  for (let y = 0; y < half.height; y++) {
    for (let x = 0; x < half.width; x++) {
      const right = Math.min(2 * x + 1, full.width - 1);
      const bottom = Math.min(2 * y + 1, full.height - 1);
      for (let c = 0; c < 4; c++) {
        const reference =
          (texel(2 * x, 2 * y, c) +
            texel(right, 2 * y, c) +
            texel(2 * x, bottom, c) +
            texel(right, bottom, c)) *
          0.25;
        const actual = to.getUint16(y * halfRow + x * 8 + c * 2, true);
        const expected = halfFloat.f32ToF16(reference);
        const difference = Math.abs(actual - expected);
        if (difference > maxUlp) {
          maxUlp = difference;
          worst = { x, y, channel: c, expected, actual };
        }
      }
    }
  }
  expect(maxUlp, JSON.stringify({ label, worst })).toBeLessThanOrEqual(1);
}

async function verifyTsrReplay(input: {
  readonly tape: Parameters<typeof openReplay>[0];
  readonly bytes: Uint8Array;
  readonly model: ReturnType<typeof buildFrameModel>;
  readonly tsr: ReturnType<typeof buildFrameModel>['works'];
  readonly raster: boolean;
  readonly live: { readonly rgba: Uint8Array };
  readonly temporal: ReturnType<Renderer['inspect']>['temporal'];
  readonly backend: Parameters<typeof attachRecorder>[0];
  readonly replayCanvas?:
    | Parameters<Parameters<typeof attachRecorder>[0]['rhi']['requestAdapter']>[1]
    | undefined;
  readonly save?: EvidenceWriter | undefined;
}) {
  const { tape, bytes, model, tsr, raster, live, temporal, backend, replayCanvas, save } = input;
  const adapter = (await backend.rhi.requestAdapter({}, replayCanvas)).unwrap();
  const device = (
    await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
  ).unwrap();
  const replay = (
    await openReplay(tape, { device, createShaderModule: backend.createShaderModule })
  ).unwrap();
  try {
    // Compute lane (8 passes): measure_opaque, dilate, analyze, resurrect_guide, moire,
    // reject_fused, spatial, reconstruct.
    // Raster lane (15 passes): measure_opaque, dilate, analyze, resurrect_guide, moire_clamp,
    // moire_measure, moire_update, moire_history, clamp, measure, resurrect_clamp,
    // resurrect_measure, reject, spatial, reconstruct.
    const attachments = raster
      ? [1, 2, 4, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 1, 3]
      : [1, 2, 4, 1, 2, 2, 1, 3];
    const inspections = [];
    for (const [index, work] of tsr.entries()) {
      const inspected = (
        await replay.inspectWork(work.workIndex, ['pipeline', 'bindings', 'outputs'])
      ).unwrap();
      expect(inspected.pipeline?.status).toBe('available');
      expect(inspected.outputs?.length).toBe(attachments[index]);
      expect(inspected.outputs?.every((o) => o.result.ok)).toBe(true);
      inspections.push(inspected);
    }
    const last = model.works.at(-1);
    if (!last) throw new Error('missing final output work');
    const final = (await replay.inspectWork(last.workIndex, ['pixels'])).unwrap().attachment;
    if (!final) throw new Error('missing fresh-device pixels');
    const rgba = new Uint8Array(64 * 64 * 4),
      stride = final.bytes.byteLength / 64;
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        const src = y * stride + x * 4,
          dst = (y * 64 + x) * 4;
        rgba.set(final.bytes.subarray(src, src + 4), dst);
        if (final.format?.startsWith('bgra'))
          [rgba[dst], rgba[dst + 2]] = [rgba[dst + 2] ?? 0, rgba[dst] ?? 0];
      }
    expect([...rgba]).toEqual([...live.rgba]);
    if (save) {
      await save(`stable.rhitape`, bytes);
      await save(`stable-live.png`, preview(live.rgba));
      await save(`stable-replay.png`, preview(rgba));
      await save(
        `stable.json`,
        JSON.stringify(
          {
            digest: await tapeDigest(bytes),
            temporal,
            summary: summarizeFrame(model),
            inspections,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    (await replay.dispose()).unwrap();
  }
}
