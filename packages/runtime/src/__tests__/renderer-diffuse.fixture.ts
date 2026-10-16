import { createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { RhiError } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  halfToFloat,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { assert, expect } from 'vitest';
import type { RayPublicationSet } from '../../../render/src/__tests__/raytracing/path-tracer.commands';
import { constructRuntimeRendererHost } from '../renderer-host';
import { renderValue } from './standard-gbuffer-replay.fixture';

type Save = (name: string, bytes: Uint8Array) => void | Promise<void>;

/** Ordinary Renderer and real cooked material publication. No test-owned render passes. */
export async function verifyRendererDiffuse(
  fixture: RayPublicationSet,
  save: Save,
  manifestUrl?: string,
  reconstruction?: 'combined',
) {
  const recorder = attachRecorder(webgpu).unwrap();
  const errors: unknown[] = [];
  let native: GPUDevice | undefined;
  let surface: GPUTexture | undefined;
  let accumulation: GPUBuffer | undefined;
  let submits = 0;
  let rejectSubmit = false;
  let changeBeforeSubmit: (() => void) | undefined;
  let completionGate: Promise<void> | undefined;
  let loseDevice: (() => void) | undefined;
  let surfaceFormat: GPUTextureFormat = 'rgba8unorm';
  const giBuffers = new Set<GPUBuffer>();
  const namedGiBuffers = new Map<string, GPUBuffer>();
  const destroyedGiBuffers = new Set<GPUBuffer>();
  const canvas = {
    width: 32,
    height: 32,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        native = config.device;
        surfaceFormat = config.format;
        native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        const createBuffer = native.createBuffer.bind(native);
        native.createBuffer = (descriptor) => {
          const buffer = createBuffer(descriptor);
          if (descriptor.label === 'ray-path.accumulation') accumulation = buffer;
          if (
            descriptor.label?.startsWith('ray-diffuse.') ||
            descriptor.label?.startsWith('ray-path.')
          ) {
            giBuffers.add(buffer);
            if (descriptor.label) namedGiBuffers.set(descriptor.label, buffer);
            const destroy = buffer.destroy.bind(buffer);
            buffer.destroy = () => {
              destroyedGiBuffers.add(buffer);
              destroy();
            };
          }
          return buffer;
        };
        const submit = native.queue.submit.bind(native.queue);
        native.queue.submit = (commands) => {
          submits++;
          submit(commands);
        };
        const completed = native.queue.onSubmittedWorkDone.bind(native.queue);
        native.queue.onSubmittedWorkDone = async () => {
          const gate = completionGate;
          await completed();
          await gate;
          return undefined;
        };
        surface?.destroy();
        surface = native.createTexture({
          size: [canvas.width, canvas.height],
          format: config.format,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          usage: 0x11,
        });
      },
      unconfigure() {},
      getCurrentTexture: () => {
        assert(native);
        if (surface?.width !== canvas.width || surface.height !== canvas.height) {
          surface?.destroy();
          surface = native.createTexture({
            size: [canvas.width, canvas.height],
            format: surfaceFormat,
            viewFormats: [surfaceFormat === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
            usage: 0x11,
          });
        }
        return surface;
      },
    }),
  };
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      {
        rhi: recorder.backend.rhi,
        rhiInstrumentation: {
          deviceLost: () =>
            new Promise((resolve) => {
              loseDevice = () =>
                resolve({
                  reason: 'unknown',
                  message: 'host-injected diffuse GI loss; no physical driver reset claimed',
                });
            }),
          onDeviceLost: () => recorder.deviceLost(),
          resolveSurfaceDevice: (device) =>
            ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
          beforeSubmit: () => {
            const change = changeBeforeSubmit;
            changeBeforeSubmit = undefined;
            change?.();
            if (!rejectSubmit) return undefined;
            rejectSubmit = false;
            return new RhiError({
              code: 'queue-submit-failed',
              expected: 'injected reference diffuse submission failure',
              hint: 'retry the frame',
            });
          },
        },
      },
      manifestUrl === undefined ? undefined : { shaderManifestUrl: manifestUrl },
    ),
  );
  const { renderer, assets } = host;
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const original = renderer.inspect().profile;
  const world = new World();
  const load = async (name: string) => {
    const material = fixture.materials.find((entry) => entry.name === name);
    assert(material);
    const record = validateCookedMaterialRecord(
      JSON.parse(material.cookedPublication.record),
    ).unwrap();
    const ready = await createMaterialLoader({
      loadPublication: async () => ({
        guid: name,
        record,
        artifacts: Object.fromEntries(
          Object.entries(material.cookedPublication.artifacts).map(([path, bytes]) => [
            path,
            { bytes: new TextEncoder().encode(bytes) },
          ]),
        ),
      }),
    }).load({ guid: name, specializationKey: record.specializationKey ?? '' });
    assert(ready.status === 'Ready', JSON.stringify(ready));
    assets.catalog(name, material.asset).unwrap();
    assets.recordMaterialReadiness(name, ready);
    return world.allocSharedRef('MaterialAsset', material.asset);
  };
  const matte = await load('matte');
  const emitterMaterial = await load('emission');
  const mesh = world.allocSharedRef('MeshAsset', createBoxGeometry(2, 2, 0.1).unwrap());
  const receiver = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -3] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [matte] } },
    )
    .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 50,
          antialias: 0,
          bloom: 0,
          tonemap: 0,
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0, 0, -1],
        color: [1, 1, 1],
        intensity: 1,
        castShadow: false,
      },
    })
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  const directProfile = {
    ...original,
    renderPath: 'deferred' as const,
    ibl: false,
    ssao: false,
    visibleSurface: true,
  };
  const settings = {
    ...(reconstruction === undefined ? {} : { reconstruction }),
    gather: 'exact' as const,
    maxBounces: 1,
    maxDistance: 100,
    seed: 47,
    environment: [0.25, 0.5, 0.75] as const,
  };
  const submit = () =>
    renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
      geometryLane: 'direct',
    });
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const receipt = renderValue(submit());
    renderValue(await receipt.completed);
    return receipt;
  };
  const settled = async () => {
    const started = performance.now();
    while (performance.now() - started < 60000) {
      const receipt = await draw();
      const state = renderer.inspect().diffuseGi;
      if (state?.state === 'failed') throw new Error(JSON.stringify({ state, errors }));
      if (state?.state === 'ready' && state.submittedFrames > 0) return receipt;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(
      `diffuse preparation did not settle under ongoing frames: ${JSON.stringify(renderer.inspect().diffuseGi)}`,
    );
  };
  const hdr = async (name: string) => {
    assert(renderer.requestObservation);
    renderValue(renderer.requestObservation(['linear-hdr']));
    const receipt = await draw();
    const result = renderValue(
      await renderer.observe(receipt, { include: ['linear-hdr'] }),
    ).observations?.find((item) => item.domain === 'linear-hdr');
    assert(result);
    await save(`${name}.rgba16float`, result.bytes);
    const data = new DataView(
      result.bytes.buffer,
      result.bytes.byteOffset,
      result.bytes.byteLength,
    );
    const offset = 16 * result.metadata.bytesPerRow + 16 * 8;
    const center = [0, 1, 2, 3].map((channel) =>
      halfToFloat(data.getUint16(offset + channel * 2, true)),
    );
    return { bytes: result.bytes, center };
  };
  const readGiBuffer = async (source: GPUBuffer) => {
    assert(native);
    const buffer = native.createBuffer({
      size: source.size,
      usage: 8 | 1,
    });
    try {
      const encoder = native.createCommandEncoder();
      encoder.copyBufferToBuffer(source, 0, buffer, 0, buffer.size);
      native.queue.submit([encoder.finish()]);
      await buffer.mapAsync(1);
      return new Uint8Array(buffer.getMappedRange().slice(0));
    } finally {
      buffer.destroy();
    }
  };
  const readD = () => {
    assert(accumulation);
    return readGiBuffer(accumulation);
  };
  const giInspection = () => {
    const gi = renderer.inspect().diffuseGi;
    assert(gi, 'Renderer exposes its GI preparation state');
    assert(!('gather' in gi), 'this fixture selects the exact ray gather');
    return gi;
  };
  const centers: Record<string, readonly number[]> = {};
  try {
    renderValue(renderer.setProfile(directProfile));
    for (let i = 0; i < 8; i++) await draw();
    // Preserve the direct-light control frame before asserting its pixels.
    // A missing surface or rejected draw must retain its real RHI owner evidence.
    const directPending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const direct = await hdr('direct');
    (await recorder.frameBoundary()).unwrap();
    const directTape = (await directPending).unwrap();
    await save('direct.rhitape', directTape.bytes);
    centers.direct = direct.center;
    expect(direct.center[0]).toBeGreaterThan(0);
    renderValue(renderer.setProfile({ ...directProfile, diffuseGi: settings }));
    await settled();
    const generation = giInspection().generation;
    if (reconstruction !== undefined) {
      await draw();
      expect(giInspection().reconstruction).toMatchObject({
        mode: reconstruction,
        historyUsed: true,
        allocatedBytes: 32 * 32 * 224 + 48,
      });
      expect(renderer.inspect().perFramePassNames).toEqual(
        expect.arrayContaining([
          'ray-diffuse.temporal',
          'ray-diffuse.spatial',
          'ray-diffuse.composite',
        ]),
      );
    }
    const before = submits;
    await draw();
    expect(submits - before).toBe(1);
    const lit = await hdr('indirect');
    centers.indirect = lit.center;
    expect(giInspection().generation).toBe(generation);
    for (let channel = 0; channel < 3; channel++)
      expect((lit.center[channel] ?? NaN) - (direct.center[channel] ?? NaN)).toBeGreaterThan(0.01);
    expect(lit.center[3]).toBe(direct.center[3]);
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const captured = await hdr('captured');
    (await recorder.frameBoundary()).unwrap();
    const encoded = (await pending).unwrap();
    const rawD = await readD();
    await save('renderer.rhitape', encoded.bytes);
    await save('raw-d.bin', rawD);
    const viewD = new DataView(rawD.buffer);
    const centerOffset = (16 * 32 + 16) * 80;
    for (let channel = 0; channel < 3; channel++)
      expect(viewD.getFloat32(centerOffset + channel * 4, true)).toBeCloseTo(
        settings.environment[channel] ?? NaN,
        5,
      );
    expect(viewD.getUint32(centerOffset + 12, true)).toBe(1);
    expect(viewD.getUint32(centerOffset + 28, true)).toBe(0);
    const tape = decodeTape(encoded.bytes).unwrap();
    const model = buildFrameModel(tape);
    const composite = model.works.find((work) =>
      work.pipeline.shaders.some(
        (shader) =>
          shader.stage === 'fragment' &&
          shader.entryPoint ===
            (reconstruction === undefined ? 'fs_ray_diffuse' : 'fs_ray_diffuse_reconstructed'),
      ),
    );
    assert(composite, 'ordinary frame contains the production diffuse composite');
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    const replay = (
      await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      const inspected = (
        await replay.inspectWork(composite.workIndex, ['pipeline', 'bindings', 'pixels'])
      ).unwrap();
      assert(inspected.attachment);
      expect(inspected.attachment.bytes).toEqual(captured.bytes);
      const accumulationResource = model.resources.find(
        (resource) =>
          (resource.descriptor as { desc?: { label?: string } })?.desc?.label ===
          'ray-path.accumulation',
      );
      assert(accumulationResource);
      const reread = (
        await replay.readResourceAtWork(accumulationResource.resourceId, composite.workIndex)
      ).unwrap();
      expect(reread.bytes).toEqual(rawD);
      if (reconstruction !== undefined) {
        const histories = model.resources.filter((resource) =>
          ['ray-diffuse.history-a', 'ray-diffuse.history-b'].includes(
            (resource.descriptor as { desc?: { label?: string } }).desc?.label ?? '',
          ),
        );
        expect(histories).toHaveLength(2);
        for (const resource of histories) {
          const history = (
            await replay.readResourceAtWork(resource.resourceId, composite.workIndex)
          ).unwrap();
          await save(`history-${resource.resourceId.replaceAll(':', '-')}.bin`, history.bytes);
          const data = new DataView(
            history.bytes.buffer,
            history.bytes.byteOffset,
            history.bytes.byteLength,
          );
          expect(data.getFloat32((16 * 32 + 16) * 96 + 12, true)).toBeGreaterThan(1);
        }
      }
      await save(
        'inspection.json',
        new TextEncoder().encode(
          JSON.stringify(
            {
              digest: encoded.digest,
              works: model.works.length,
              resources: model.resources.length,
              unseeded: model.unseededResources,
              composite: inspected,
            },
            null,
            2,
          ),
        ),
      );
    } finally {
      (await replay.dispose()).unwrap();
      webgpu._internal_getRawDevice(device)?.destroy();
    }
    // Remove only the production composite draw. The recorded direct HDR must
    // survive, proving that the observed delta belongs to this pass.
    const omitted = {
      ...tape,
      events: tape.events.filter((_, index) => index !== composite.eventIndex),
    };
    const omittedModel = buildFrameModel(omitted);
    expect(omittedModel.works.length).toBe(model.works.length - 1);
    const omittedAdapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const omittedDevice = (
      await omittedAdapter.requestDevice(
        replayDeviceRequest(omitted, omittedAdapter.features, omittedAdapter.limits),
      )
    ).unwrap();
    const omittedReplay = (
      await openReplay(omitted, {
        device: omittedDevice,
        createShaderModule: webgpu.createShaderModule,
      })
    ).unwrap();
    try {
      const attachment = composite.attachments?.colorViewHandleIds[0];
      const last = omittedModel.works.at(-1);
      assert(attachment && last);
      const withoutGi = (
        await omittedReplay.readResourceAtWork(attachment, last.workIndex)
      ).unwrap();
      expect(withoutGi.bytes).toEqual(direct.bytes);
      expect(withoutGi.bytes).not.toEqual(captured.bytes);
      await save('missing-composite.rgba16float', withoutGi.bytes);
    } finally {
      (await omittedReplay.dispose()).unwrap();
      webgpu._internal_getRawDevice(omittedDevice)?.destroy();
    }
    const submittedFrames = giInspection().submittedFrames;
    expect(errors).toEqual([]);
    const acceptedReconstruction = giInspection().reconstruction;
    if (reconstruction !== undefined) world.set(camera, Camera, { fov: Math.PI / 4 }).unwrap();
    rejectSubmit = true;
    const rejected = submit();
    expect(rejected.ok).toBe(false);
    expect(giInspection().submittedFrames).toBe(submittedFrames);
    expect(giInspection().reconstruction).toEqual(acceptedReconstruction);
    if (reconstruction !== undefined) world.set(camera, Camera, { fov: Math.PI / 3 }).unwrap();
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors)
      expect(error).toMatchObject({
        code: 'device-operation-failed',
        detail: {
          operation: 'renderer-event',
          cause: {
            code: 'queue-submit-failed',
            expected: 'injected reference diffuse submission failure',
            hint: 'retry the frame',
          },
        },
      });
    errors.length = 0;
    await draw();
    expect(giInspection().submittedFrames).toBe(submittedFrames + 1);
    if (reconstruction !== undefined) {
      const readHistoryWeight = async () => {
        const parity = giInspection().submittedFrames % 2 === 1 ? 'a' : 'b';
        const buffer = namedGiBuffers.get(`ray-diffuse.history-${parity}`);
        assert(buffer);
        const bytes = await readGiBuffer(buffer);
        return new DataView(bytes.buffer).getFloat32((16 * 32 + 16) * 96 + 12, true);
      };
      for (let i = 0; i < 20; i++) await draw();
      expect(await readHistoryWeight()).toBeCloseTo(16, 4);
      const beforeMovement = giInspection().generation;
      world.set(camera, Transform, { pos: [0, 0, -0.2] }).unwrap();
      await draw();
      expect(giInspection().generation).toBe(beforeMovement);
      expect(giInspection().reconstruction?.historyUsed).toBe(true);
      expect(await readHistoryWeight()).toBeGreaterThan(1);
      world.set(camera, Camera, { historyVersion: 1 }).unwrap();
      await draw();
      expect(giInspection().reconstruction).toMatchObject({
        historyUsed: false,
        resetReason: 'history-version',
      });
      expect(await readHistoryWeight()).toBe(1);
      await draw();
      expect(await readHistoryWeight()).toBeGreaterThan(1);
      world.set(camera, Camera, { fov: Math.PI / 4 }).unwrap();
      await draw();
      expect(giInspection().reconstruction).toMatchObject({
        historyUsed: false,
        resetReason: 'projection-change',
      });
      expect(await readHistoryWeight()).toBe(1);
      world.set(camera, Camera, { fov: Math.PI / 3 }).unwrap();
      world.set(camera, Transform, { pos: [0, 0, 0] }).unwrap();
      await draw();
    }
    const acceptedSubmits = submits;
    const acceptedFrames = giInspection().submittedFrames;
    changeBeforeSubmit = () => {
      renderValue(renderer.setProfile({ ...directProfile, diffuseGi: { ...settings, seed: 48 } }));
    };
    // Change the accepted profile after encoding, before the actual queue submit.
    // This is a content fence failure, not the injected queue error above.
    expect(submit().ok).toBe(false);
    expect(submits).toBe(acceptedSubmits);
    expect(giInspection().submittedFrames).toBe(acceptedFrames);
    expect(errors).toEqual([]);
    await settled();
    expect(giInspection().generation).toBeGreaterThan(generation);
    renderValue(
      renderer.setProfile({ ...directProfile, diffuseGi: { ...settings, environment: [0, 0, 0] } }),
    );
    await settled();
    const off = await hdr('source-off');
    centers.sourceOff = off.center;
    expect(off.bytes).toEqual(direct.bytes);
    const emitter = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 2] } },
        {
          component: MeshFilter,
          data: {
            assetHandle: world.allocSharedRef('MeshAsset', createBoxGeometry(20, 20, 0.1).unwrap()),
          },
        },
        { component: MeshRenderer, data: { materials: [emitterMaterial] } },
      )
      .unwrap();
    await settled();
    const bounce = await hdr('offscreen-emitter');
    centers.offscreenEmitter = bounce.center;
    expect((bounce.center[0] ?? NaN) - (direct.center[0] ?? NaN)).toBeGreaterThan(0.05);
    world.despawn(emitter).unwrap();
    await settled();
    expect((await hdr('emitter-removed')).bytes).toEqual(direct.bytes);
    world.set(receiver, MeshRenderer, { materials: [emitterMaterial] }).unwrap();
    renderValue(renderer.setProfile({ ...directProfile, diffuseGi: settings }));
    await settled();
    const black = await hdr('black-receiver');
    expect(new DataView((await readD()).buffer).getFloat32(centerOffset, true)).toBeGreaterThan(0);
    renderValue(renderer.setProfile(directProfile));
    const blackOff = await hdr('black-receiver-off');
    expect(black.bytes).toEqual(blackOff.bytes);
    centers.blackReceiver = black.center;
    expect(errors).toEqual([]);
    world.set(receiver, MeshRenderer, { materials: [matte] }).unwrap();
    renderValue(renderer.setProfile({ ...directProfile, diffuseGi: settings }));
    await settled();
    const beforeResize = giInspection().generation;
    canvas.width = canvas.height = 16;
    await settled();
    expect(giInspection().pixelCount).toBe(256);
    expect(giInspection().generation).toBeGreaterThan(beforeResize);
    canvas.width = canvas.height = 32;
    await settled();
    expect(giInspection().pixelCount).toBe(1024);

    const activeBuffers = [...giBuffers].filter((buffer) => !destroyedGiBuffers.has(buffer));
    expect(activeBuffers.length).toBeGreaterThan(0);
    let releaseCompletion = () => {};
    completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const held = renderValue(submit());
    const beforeDisable = giInspection().generation;
    renderValue(renderer.setProfile(directProfile));
    const disabled = renderValue(submit());
    try {
      expect(renderer.inspect().diffuseGi).toBeUndefined();
      expect(activeBuffers.filter((buffer) => destroyedGiBuffers.has(buffer))).toEqual([]);
    } finally {
      completionGate = undefined;
      releaseCompletion();
    }
    renderValue(await held.completed);
    renderValue(await disabled.completed);
    await expect
      .poll(() => activeBuffers.every((buffer) => destroyedGiBuffers.has(buffer)))
      .toBe(true);
    renderValue(renderer.setProfile({ ...directProfile, diffuseGi: settings }));
    await settled();
    expect(giInspection().generation).toBeGreaterThan(beforeDisable);
    const beforeLoss = await hdr('before-loss');
    const oldDevice = native;
    assert(loseDevice);
    loseDevice();
    await expect.poll(() => renderer.state()).toBe('device-lost');
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'device-operation-failed',
        detail: expect.objectContaining({
          cause: expect.objectContaining({ code: 'device-lost' }),
        }),
      }),
    ]);
    errors.length = 0;
    renderValue(await renderer.recover());
    oldDevice?.destroy();
    expect(native).not.toBe(oldDevice);
    await settled();
    expect((await hdr('recovered')).bytes).toEqual(beforeLoss.bytes);
    expect(errors).toEqual([]);
    await save(
      'result.json',
      new TextEncoder().encode(
        JSON.stringify(
          {
            centers,
            reconstruction: reconstruction ?? 'raw',
            resolution: [32, 32],
            rawSamplesPerFrame: 1,
            oneRendererSubmit: true,
            replayExact: true,
            missingCompositeFalsifier: true,
            contentFenceRejectedBeforeQueue: true,
            retirementWaitedForCompletion: true,
            hostInjectedDeviceRecovery: true,
            resizeRebuilt: true,
            giBuffers: giBuffers.size,
            retiredGiBuffers: destroyedGiBuffers.size,
            errors,
          },
          null,
          2,
        ),
      ),
    );
  } finally {
    await save(
      'latest-state.json',
      new TextEncoder().encode(
        JSON.stringify(
          {
            centers,
            errors,
            inspection: renderer.inspect(),
          },
          null,
          2,
        ),
      ),
    );
    unsubscribe();
    lease.dispose();
    renderValue(await renderer.dispose());
    (await recorder.dispose()).unwrap();
    surface?.destroy();
    native?.destroy();
  }
}
