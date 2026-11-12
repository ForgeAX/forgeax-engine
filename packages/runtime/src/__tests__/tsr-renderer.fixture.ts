import type { EntityHandle } from '@forgeax/engine-ecs';
import { encodePng } from '@forgeax/engine-image/png';
import type { Renderer } from '@forgeax/engine-render';
import {
  ANTIALIAS_TAA,
  ANTIALIAS_TSR,
  Camera,
  CameraView,
  DynamicResolution,
} from '@forgeax/engine-render';
import type { RecorderAttachment } from '@forgeax/engine-rhi-debug';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
  summarizeFrame,
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

/** Both physical carriers execute exactly the same lifecycle and replay oracle. */
export async function verifyTsrRenderer(
  canvas: Parameters<typeof constructRuntimeRendererHost>[0],
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
    ).toEqual(
      ['tsr_measure_opaque', 'tsr_analyze', 'tsr_reconstruct'].map((entry) =>
        raster ? `${entry}_fragment` : entry,
      ),
    );
    if (raster) expect(model.works.some((work) => work.kind === 'dispatchWorkgroups')).toBe(false);
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
      live,
      temporal,
      backend,
      replayCanvas,
      save,
    });
    // Disocclusion must remove old radiance immediately, even after settling.
    const mesh = scene.meshes[0];
    if (mesh === undefined) throw new Error('missing moving surface');
    scene.world.set(mesh, Transform, { pos: [5, 5, 0] }).unwrap();
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

    expect([...uncovered.rgba.slice((16 * 64 + 16) * 4, (16 * 64 + 16) * 4 + 3)]).toEqual([
      0, 0, 0,
    ]);
    scene.world.set(mesh, Transform, { pos: [-1, 1, 0] }).unwrap();
    await scene.drawReady();
    // Fixed-input changes retain a valid color owner while rebuilding Guide capacity.
    scene.world.set(camera, DynamicResolution, { minScale: 0.75, maxScale: 0.75 }).unwrap();
    await scene.drawReady();
    expect(renderer.inspect().dynamicResolution?.extent?.internalWidth).toBe(48);
    expect(renderer.inspect().temporal.historyValid).toBe(true);
    scene.world.removeComponent(camera, DynamicResolution).unwrap();
    await scene.drawReady();
    expect(renderer.inspect().temporal.resources.activeBytes).toBe(64 * 64 * 64);
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
  expect(views?.every((v) => v.temporal.resources.activeBytes === 32 * 64 * 64)).toBe(true);
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

async function verifyTsrReplay(input: {
  readonly tape: Parameters<typeof openReplay>[0];
  readonly bytes: Uint8Array;
  readonly model: ReturnType<typeof buildFrameModel>;
  readonly tsr: ReturnType<typeof buildFrameModel>['works'];
  readonly live: { readonly rgba: Uint8Array };
  readonly temporal: ReturnType<Renderer['inspect']>['temporal'];
  readonly backend: Parameters<typeof attachRecorder>[0];
  readonly replayCanvas?:
    | Parameters<Parameters<typeof attachRecorder>[0]['rhi']['requestAdapter']>[1]
    | undefined;
  readonly save?: EvidenceWriter | undefined;
}) {
  const { tape, bytes, model, tsr, live, temporal, backend, replayCanvas, save } = input;
  const adapter = (await backend.rhi.requestAdapter({}, replayCanvas)).unwrap();
  const device = (
    await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
  ).unwrap();
  const replay = (
    await openReplay(tape, { device, createShaderModule: backend.createShaderModule })
  ).unwrap();
  try {
    const inspections = [];
    for (const work of tsr) {
      const inspected = (
        await replay.inspectWork(work.workIndex, ['pipeline', 'bindings', 'outputs'])
      ).unwrap();
      expect(inspected.pipeline?.status).toBe('available');
      expect(inspected.outputs?.length).toBe(work === tsr[0] ? 1 : 3);
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
