import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack';
import {
  Camera,
  CameraView,
  createRenderPublisher,
  MeshFilter,
  MeshRenderer,
  renderPublicationTransfers,
} from '@forgeax/engine-render';
import { RhiError } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
  workOutputs,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import {
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
} from '@forgeax/engine-vfx';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { expect } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { constructRuntimeRendererHost } from '../renderer-host';
import { compactTape } from './compact-tape.fixture';
import { testAssets } from './helpers/runtime-assets';
import { renderValue } from './standard-gbuffer-replay.fixture';
import type { CookMeshLightingFixture } from './vfx-mesh-lighting.fixture';

/** Real simulation, projection, source ACK, and fresh-device replay on the ordinary Renderer path. */
export async function verifyMultiCameraVfx(options: {
  readonly canvas: Parameters<typeof constructRuntimeRendererHost>[0];
  readonly shaderManifestUrl: string;
  readonly publication: boolean;
  readonly warmupFrames?: number;
  readonly verifyVisibilityTransitions?: boolean;
  readonly cook: CookMeshLightingFixture;
  readonly save: (name: string, bytes: Uint8Array) => void | Promise<void>;
}) {
  const world = new World();
  const source = createVfxRuntimeHost({
    camera: {
      read: () => ({
        position: new Float32Array([3, 0, 3]),
        right: new Float32Array([1, 0, 0]),
        up: new Float32Array([0, 1, 0]),
        viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.1, 0, -3, 0, 0.5, 1]),
      }),
    },
  });
  const receiver = options.publication
    ? createVfxRuntimeHost({ camera: { read: () => undefined } })
    : source;
  const identity = { source: 'multi-camera-vfx', epoch: 1 };
  const recorder = attachRecorder(webgpu).unwrap();
  let failSubmit = false;
  let signalLoss: (() => void) | undefined;
  const host = renderValue(
    await constructRuntimeRendererHost(
      options.canvas,
      {
        rhi: recorder.backend.rhi,
        features: [receiver.feature],
        ...(options.publication ? { publicationSource: identity } : {}),
        rhiInstrumentation: {
          deviceLost: () =>
            new Promise((resolve) => {
              signalLoss = () =>
                resolve({ reason: 'unknown', message: 'multi-camera scene input recovery' });
            }),
          resolveSurfaceDevice: (device) =>
            ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
          beforeSubmit: () => {
            if (!failSubmit) return undefined;
            failSubmit = false;
            return new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'injected VFX frame submit failure',
              hint: 'retry the same source frame',
            });
          },
        },
      },
      { shaderManifestUrl: options.shaderManifestUrl },
    ),
  );
  const { renderer, assets } = host;
  world.bindAssets(assets).unwrap();
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const material = AssetGuid.random();
  publishRuntimeAssets(assets, [
    { guid: AssetGuid.format(material), asset: createBuiltinMaterialAsset('unlit') },
  ]);
  (await assets.load(material, 'material')).unwrap();
  // This occluder is outside both display frusta but centered in the simulation camera.
  const occluder = world
    .spawn(
      { component: Transform, data: { pos: [3, 0, 0] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
        },
      },
      {
        component: MeshRenderer,
        data: {
          materials: [testAssets(world).create(createBuiltinMaterialAsset('unlit')).unwrap()],
        },
      },
    )
    .unwrap();
  const cameras = [0, 1].map((index) =>
    world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [0, 0, 3],
            quat: index === 0 ? [0, 0, 0, 1] : [0, 0, Math.SQRT1_2, Math.SQRT1_2],
          },
        },
        {
          component: Camera,
          data: { fov: Math.PI / 3, near: 0.1, far: 10, tonemap: 1, clearColor: [0, 0, 0, 1] },
        },
        {
          component: CameraView,
          data: {
            viewport: [index * 0.5, 0, 0.5, 1],
            order: index,
            updateInterval: index === 0 ? 1 : 3,
          },
        },
      )
      .unwrap(),
  );
  const cooked = await options.cook(
    {
      schemaVersion: 3,
      emitters: [
        {
          id: 'shared-particles',
          capacity: 8,
          backend: { required: 'gpu' },
          space: 'world',
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: 2 },
          simulationWhenCulled: 'pause',
          schedule: { rate: 0, bursts: [{ time: 0, count: 2 }] },
          program: { module: 'multi-camera.wgsl' },
          renderers: [
            { kind: 'billboard', material: AssetGuid.format(material), sorting: 'view-depth' },
          ],
        },
      ],
    },
    {
      'multi-camera.wgsl': {
        entry: `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
#import forgeax_vfx::data::camera
#import forgeax_vfx::data::scene_depth
#import forgeax_vfx::data::noise
fn scene_color() -> vec4<f32> {
  let center = vec2<i32>(textureDimensions(forgeax_vfx_scene_depth)) / 2;
  let depth = textureLoad(forgeax_vfx_scene_depth, center, 0);
  let noiseValue = textureLoad(forgeax_vfx_noise, vec2<i32>(0, 0), 0).r;
  let cameraError = clamp(abs(forgeax_vfx_camera[3][0] + 3.0), 0.0, 1.0);
  return vec4<f32>(select(vec3<f32>(0.0, 1.0, 0.05 + noiseValue * 0.05), vec3<f32>(1.0, 0.0, 0.05 + noiseValue * 0.05), depth > 0.0) + vec3<f32>(0.0, 0.0, cameraError), 1.0);
}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(0.0, 0.0, 0.0);
  (*particle).color = scene_color();
  (*particle).sprite_size = vec2<f32>(0.8, 0.4);
  (*particle).lifetime = 100.0;
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) { (*particle).position.x += ctx.delta * 0.01; (*particle).color = scene_color(); }`,
      },
    },
  );
  if (!cooked.ok) throw cooked.error;
  (await source.attachWorld({ world, assets })).unwrap();
  const emitter = world
    .spawn({
      component: ParticleEffectPlayer,
      data: {
        effect: testAssets(world).create(cooked.value.asset).unwrap(),
        playing: true,
        seed: 1,
        timeScale: 1,
      },
    })
    .unwrap();
  const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
  const lease = options.publication ? undefined : renderValue(renderer.attach(world));
  const publisher = options.publication
    ? createRenderPublisher(world, assets, identity, renderer.inspect().capabilities, [
        source.feature,
      ])
    : undefined;
  let acknowledgements = 0;
  let frameNumber = 0;
  const draw = async (update = true) => {
    if (update) world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const candidate = publisher?.prepare(++frameNumber / 60).unwrap();
    const packet =
      candidate === undefined
        ? undefined
        : structuredClone(candidate.message, {
            transfer: renderPublicationTransfers(candidate.message),
          });
    candidate?.accept();
    try {
      const result = renderer.draw(
        packet === undefined
          ? {
              leases: [required(lease)],
              camera: { lease: required(lease) },
              environment: { lease: required(lease) },
            }
          : {
              publication: packet,
              onFeatureSourceSubmitted: (feature, feedback) => {
                acknowledgements++;
                required(publisher)
                  .acknowledgeFeatures(packet.revision, [
                    { identity: feature, feedback: structuredClone(feedback) },
                  ])
                  .unwrap();
              },
            },
      );
      if (!result.ok)
        throw new Error(
          JSON.stringify(
            { failure: result.error, errors, features: renderer.inspect().featureDiagnostics },
            (_key, value) =>
              value instanceof Error
                ? {
                    ...value,
                    message: value.message,
                    cause: value.cause,
                    ...(value instanceof AggregateError ? { errors: value.errors } : {}),
                  }
                : value,
          ),
        );
      renderValue(await result.value.completed);
      return result.value;
    } finally {
      if (packet !== undefined)
        required(publisher).recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    }
  };
  try {
    for (let i = 0; i < (options.warmupFrames ?? 60); i++) {
      const before = acknowledgements;
      await draw();
      // First-use material preparation can defer simulation; once admitted,
      // each Renderer submission may acknowledge the feature at most once.
      if (publisher !== undefined) expect(acknowledgements - before).toBeLessThanOrEqual(1);
    }
    if (runtime.snapshot().length > 0) {
      const pendingFailure = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      await draw(false);
      (await recorder.frameBoundary()).unwrap();
      const failure = (await pendingFailure).unwrap();
      await options.save('vfx-readiness-failure.rhitape', compactTape(failure).bytes);
      await options.save(
        'vfx-readiness-failure.json',
        new TextEncoder().encode(
          JSON.stringify(
            {
              features: renderer.inspect().featureDiagnostics,
              model: buildFrameModel(decodeTape(failure.bytes).unwrap()),
            },
            null,
            2,
          ),
        ),
      );
    }
    expect(runtime.snapshot(), JSON.stringify(renderer.inspect().featureDiagnostics)).toHaveLength(
      0,
    );
    if (publisher !== undefined) expect(acknowledgements).toBeGreaterThan(0);
    const held = required(renderer.inspect().views);
    expect(required(held[0]).renderedFrames).toBeGreaterThan(required(held[1]).renderedFrames);
    world.set(required(cameras[1]), CameraView, { updateInterval: 1 }).unwrap();
    if (options.verifyVisibilityTransitions) {
      const stages: {
        name: string;
        updates: number;
        projections: number;
        graphGeneration: number;
        deviceGeneration: number;
      }[] = [];
      const captureStage = async (name: string) => {
        renderValue(required(renderer.requestObservation).call(renderer, ['final-display']));
        const pendingStage = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        const completed = await draw();
        (await recorder.frameBoundary()).unwrap();
        const tape = (await pendingStage).unwrap();
        const model = buildFrameModel(decodeTape(tape.bytes).unwrap());
        const pixels = required(
          required(
            renderValue(await renderer.observe(completed, { include: ['final-display'] }))
              .observations,
          ).find((row) => row.domain === 'final-display'),
        );
        const workCount = (entryPoint: string) =>
          model.works.filter((work) =>
            work.pipeline.shaders.some((shader) => shader.entryPoint === entryPoint),
          ).length;
        const updates = model.works.filter((work) =>
          work.pipeline.shaders.some(
            (shader) =>
              shader.entryPoint === 'forgeax_vfx_update_main' ||
              shader.entryPoint === 'forgeax_vfx_update_compact_main',
          ),
        ).length;
        stages.push({
          name,
          updates,
          projections: workCount('forgeax_vfx_billboard_main'),
          graphGeneration: required(completed.graphGeneration),
          deviceGeneration: completed.deviceGeneration,
        });
        await options.save(`vfx-${name}.rgba`, pixels.bytes);
        return {
          pixels,
          updates,
          projections: workCount('forgeax_vfx_billboard_main'),
        };
      };
      const visible = await captureStage('visible');
      expect(visible.updates).toBe(1);
      expect(visible.projections).toBe(2);
      world.set(emitter, ParticleEffectPlayer, { playing: false }).unwrap();
      for (let i = 0; i < 3; i++) await draw();
      const paused = await captureStage('paused');
      expect(paused.updates).toBe(0);
      expect(paused.projections).toBe(2);
      // Both physical display views move outside the emitter, while its
      // independent simulation camera and previously committed GPU state stay owned.
      for (const camera of cameras) world.set(camera, Transform, { pos: [50, 0, 3] }).unwrap();
      for (let i = 0; i < 3; i++) await draw();
      const hidden = await captureStage('hidden');
      expect(hidden.updates).toBe(0);
      expect(hidden.projections).toBe(0);
      for (const camera of cameras) world.set(camera, Transform, { pos: [0, 0, 3] }).unwrap();
      world.set(emitter, ParticleEffectPlayer, { playing: true }).unwrap();
      for (let i = 0; i < 3; i++) await draw();
      const resumed = await captureStage('resumed');
      expect(resumed.updates).toBe(1);
      expect(resumed.projections).toBe(2);
      for (const visibleStage of [visible, paused, resumed]) {
        const red = visibleStage.pixels.metadata.format.startsWith('bgra') ? 2 : 0;
        for (const x of [32, 96]) {
          const offset = 32 * visibleStage.pixels.metadata.bytesPerRow + x * 4;
          expect(required(visibleStage.pixels.bytes[offset + red])).toBeGreaterThan(100);
          expect(
            required(visibleStage.pixels.bytes[offset + red]) -
              required(visibleStage.pixels.bytes[offset + 1]),
          ).toBeGreaterThan(80);
        }
      }
      for (const x of [32, 96]) {
        const offset = 32 * hidden.pixels.metadata.bytesPerRow + x * 4;
        expect(Array.from(hidden.pixels.bytes.subarray(offset, offset + 3))).toEqual([0, 0, 0]);
      }
      expect(new Set(stages.map((stage) => stage.graphGeneration)).size).toBe(1);
      expect(new Set(stages.map((stage) => stage.deviceGeneration)).size).toBe(1);
      expect(runtime.snapshot()).toHaveLength(0);
      expect(errors).toEqual([]);
      await options.save(
        'vfx-visibility-transitions.json',
        new TextEncoder().encode(JSON.stringify(stages, null, 2)),
      );
    }
    failSubmit = true;
    const beforeFailure = acknowledgements;
    await expect(draw()).rejects.toThrow();
    expect(runtime.snapshot().length).toBeGreaterThan(0);
    expect(acknowledgements).toBe(beforeFailure);
    expect(errors).toHaveLength(1);
    errors.length = 0;
    await draw(false);
    expect(runtime.snapshot()).toHaveLength(0);
    if (publisher !== undefined) expect(acknowledgements - beforeFailure).toBe(1);
    renderValue(required(renderer.requestObservation).call(renderer, ['final-display']));
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const beforeCapture = acknowledgements;
    const receipt = await draw();
    (await recorder.frameBoundary()).unwrap();
    const capture = (await pending).unwrap();
    await options.save('vfx.rhitape', compactTape(capture).bytes);
    if (publisher !== undefined) expect(acknowledgements - beforeCapture).toBe(1);
    const tape = decodeTape(capture.bytes).unwrap();
    expect(tape.events.filter((event) => event.kind === 'submit')).toHaveLength(1);
    const model = buildFrameModel(tape);
    const entries = (entryPoint: string) =>
      model.works.filter((work) =>
        work.pipeline.shaders.some((shader) => shader.entryPoint === entryPoint),
      );
    const updates = model.works.filter((work) =>
      work.pipeline.shaders.some(
        (shader) =>
          shader.entryPoint === 'forgeax_vfx_update_main' ||
          shader.entryPoint === 'forgeax_vfx_update_compact_main',
      ),
    );
    expect(updates).toHaveLength(1);
    expect(entries('forgeax_vfx_sort_main')).toHaveLength(2);
    const simulation = required(updates[0]);
    const depthWriters = model.works.filter(
      (work) =>
        work.workIndex < simulation.workIndex && work.attachments?.depthStencilViewHandleId != null,
    );
    expect(depthWriters).toHaveLength(1);
    expect(
      renderer
        .inspect()
        .perFramePassNames.filter((name) => name.startsWith('feature-scene-depth-face.')),
    ).toHaveLength(1);
    const projections = entries('forgeax_vfx_billboard_main');
    expect(projections).toHaveLength(2);
    for (const projection of projections)
      expect(projection.workIndex).toBeGreaterThan(simulation.workIndex);
    const bindings = (binding: number) =>
      projections.map((work) =>
        required(
          work.bindings.find((row) => row.groupIndex === 0 && row.binding === binding)?.resourceId,
        ),
      );
    expect(new Set(bindings(0)).size).toBe(1);
    for (const binding of [1, 2, 3, 4, 6]) expect(new Set(bindings(binding)).size).toBe(2);
    const composites = model.works.filter((work) =>
      work.pipeline.shaders.some((shader) => shader.source?.includes('var picture: texture_2d')),
    );
    expect(composites).toHaveLength(2);
    const observation = required(
      required(
        renderValue(await renderer.observe(receipt, { include: ['final-display'] })).observations,
      ).find((row) => row.domain === 'final-display'),
    );
    const width = 128,
      height = 64;
    const live = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      live.set(
        observation.bytes.subarray(
          y * observation.metadata.bytesPerRow,
          y * observation.metadata.bytesPerRow + width * 4,
        ),
        y * width * 4,
      );
    await options.save('vfx.rgba', live);
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    const replay = (
      await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      const bases = [];
      const final = required(composites.at(-1));
      const output = required(workOutputs(final).find((row) => row.role === 'color'));
      const projectionReads = (
        await replay.readAtWorks([
          ...projections.map((work, index) => ({
            resourceId: required(bindings(1)[index]),
            workIndex: work.workIndex,
          })),
          { ...output.request, workIndex: final.workIndex },
        ])
      ).unwrap();
      for (const result of projectionReads.slice(0, projections.length)) {
        const data = result.unwrap();
        bases.push(
          Array.from(new Float32Array(data.bytes.buffer, data.bytes.byteOffset + 24 * 4, 3)),
        );
      }
      expect(required(bases[0])[0]).toBeCloseTo(1, 4);
      expect(Math.abs(required(required(bases[1])[1]))).toBeCloseTo(1, 4);
      const rendered = required(projectionReads[projections.length]).unwrap();
      const pixels = rendered.bytes;
      expect(pixels.length).toBe(live.length);
      let delta = 0;
      for (let index = 0; index < live.length; index++)
        delta = Math.max(delta, Math.abs(required(live[index]) - required(pixels[index])));
      expect(delta).toBeLessThanOrEqual(1);
      const format = required(rendered.format);
      const redChannel = format.startsWith('bgra') ? 2 : 0;
      const blueChannel = 2 - redChannel;
      for (const x of [32, 96]) {
        const offset = (32 * width + x) * 4;
        expect(required(pixels[offset + redChannel])).toBeGreaterThan(100);
        expect(
          required(pixels[offset + redChannel]) - required(pixels[offset + 1]),
        ).toBeGreaterThan(80);
        expect(required(pixels[offset + blueChannel])).toBeLessThan(120);
      }
      await options.save('vfx-replay.rgba', pixels);
      await options.save(
        'vfx.json',
        new TextEncoder().encode(
          JSON.stringify(
            {
              digest: capture.digest,
              submits: 1,
              updates: 1,
              depthWriters: depthWriters.map((work) => work.workIndex),
              simulation: simulation.workIndex,
              projections: projections.length,
              cameraBases: bases,
              format,
              delta,
              acknowledgements,
              views: renderer.inspect().views,
            },
            null,
            2,
          ),
        ),
      );
    } finally {
      (await replay.dispose()).unwrap();
    }
    // Display cadence/order cannot pause or redirect the independent simulation inputs.
    for (const camera of cameras) world.set(camera, CameraView, { updateInterval: 1000 }).unwrap();
    const beforeHeld = required(renderer.inspect().views).map((view) => view.renderedFrames);
    await draw();
    expect(required(renderer.inspect().views).map((view) => view.renderedFrames)).toEqual(
      beforeHeld,
    );
    expect(
      renderer
        .inspect()
        .perFramePassNames.filter((name) => name.startsWith('feature-scene-depth-face.')),
    ).toHaveLength(1);
    expect(runtime.snapshot()).toHaveLength(0);
    world.despawn(occluder).unwrap();
    for (const [index, camera] of cameras.entries())
      world.set(camera, CameraView, { updateInterval: 1, order: 1 - index }).unwrap();
    for (let i = 0; i < 3; i++) await draw();
    renderValue(required(renderer.requestObservation).call(renderer, ['final-display']));
    const withoutOccluder = await draw();
    const changed = required(
      required(
        renderValue(await renderer.observe(withoutOccluder, { include: ['final-display'] }))
          .observations,
      ).find((row) => row.domain === 'final-display'),
    );
    await options.save('vfx-depth-falsifier.rgba', changed.bytes);
    const changedRedChannel = changed.metadata.format.startsWith('bgra') ? 2 : 0;
    for (const x of [32, 96]) {
      const offset = 32 * changed.metadata.bytesPerRow + x * 4;
      expect(required(changed.bytes[offset + 1])).toBeGreaterThan(100);
      expect(
        required(changed.bytes[offset + 1]) - required(changed.bytes[offset + changedRedChannel]),
      ).toBeGreaterThan(80);
    }
    expect(runtime.snapshot()).toHaveLength(0);
    expect(errors).toEqual([]);

    // Exercise a new GPU generation through the same Host loss/recovery contract.
    required(signalLoss)();
    await expect.poll(() => renderer.state()).toBe('device-lost');
    expect(errors).toMatchObject([
      { code: 'device-operation-failed', detail: { cause: { code: 'device-lost' } } },
    ]);
    errors.length = 0;
    renderValue(await renderer.recover());
    world.despawn(emitter).unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [3, 0, 0] } },
        {
          component: MeshFilter,
          data: {
            assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
          },
        },
        {
          component: MeshRenderer,
          data: {
            materials: [testAssets(world).create(createBuiltinMaterialAsset('unlit')).unwrap()],
          },
        },
      )
      .unwrap();
    world
      .spawn({
        component: ParticleEffectPlayer,
        data: {
          effect: testAssets(world).create(cooked.value.asset).unwrap(),
          playing: true,
          seed: 2,
          timeScale: 1,
        },
      })
      .unwrap();
    for (let i = 0; i < 8; i++) await draw();
    renderValue(required(renderer.requestObservation).call(renderer, ['final-display']));
    const recovered = await draw();
    expect(recovered.deviceGeneration).toBeGreaterThan(receipt.deviceGeneration);
    const recoveredPixels = required(
      required(
        renderValue(await renderer.observe(recovered, { include: ['final-display'] })).observations,
      ).find((row) => row.domain === 'final-display'),
    );
    await options.save('vfx-recovered.rgba', recoveredPixels.bytes);
    const recoveredRedChannel = recoveredPixels.metadata.format.startsWith('bgra') ? 2 : 0;
    for (const x of [32, 96]) {
      const offset = 32 * recoveredPixels.metadata.bytesPerRow + x * 4;
      expect(required(recoveredPixels.bytes[offset + recoveredRedChannel])).toBeGreaterThan(100);
      expect(
        required(recoveredPixels.bytes[offset + recoveredRedChannel]) -
          required(recoveredPixels.bytes[offset + 1]),
      ).toBeGreaterThan(80);
    }
    expect(runtime.snapshot()).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    off();
    publisher?.dispose();
    (await source.detachWorld({ world })).unwrap();
    renderValue(await renderer.dispose());
    (await recorder.dispose()).unwrap();
  }
}

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('missing multi-camera VFX evidence');
  return value;
}
