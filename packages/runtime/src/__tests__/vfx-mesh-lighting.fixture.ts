import { World } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createPlaneGeometry,
  deriveVertexCount,
  deriveVertexLayoutProjection,
  packInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack';
import {
  Camera,
  createRenderPublisher,
  DirectionalLight,
  type FrameReceipt,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PointLightShadow,
  type RenderError,
  renderPublicationAssetTransfers,
  renderPublicationTransfers,
  Skylight,
  SpotLight,
} from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import { Transform } from '@forgeax/engine-scene';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import { ok, type ParticleEffectAsset, type Result } from '@forgeax/engine-types';
import { ParticleEffectPlayer } from '@forgeax/engine-vfx';
import type { ParticleCodeModuleSet } from '@forgeax/engine-vfx-compiler';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { expect, onTestFailed, onTestFinished } from 'vitest';
import {
  completeReadyFrame,
  drawReadyFrame,
} from '../../../../scripts/test/ready-render-frame.mjs';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { loadBackendPack } from '../backend-selection';
import { constructRuntimeRendererHost } from '../renderer-host';

export type CookMeshLightingFixture = (
  source: unknown,
  modules: Readonly<Record<string, ParticleCodeModuleSet>>,
) => Promise<Result<{ readonly asset: ParticleEffectAsset }, unknown>>;

function inspect(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item instanceof Error ? { ...item, message: item.message } : item,
  );
}

/** Scope the existing opt-in binding receipt required by the active-IBL oracle. */
export async function verifyVfxMeshLighting(
  options: Parameters<typeof runVfxMeshLighting>[0],
): Promise<void> {
  const globals = globalThis as { process?: { env: Record<string, string | undefined> } };
  const priorProcess = globals.process;
  const diagnosticProcess = priorProcess ?? { env: {} };
  const priorFlag = diagnosticProcess.env.FORGEAX_MATERIAL_DIAGNOSTICS;
  globals.process = diagnosticProcess;
  diagnosticProcess.env.FORGEAX_MATERIAL_DIAGNOSTICS = '1';
  const verification = runVfxMeshLighting(options).finally(() => {
    if (priorFlag === undefined) delete diagnosticProcess.env.FORGEAX_MATERIAL_DIAGNOSTICS;
    else diagnosticProcess.env.FORGEAX_MATERIAL_DIAGNOSTICS = priorFlag;
    if (priorProcess === undefined) delete globals.process;
  });
  // Vitest aborts the test context at its original timeout, but does not
  // terminate its async body. Await that body's existing cleanup in the
  // runner's original finished-hook budget; an incomplete drain stays failed.
  onTestFinished(() =>
    verification.then(
      () => undefined,
      () => undefined,
    ),
  );
  await verification;
}

/** One real-device acceptance path shared by native Dawn and browser WebGPU. */
async function runVfxMeshLighting(options: {
  readonly shaderManifestUrl: string;
  readonly signal: AbortSignal;
  readonly publication?: boolean;
  readonly sampledTextureLimit?: number;
  readonly cook: CookMeshLightingFixture;
  readonly tapePaths?: Readonly<Record<string, string | undefined>>;
  readonly saveTape?: (path: string, bytes: Uint8Array) => void;
  readonly onIblFailure?: (state: unknown, tape?: Uint8Array) => Promise<void>;
}): Promise<void> {
  options.signal.throwIfAborted();
  const errors: unknown[] = [];
  let failurePhase = 'backend-pack';
  const startedAt = performance.now();
  let phaseStartedAt = startedAt;
  const phaseTimings: Record<string, { calls: number; elapsedMs: number }> = {};
  const cookWaitIntervals: {
    readonly sampleIndex: number;
    readonly startedAtUnixMs: number;
    readonly completedAtUnixMs: number;
  }[] = [];
  const enterFailurePhase = (next: string): void => {
    options.signal.throwIfAborted();
    const now = performance.now();
    if (failurePhase === 'vfx-cook') {
      if (cookWaitIntervals.length >= 256) cookWaitIntervals.shift();
      cookWaitIntervals.push({
        sampleIndex,
        startedAtUnixMs: performance.timeOrigin + phaseStartedAt,
        completedAtUnixMs: performance.timeOrigin + now,
      });
    }
    const timing = phaseTimings[failurePhase] ?? { calls: 0, elapsedMs: 0 };
    phaseTimings[failurePhase] = timing;
    timing.calls++;
    timing.elapsedMs += now - phaseStartedAt;
    failurePhase = next;
    phaseStartedAt = now;
  };
  const inspectPhaseTimings = () => ({
    elapsedMs: performance.now() - startedAt,
    completed: structuredClone(phaseTimings),
    cookWaitIntervals: structuredClone(cookWaitIntervals),
    pending: {
      phase: failurePhase,
      startedAtUnixMs: performance.timeOrigin + phaseStartedAt,
      elapsedMs: performance.now() - phaseStartedAt,
    },
    qualification:
      'Fixture wall durations including async waits. Unix intervals correlate with Node-host receipts only on the same clock; negative ordering remains unclassified. Not exclusive GPU or compiler CPU time.',
  });
  let sampleIndex = 0;
  let sampleState: unknown = null;
  let completedFrames = 0;
  let cleanupStarted = false;
  let inspectRenderer: (() => unknown) | undefined;
  let iblFailureRecorded = false;
  if (options.onIblFailure !== undefined) {
    onTestFailed(async () => {
      if (iblFailureRecorded) return;
      // Preserve the operation at the original timeout, including a producer
      // failure before Renderer construction or a state observed after cleanup.
      await options.onIblFailure?.({
        phase: failurePhase,
        phaseTimings: inspectPhaseTimings(),
        sampleIndex,
        sampleState,
        completedFrames,
        cleanupStarted,
        renderer: inspectRenderer?.() ?? null,
        events: errors,
        reason: 'test-failed-or-timed-out',
        captureUnavailable:
          'The original frame may still be in flight; no following frame was submitted.',
      });
    });
  }
  const env = options.tapePaths ?? {};
  const cookParticleCodeEffect = options.cook;
  const world = new World();
  const focal = 1 / Math.tan(Math.PI / 8);
  const viewProjection = new Float32Array([
    focal,
    0,
    0,
    0,
    0,
    focal,
    0,
    0,
    0,
    0,
    -10 / 9.9,
    -1,
    0,
    0,
    29 / 9.9,
    3,
  ]);
  const vfx = createVfxRuntimeHost({
    camera: {
      read: () => ({
        position: new Float32Array([0, 0, 3]),
        right: new Float32Array([1, 0, 0]),
        up: new Float32Array([0, 1, 0]),
        viewProjection,
      }),
    },
  });
  const publicationIdentity = { source: 'vfx-lighting-proof', epoch: 1 };
  let receiverFeature = options.publication
    ? createVfxRuntimeHost({ camera: { read: () => undefined } }).feature
    : vfx.feature;
  let publisher: ReturnType<typeof createRenderPublisher> | undefined;
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  const pack = await loadBackendPack({});
  if (!pack.ok) throw pack.error;
  if (pack.value.createShaderModule === undefined) throw new Error('No shader factory');
  const recording = attachRecorder({
    ...pack.value,
    createShaderModule: pack.value.createShaderModule,
  });
  if (!recording.ok) throw recording.error;
  const recorder = recording.value;
  const capturedWork: unknown[] = [];
  const canvas = {
    width: 64,
    height: 64,
    getContext: () => ({
      configure(descriptor: GPUCanvasConfiguration) {
        device = descriptor.device;
        device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        target = device.createTexture({
          size: [64, 64],
          format: descriptor.format,
          viewFormats: [descriptor.format === 'rgba8unorm' ? 'rgba8unorm-srgb' : 'bgra8unorm-srgb'],
          usage: 0x10 | 0x01,
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
    addEventListener() {},
    removeEventListener() {},
  };
  enterFailurePhase('renderer-construction');
  const constructed = await constructRuntimeRendererHost(
    canvas,
    {
      features: [receiverFeature],
      ...(options.publication ? { publicationSource: publicationIdentity } : {}),
      rhi: {
        ...recorder.backend.rhi,
        async requestAdapter(request, surface) {
          const result = await recorder.backend.rhi.requestAdapter(request, surface);
          if (!result.ok || options.sampledTextureLimit === undefined) return result;
          const limit = options.sampledTextureLimit;
          return ok({
            ...result.value,
            limits: { ...result.value.limits, maxSampledTexturesPerShaderStage: limit },
            requestDevice: (descriptor) =>
              result.value.requestDevice({
                ...descriptor,
                requiredLimits: {
                  ...descriptor?.requiredLimits,
                  maxSampledTexturesPerShaderStage: limit,
                },
              }),
          });
        },
      },
      rhiInstrumentation: {
        resolveSurfaceDevice(device) {
          const unwrapped = recorder.backend.unwrapDeviceForSurface(device);
          if (!unwrapped.ok) throw unwrapped.error;
          return ok(unwrapped.value);
        },
      },
    },
    {
      shaderManifestUrl: options.shaderManifestUrl,
    },
  );
  if (!constructed.ok) throw constructed.error;
  const { renderer, assets } = constructed.value;
  inspectRenderer = () => renderer.inspect();
  renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  let vfxAttached = false;
  try {
    enterFailurePhase('scene-authoring');
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 10 } },
      )
      .unwrap();
    const light = world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [-1, 0, -1],
          color: [1, 1, 1],
          intensity: 3,
          castShadow: true,
          cascadeCount: 1,
          mapSize: testQuality.shadowMapSize,
          shadowDistance: 6,
          depthBias: 0.001,
          normalBias: 0.001,
        },
      })
      .unwrap();
    const material = createBuiltinMaterialAsset('standard');
    const mesh = createBoxGeometry(0.5, 0.5, 0.5).unwrap();
    const materialGuid = AssetGuid.random();
    const meshGuid = AssetGuid.random();
    const materialAdded = assets.catalog(materialGuid, {
      ...material,
      values: { ...material.values, baseColor: [0.3, 0.3, 0.3, 1], metallic: 0, roughness: 1 },
    });
    if (!materialAdded.ok) throw materialAdded.error;
    const meshAdded = assets.catalog(meshGuid, mesh);
    if (!meshAdded.ok) throw meshAdded.error;
    const attached = options.publication ? undefined : renderer.attach(world);
    if (attached !== undefined && !attached.ok) throw attached.error;
    const lease = attached?.value;
    if (options.publication)
      publisher = createRenderPublisher(
        world,
        assets,
        publicationIdentity,
        renderer.inspect().capabilities,
        [vfx.feature],
      );
    const attachedVfx = await vfx.attachWorld({ world, assets });
    if (!attachedVfx.ok) throw attachedVfx.error;
    vfxAttached = true;
    const drawFrame = async (): Promise<Result<FrameReceipt, RenderError>> => {
      options.signal.throwIfAborted();
      if (publisher === undefined) {
        if (lease === undefined) throw new Error('Missing World lease');
        return ok(
          await drawReadyFrame(renderer, {
            leases: [lease],
            camera: { lease },
            environment: { lease },
          }),
        );
      }
      const source = publisher;
      const receipt = await completeReadyFrame(async () => {
        const candidate = source.prepare(0).unwrap();
        const packet = structuredClone(candidate.packet, {
          transfer: [
            ...renderPublicationTransfers(candidate.packet),
            ...renderPublicationAssetTransfers(candidate.packet),
          ],
        });
        candidate.accept();
        try {
          const draw = renderer.draw({
            publication: packet,
            onFeatureSourceSubmitted: (identity, feedback) => {
              source
                .acknowledgeFeatures(packet.revision, [
                  { identity, feedback: structuredClone(feedback) },
                ])
                .unwrap();
            },
          });
          if (!draw.ok) throw draw.error;
          const complete = await draw.value.completed;
          if (!complete.ok) throw complete.error;
          return draw.value;
        } finally {
          source.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
        }
      });
      return ok(receipt);
    };
    const pixel = async () => {
      options.signal.throwIfAborted();
      if (device === undefined || target === undefined) throw new Error('No GPU surface');
      const buffer = device.createBuffer({ size: 256, usage: 0x01 | 0x08 });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture: target, origin: [32, 32] },
          { buffer, bytesPerRow: 256 },
          [1, 1],
        );
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(1);
        const result = [...new Uint8Array(buffer.getMappedRange()).slice(0, 4)];
        buffer.unmap();
        return result;
      } finally {
        buffer.destroy();
      }
    };
    let pointShadowCaptureStage = 0;
    let requireActiveIbl = false;
    const sample = async (
      lighting: 'standard' | 'unlit',
      receiveShadows: boolean,
      intensity: number,
      caster?: { readonly enabled: boolean; readonly position: readonly [number, number, number] },
      surface?: {
        readonly ordinary?: boolean;
        readonly roughness: number;
        readonly metallic: number;
      },
      geometryGuid = meshGuid,
    ) => {
      sampleIndex++;
      sampleState = { lighting, receiveShadows, intensity, caster, surface, requireActiveIbl };
      completedFrames = 0;
      enterFailurePhase('sample-authoring');
      world.set(light, DirectionalLight, { intensity }).unwrap();
      const surfaceMaterial = {
        ...material,
        values: {
          ...material.values,
          baseColor: [0.3, 0.3, 0.3, 1],
          metallic: surface?.metallic ?? 0,
          roughness: surface?.roughness ?? 1,
        },
      };
      const surfaceGuid = surface === undefined ? materialGuid : AssetGuid.random();
      if (surface !== undefined) {
        const added = assets.catalog(surfaceGuid, surfaceMaterial);
        if (!added.ok) throw added.error;
      }
      enterFailurePhase('vfx-cook');
      const cooked = await cookParticleCodeEffect(
        {
          schemaVersion: 3,
          emitters: [
            // Its ordinary raster precedes the off-camera caster in authored
            // order. It must not delay the independent caster's GPU projection.
            ...(caster?.enabled
              ? [
                  {
                    id: 'visible-prefix',
                    capacity: 1,
                    backend: { required: 'gpu' as const },
                    space: 'world' as const,
                    bounds: { kind: 'sphere' as const, center: [0.7, 0, 0], radius: 0.5 },
                    schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
                    program: { module: 'visible.wgsl' },
                    renderers: [
                      {
                        kind: 'mesh' as const,
                        mesh: AssetGuid.format(geometryGuid),
                        material: AssetGuid.format(materialGuid),
                        lighting: 'unlit' as const,
                        castShadows: false,
                      },
                    ],
                  },
                ]
              : []),
            {
              id: 'mesh',
              capacity: 1,
              backend: { required: 'gpu' },
              space: 'world',
              bounds: {
                kind: 'sphere',
                center: caster?.position ?? [0, 0, 0],
                radius: caster === undefined ? 4 : 0.5,
              },
              schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
              program: { module: 'mesh.wgsl' },
              renderers: [
                {
                  kind: 'mesh',
                  mesh: AssetGuid.format(geometryGuid),
                  material: AssetGuid.format(surfaceGuid),
                  lighting,
                  receiveShadows,
                  castShadows: caster?.enabled ?? false,
                },
              ],
            },
          ],
        },
        {
          'visible.wgsl': {
            entry: `
#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(0.7, 0.0, 0.0);
  (*particle).color = vec4<f32>(1.0);
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  (*particle).mesh_scale = vec3<f32>(0.25);
  (*particle).lifetime = 100.0;
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {}`,
          },
          'mesh.wgsl': {
            entry: `
#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(${(caster?.position ?? [0, 0, 0]).map((value) => `${value.toFixed(2)}`).join(', ')});
  (*particle).color = vec4<f32>(1.0);
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  (*particle).mesh_scale = vec3<f32>(1.0);
  (*particle).lifetime = 100.0;
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {}`,
          },
        },
      );
      if (!cooked.ok) throw cooked.error;
      enterFailurePhase('sample-install');
      const player =
        surface?.ordinary === true
          ? world
              .spawn(
                {
                  component: Transform,
                  data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
                },
                {
                  component: MeshFilter,
                  data: { assetHandle: world.allocSharedRef('MeshAsset', mesh) },
                },
                {
                  component: MeshRenderer,
                  data: { materials: [world.allocSharedRef('MaterialAsset', surfaceMaterial)] },
                },
              )
              .unwrap()
          : world
              .spawn({
                component: ParticleEffectPlayer,
                data: {
                  effect: world.allocSharedRef('ParticleEffectAsset', cooked.value.asset),
                  playing: true,
                  seed: 1,
                  timeScale: 1,
                },
              })
              .unwrap();
      try {
        for (let index = 0; index < 300; index++) {
          world.update(1 / 60).unwrap();
          enterFailurePhase('frame-submission');
          const submitted = await drawFrame();
          if (!submitted.ok) throw new Error(inspect({ error: submitted.error, events: errors }));
          enterFailurePhase('frame-completion');
          const completed = await submitted.value.completed;
          if (!completed.ok) throw completed.error;
          completedFrames++;
          enterFailurePhase('ibl-publication');
          // IBL precompute publishes asynchronously. Sequential material samples
          // must share active resources, not compare fallback with a later bake.
          if (
            index >= 7 &&
            (!requireActiveIbl || renderer.inspect().iblBinding?.active === 'active')
          )
            break;
        }
        if (requireActiveIbl) {
          try {
            expect(renderer.inspect().iblBinding?.active, 'IBL publication within 300 frames').toBe(
              'active',
            );
          } catch (failure) {
            if (options.onIblFailure !== undefined) {
              iblFailureRecorded = true;
              const state = {
                phase: failurePhase,
                phaseTimings: inspectPhaseTimings(),
                sampleIndex,
                sampleState,
                completedFrames,
                cleanupStarted,
                renderer: renderer.inspect(),
                events: errors,
                frameCount: 300,
              };
              // Preserve the failed original oracle before diagnostic GPU work.
              try {
                await options.onIblFailure(state);
                const capture = recorder.captureFrame();
                const before = await recorder.frameBoundary();
                if (!before.ok) throw before.error;
                world.update(1 / 60).unwrap();
                const draw = await drawFrame();
                if (!draw.ok) throw draw.error;
                const completed = await draw.value.completed;
                if (!completed.ok) throw completed.error;
                const after = await recorder.frameBoundary();
                if (!after.ok) throw after.error;
                const encoded = await capture;
                if (!encoded.ok) throw encoded.error;
                await options.onIblFailure(state, encoded.value.bytes);
              } catch (captureError) {
                console.error(
                  'VFX IBL failure capture unavailable',
                  inspect({ ...state, captureError }),
                );
              }
            }
            throw failure;
          }
        }
        if (options.sampledTextureLimit !== undefined) {
          expect(device?.limits.maxSampledTexturesPerShaderStage).toBe(options.sampledTextureLimit);
        }
        expect(errors).toEqual([]);
        if (caster?.enabled) {
          expect(
            vfx
              .inspect(world)
              ?.players.flatMap((player) => player.emitters)
              .map((emitter) => emitter.cameraVisible),
          ).toEqual([true, false]);
          const names = renderer.inspect().perFramePassNames;
          const projectIndices = names.flatMap((name, index) =>
            name.endsWith('.project') ? [index] : [],
          );
          expect(projectIndices.length).toBeGreaterThan(0);
          for (const projectIndex of projectIndices)
            expect(projectIndex, names.join('\n')).toBeLessThan(names.indexOf('shadowCascade0'));
        }
        if (
          caster?.enabled === true ||
          surface?.ordinary === true ||
          (env.FORGEAX_POINT_SHADOW_TAPE !== undefined && pointShadowCaptureStage === 2) ||
          (caster?.enabled &&
            intensity === 0 &&
            (env.FORGEAX_VFX_CAST_TAPE !== undefined ||
              env.FORGEAX_POINT_SHADOW_TAPE !== undefined)) ||
          (lighting === 'standard' &&
            receiveShadows &&
            intensity === 3 &&
            capturedWork.length === 0)
        ) {
          enterFailurePhase('rhi-capture');
          const capture = recorder.captureFrame();
          const before = await recorder.frameBoundary();
          if (!before.ok) throw before.error;
          world.update(1 / 60).unwrap();
          const draw = await drawFrame();
          if (!draw.ok) throw draw.error;
          const observed = await renderer.observe(draw.value, { include: ['draws'] });
          if (!observed.ok) throw observed.error;
          const after = await recorder.frameBoundary();
          if (!after.ok) throw after.error;
          const encoded = await capture;
          if (!encoded.ok) throw encoded.error;
          if (env.FORGEAX_VFX_LIGHTING_TAPE !== undefined) {
            options.saveTape?.(env.FORGEAX_VFX_LIGHTING_TAPE, encoded.value.bytes);
          }
          if (env.FORGEAX_POINT_SHADOW_TAPE !== undefined && pointShadowCaptureStage === 2) {
            options.saveTape?.(env.FORGEAX_POINT_SHADOW_TAPE, encoded.value.bytes);
          }
          if (
            env.FORGEAX_POINT_SHADOW_TAPE !== undefined &&
            caster?.enabled === true &&
            lighting === 'standard' &&
            receiveShadows &&
            intensity === 0 &&
            surface === undefined
          ) {
            options.saveTape?.(env.FORGEAX_POINT_SHADOW_TAPE, encoded.value.bytes);
          }
          if (caster?.enabled && env.FORGEAX_VFX_CAST_TAPE !== undefined) {
            options.saveTape?.(env.FORGEAX_VFX_CAST_TAPE, encoded.value.bytes);
          }
          const decoded = decodeTape(encoded.value.bytes);
          if (!decoded.ok) throw decoded.error;
          const model = buildFrameModel(decoded.value);
          if (caster?.enabled) {
            // Logical projections may share one native compute pass. Require
            // both actual dispatches before any depth-only shadow draw.
            const projects = model.works.filter((work) =>
              work.pipeline?.shaders.some(
                (shader) => shader.entryPoint === 'forgeax_vfx_mesh_main',
              ),
            );
            expect(projects).toHaveLength(2);
            const firstShadow = model.works.find(
              (work) =>
                work.attachments !== null &&
                work.attachments.depthStencilViewHandleId !== null &&
                work.attachments.colorViewHandleIds.length === 0,
            );
            if (firstShadow === undefined) throw new Error('Missing captured shadow draw');
            for (const project of projects)
              expect(project.workIndex).toBeLessThan(firstShadow.workIndex);
          }
          capturedWork.push(
            ...model.works.map((work) => ({
              index: work.workIndex,
              kind: work.kind,
              pipeline: work.pipeline?.shaders?.map((shader) => shader.entryPoint),
              bindings: work.bindings.map((binding) => [binding.groupIndex, binding.binding]),
            })),
          );
        }
        enterFailurePhase('pixel-readback');
        const sampled = await pixel();
        if (surface?.ordinary && sampled[3] === 0)
          throw new Error(inspect({ work: capturedWork, renderer: renderer.inspect() }));
        return sampled;
      } finally {
        world.despawn(player).unwrap();
      }
    };
    const lit = await sample('standard', true, 3);
    const dark = await sample('standard', true, 0);
    const unlit = await sample('unlit', true, 0);
    const unlitWithLight = await sample('unlit', false, 3);
    expect(
      lit[0],
      JSON.stringify({ lit, dark, unlit, unlitWithLight, capturedWork }),
    ).toBeGreaterThan((dark[0] ?? 0) + 30);
    expect(unlit[0]).toBeGreaterThan((dark[0] ?? 0) + 30);
    expect(unlitWithLight).toEqual(unlit);
    const vertexCount = deriveVertexCount(
      mesh.vertices,
      deriveVertexLayoutProjection(mesh.attributes),
    );
    if (vertexCount === undefined) throw new Error('Invalid fixture mesh layout');
    const attributes = {
      ...mesh.attributes,
      color: new Float32Array(
        Array.from({ length: vertexCount * 4 }, (_, index) =>
          index % 4 === 1 || index % 4 === 3 ? 1 : 0.1,
        ),
      ),
      uv1: new Float32Array(vertexCount * 2).fill(0.75),
    };
    const packed = packInterleavedVertexAttributes(attributes, vertexCount).unwrap();
    const coloredMeshGuid = AssetGuid.random();
    assets.catalog(coloredMeshGuid, { ...mesh, attributes, vertices: packed.vertices }).unwrap();
    const colored = await sample('unlit', false, 0, undefined, undefined, coloredMeshGuid);
    expect(colored[1], JSON.stringify({ unlit, colored })).toBeGreaterThan((colored[0] ?? 0) + 20);
    expect(await sample('unlit', false, 0)).toEqual(unlit);

    const spawnMeshCaster = (position: readonly [number, number, number], geometry = mesh) =>
      world
        .spawn(
          { component: Transform, data: { pos: position, quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
          {
            component: MeshFilter,
            data: { assetHandle: world.allocSharedRef('MeshAsset', geometry) },
          },
          {
            component: MeshRenderer,
            data: {
              materials: [
                world.allocSharedRef('MaterialAsset', {
                  ...material,
                  passes: [
                    ...(material.passes ?? []),
                    {
                      name: 'ShadowCaster',
                      program: { module: 'forgeax::default-shadow-caster' },
                      renderState: {
                        tags: { LightMode: 'ShadowCaster' },
                        passKind: 'shadow-caster',
                      },
                    },
                  ],
                }),
              ],
            },
          },
        )
        .unwrap();
    const occluder = spawnMeshCaster([1, 0, 1.25]);
    const shadowed = await sample('standard', true, 3);
    const noReceive = await sample('standard', false, 3);
    expect(noReceive[0], JSON.stringify({ lit, shadowed, noReceive })).toBeGreaterThan(
      (shadowed[0] ?? 0) + 30,
    );
    expect(noReceive).toEqual(lit);
    world.despawn(occluder).unwrap();
    expect(await sample('standard', true, 3)).toEqual(lit);
    // Reverse the caster witness: a GPU Mesh must receive the shared point
    // shadow, respect receiveShadows, and consume live authored bias values.
    const receivingPoint = world
      .spawn(
        {
          component: Transform,
          data: { pos: [2.4, 0, 2.65], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: PointLight, data: { color: [1, 1, 1], intensity: 40, range: 10 } },
        {
          component: PointLightShadow,
          data: {
            mapSize: testQuality.shadowMapSize,
            nearPlane: 0.1,
            farPlane: 10,
            depthBias: 0.001,
            normalBias: 0.001,
          },
        },
      )
      .unwrap();
    pointShadowCaptureStage = 1;
    const pointLit = await sample('standard', true, 0);
    const receivingOccluder = spawnMeshCaster([1.2, 0, 1.45]);
    pointShadowCaptureStage = 2;
    const pointShadow = await sample('standard', true, 0);
    const pointNoReceive = await sample('standard', false, 0);
    expect(pointLit[0], JSON.stringify({ pointLit, pointShadow, pointNoReceive })).toBeGreaterThan(
      (pointShadow[0] ?? 0) + 30,
    );
    expect(pointNoReceive).toEqual(pointLit);
    world.set(receivingPoint, PointLightShadow, { depthBias: 1000, normalBias: 0 }).unwrap();
    expect(
      await sample('standard', true, 0),
      'Authored point depth bias must reach the GPU receiver',
    ).toEqual(pointLit);
    world.set(receivingPoint, PointLightShadow, { depthBias: 0.001, normalBias: 400 }).unwrap();
    expect(
      await sample('standard', true, 0),
      'Point slope bias must not be swapped with the depth floor',
    ).toEqual(pointLit);
    world.set(receivingPoint, PointLightShadow, { depthBias: 0.001, normalBias: 0.001 }).unwrap();
    expect(await sample('standard', true, 0)).toEqual(pointShadow);
    world.despawn(receivingOccluder).unwrap();
    expect(await sample('standard', true, 0)).toEqual(pointLit);
    world.set(receivingPoint, PointLight, { intensity: 0 }).unwrap();
    expect(await sample('standard', true, 0)).toEqual(dark);
    world.despawn(receivingPoint).unwrap();
    // A directional HDR panorama falsifies the constant-white fallback and
    // exercises the renderer-owned diffuse, specular mip, and BRDF LUT path.
    const environmentBytes = new Uint8Array(16 * 8 * 8);
    const environmentView = new DataView(environmentBytes.buffer);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 16; x++) {
        const offset = (y * 16 + x) * 8;
        environmentView.setUint16(offset, x < 8 ? 0x4000 : 0x2800, true);
        environmentView.setUint16(offset + 2, 0x2800, true);
        environmentView.setUint16(offset + 4, x < 8 ? 0x2800 : 0x4000, true);
        environmentView.setUint16(offset + 6, 0x3c00, true);
      }
    const sky = world
      .spawn({
        component: Skylight,
        data: {
          equirect: world.allocSharedRef('EquirectAsset', {
            kind: 'equirect',
            width: 16,
            height: 8,
            format: 'rgba16float',
            colorSpace: 'linear',
            data: environmentBytes,
          }),
          intensity: 0.5,
        },
      })
      .unwrap();
    requireActiveIbl = true;
    const environmentSamples: number[][] = [];
    for (const metallic of [0, 1])
      for (const roughness of [0.05, 1]) {
        const surface = { metallic, roughness };
        const ordinary = await sample('standard', true, 0, undefined, {
          ...surface,
          ordinary: true,
        });
        const particle = await sample('standard', true, 0, undefined, surface);
        for (let channel = 0; channel < 3; channel++)
          expect(
            Math.abs((particle[channel] ?? 0) - (ordinary[channel] ?? 0)),
            JSON.stringify({ surface, particle, ordinary }),
          ).toBeLessThanOrEqual(2);
        expect(Math.max(...particle.slice(0, 3))).toBeGreaterThan(30);
        environmentSamples.push(particle);
      }
    expect(environmentSamples[2]).not.toEqual(environmentSamples[3]);
    const environmentLit = await sample('standard', true, 0);
    world.set(sky, Skylight, { rotation: [0, 1, 0, 0] }).unwrap();
    const environmentRotated = await sample('standard', true, 0);
    expect(
      Math.max(
        ...environmentLit
          .slice(0, 3)
          .map((value, index) => Math.abs(value - (environmentRotated[index] ?? 0))),
      ),
    ).toBeGreaterThan(30);
    expect(await sample('standard', false, 0)).toEqual(environmentRotated);
    expect(await sample('unlit', true, 0)).toEqual(unlit);
    world.set(sky, Skylight, { intensity: 0 }).unwrap();
    expect(await sample('standard', true, 0)).toEqual(dark);
    world.despawn(sky).unwrap();
    requireActiveIbl = false;
    expect(await sample('standard', true, 0)).toEqual(dark);
    const receiver = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { component: MeshFilter, data: { assetHandle: world.allocSharedRef('MeshAsset', mesh) } },
        {
          component: MeshRenderer,
          data: {
            materials: [
              world.allocSharedRef('MaterialAsset', {
                ...material,
                passes: [
                  {
                    name: 'Forward',
                    program: { module: 'forgeax::default-standard-pbr' },
                    renderState: { tags: { LightMode: 'Forward' } },
                  },
                ],
              }),
            ],
          },
        },
      )
      .unwrap();
    const casterPosition = [1.2, 0, 1.45] as const;
    const clearReceiver = await sample('unlit', false, 3, {
      enabled: false,
      position: casterPosition,
    });
    const particleShadow = await sample('unlit', false, 3, {
      enabled: true,
      position: casterPosition,
    });
    expect(clearReceiver[0], JSON.stringify({ clearReceiver, particleShadow })).toBeGreaterThan(
      (particleShadow[0] ?? 0) + 30,
    );
    expect(await sample('unlit', false, 3, { enabled: false, position: casterPosition })).toEqual(
      clearReceiver,
    );
    for (const [kind, sideX, sideY] of [
      ['point', 1, 0],
      ['point', -1, 0],
      ['point', 0, 1],
      ['point', 0, -1],
      ['spot', 1, 0],
    ] as const) {
      const localCaster = [sideX * 1.2, sideY * 1.2, 1.45] as const;
      const transform = {
        component: Transform,
        data: {
          pos: [sideX * 2.4, sideY * 2.4, 2.65] as const,
          quat: [0, 0, 0, 1] as const,
          scale: [1, 1, 1] as const,
        },
      };
      const localLight =
        kind === 'point'
          ? world
              .spawn(
                transform,
                { component: PointLight, data: { color: [1, 1, 1], intensity: 40, range: 10 } },
                {
                  component: PointLightShadow,
                  data: {
                    mapSize: testQuality.shadowMapSize,
                    nearPlane: 0.1,
                    farPlane: 10,
                    depthBias: 0.001,
                    normalBias: 0.001,
                  },
                },
              )
              .unwrap()
          : world
              .spawn(transform, {
                component: SpotLight,
                data: {
                  color: [1, 1, 1],
                  intensity: 40,
                  range: 10,
                  direction: [-sideX, -sideY, -1],
                  innerConeDeg: 20,
                  outerConeDeg: 35,
                  castShadow: true,
                  mapSize: testQuality.shadowMapSize,
                  nearPlane: 0.1,
                  farPlane: 10,
                  depthBias: 0.001,
                  normalBias: 0.001,
                },
              })
              .unwrap();
      const clear = await sample('unlit', false, 0, { enabled: false, position: localCaster });
      const shadow = await sample('unlit', false, 0, { enabled: true, position: localCaster });
      expect(clear[0], JSON.stringify({ kind, sideX, sideY, clear, shadow })).toBeGreaterThan(
        (shadow[0] ?? 0) + 30,
      );
      expect(await sample('unlit', false, 0, { enabled: false, position: localCaster })).toEqual(
        clear,
      );
      const meshCaster = spawnMeshCaster(localCaster, createPlaneGeometry(0.5, 0.5).unwrap());
      const ordinaryShadow = await sample('unlit', false, 0, {
        enabled: false,
        position: localCaster,
      });
      expect(
        clear[0],
        JSON.stringify({ kind, sideX, sideY, clear, ordinaryShadow }),
      ).toBeGreaterThan((ordinaryShadow[0] ?? 0) + 30);
      world.set(meshCaster, Transform, { quat: [0, 1, 0, 0] }).unwrap();
      expect(await sample('unlit', false, 0, { enabled: false, position: localCaster })).toEqual(
        clear,
      );
      world.despawn(meshCaster).unwrap();
      expect(await sample('unlit', false, 0, { enabled: false, position: localCaster })).toEqual(
        clear,
      );
      world.despawn(localLight).unwrap();
    }
    // Explicit simulation depth is captured before the shared update. The view's
    // depth-bound mesh projection remains after its shadow lane, so the light
    // consumes the last submitted projection without rerunning a simulation tick.
    world.set(light, DirectionalLight, { intensity: 3 }).unwrap();
    world.update(1 / 60).unwrap();
    const present = async () => {
      const submitted = await drawFrame();
      if (!submitted.ok) throw submitted.error;
      const observed = await renderer.observe(submitted.value, { include: ['draws'] });
      if (!observed.ok) throw observed.error;
      return pixel();
    };
    const depthClear = await present();
    options.signal.throwIfAborted();
    const depthCook = await cookParticleCodeEffect(
      {
        schemaVersion: 3,
        emitters: [
          {
            id: 'depth-latency',
            capacity: 1,
            backend: { required: 'gpu' },
            space: 'world',
            bounds: { kind: 'sphere', center: [1.2, 1, 1.45], radius: 1.5 },
            schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
            program: { module: 'depth-latency.wgsl' },
            renderers: [
              {
                kind: 'mesh',
                mesh: AssetGuid.format(meshGuid),
                material: AssetGuid.format(materialGuid),
                lighting: 'unlit',
                castShadows: true,
              },
            ],
          },
        ],
      },
      {
        'depth-latency.wgsl': {
          entry: `
#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
#import forgeax_vfx::data::scene_depth
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(1.2, 2.0, 1.45);
  (*particle).color = vec4<f32>(1.0);
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  (*particle).mesh_scale = vec3<f32>(1.0);
  (*particle).lifetime = 100.0;
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  let depth = textureLoad(forgeax_vfx_scene_depth, vec2<i32>(32, 32), 0);
  let casts = depth < 0.99 && (ctx.tick % 2u) == 0u;
  (*particle).position = vec3<f32>(1.2, select(2.0, 0.0, casts), 1.45);
}`,
        },
      },
    );
    if (!depthCook.ok) throw depthCook.error;
    const depthPlayer = world
      .spawn({
        component: ParticleEffectPlayer,
        data: {
          effect: world.allocSharedRef('ParticleEffectAsset', depthCook.value.asset),
          playing: true,
          seed: 1,
          timeScale: 1,
        },
      })
      .unwrap();
    const phase = () =>
      vfx.inspect(world)?.players.find((entry) => entry.player === depthPlayer)?.lastCommitted
        ?.phaseTick;
    world.update(1 / 60).unwrap();
    let firstDepthFrame: number[] = [];
    for (let attempt = 0; attempt < 32; attempt++) {
      firstDepthFrame = await present();
      if (phase() === 0) break;
    }
    expect(phase()).toBe(0);
    expect(firstDepthFrame).toEqual(depthClear);
    const depthShadow = await present();
    expect(depthClear[0], JSON.stringify({ depthClear, depthShadow })).toBeGreaterThan(
      (depthShadow[0] ?? 0) + 30,
    );
    expect(phase()).toBe(0);
    expect(await present()).toEqual(depthShadow);
    expect(phase()).toBe(0);
    if (options.publication) {
      // Rebuild an independent receiver without ticking or resetting the source.
      // A non-clear shadow proves retained state was reconstructed, not dropped.
      const removed = await constructed.value.featureHost.uninstallRenderFeature(receiverFeature);
      if (!removed.ok) throw removed.error;
      receiverFeature = createVfxRuntimeHost({ camera: { read: () => undefined } }).feature;
      const installed = await constructed.value.featureHost.installRenderFeature(receiverFeature);
      if (!installed.ok) throw installed.error;
      let restored: number[] = [];
      for (let attempt = 0; attempt < 32; attempt++) {
        restored = await present();
        if (restored.every((value, index) => value === depthShadow[index])) break;
      }
      expect(restored).toEqual(depthShadow);
      expect(phase()).toBe(0);
    }

    const capture = recorder.captureFrame();
    const before = await recorder.frameBoundary();
    if (!before.ok) throw before.error;
    world.update(1 / 60).unwrap();
    const changedDepthFrame = await present();
    const after = await recorder.frameBoundary();
    if (!after.ok) throw after.error;
    const captured = await capture;
    if (!captured.ok) throw captured.error;
    if (env.FORGEAX_VFX_DEPTH_LATENCY_TAPE !== undefined)
      options.saveTape?.(env.FORGEAX_VFX_DEPTH_LATENCY_TAPE, captured.value.bytes);
    const decoded = decodeTape(captured.value.bytes);
    if (!decoded.ok) throw decoded.error;
    const depthModel = buildFrameModel(decoded.value);
    expect(
      changedDepthFrame,
      JSON.stringify({ phase: phase(), passes: renderer.inspect().perFramePassNames }),
    ).toEqual(depthShadow);
    expect(phase()).toBe(1);
    const depthUpdate = depthModel.works.find((work) =>
      work.pipeline?.shaders.some(
        (shader) =>
          shader.entryPoint === 'forgeax_vfx_update_main' ||
          shader.entryPoint === 'forgeax_vfx_update_compact_main',
      ),
    );
    if (depthUpdate === undefined && options.onIblFailure !== undefined) {
      iblFailureRecorded = true;
      await options.onIblFailure(
        {
          phase: 'depth-update-selection',
          capture: 'original-depth-latency-frame',
          completedFrames,
          work: depthModel.works,
          events: errors,
        },
        captured.value.bytes,
      );
    }
    const shadowWork = depthModel.works.find((work) => work.kind === 'drawIndexedIndirect');
    expect(depthUpdate).toBeDefined();
    expect(shadowWork).toBeDefined();
    const depthBinding = depthUpdate?.bindings.find(
      (binding) => binding.groupIndex === 0 && binding.binding === 13,
    );
    expect(depthBinding).toBeDefined();
    const textureForView = (view: string | null | undefined): string | undefined => {
      const descriptor = depthModel.resources.find(
        (resource) => resource.resourceId === view,
      )?.descriptor;
      return descriptor !== null &&
        typeof descriptor === 'object' &&
        !Array.isArray(descriptor) &&
        'kind' in descriptor &&
        descriptor.kind === 'createTextureView' &&
        'sourceHandleId' in descriptor &&
        typeof descriptor.sourceHandleId === 'string'
        ? descriptor.sourceHandleId
        : undefined;
    };
    const simulationDepth = textureForView(depthBinding?.resourceId);
    expect(simulationDepth).toBeDefined();
    const depthProducers = depthModel.works.filter(
      (work) =>
        work.attachments?.depthStencilViewHandleId !== null &&
        textureForView(work.attachments?.depthStencilViewHandleId) === simulationDepth,
    );
    expect(depthProducers.length).toBeGreaterThan(0);
    for (const producer of depthProducers)
      expect(producer.workIndex).toBeLessThan(depthUpdate?.workIndex ?? -1);
    expect(depthUpdate?.workIndex).toBeLessThan(shadowWork?.workIndex ?? -1);
    const meshProjection = depthModel.works.find((work) =>
      work.pipeline?.shaders.some((shader) => shader.entryPoint === 'forgeax_vfx_mesh_main'),
    );
    expect(meshProjection).toBeDefined();
    expect(meshProjection?.workIndex).toBeGreaterThan(shadowWork?.workIndex ?? Infinity);
    expect(
      textureForView(
        meshProjection?.bindings.find(
          (binding) => binding.groupIndex === 0 && binding.binding === 13,
        )?.resourceId,
      ),
    ).toBe(simulationDepth);
    expect(decoded.value.events.filter((event) => event.kind === 'submit')).toHaveLength(1);
    expect(await present()).toEqual(depthClear);
    expect(phase()).toBe(1);
    world.update(1 / 60).unwrap();
    expect(await present()).toEqual(depthClear);
    expect(phase()).toBe(2);
    expect(await present()).toEqual(depthShadow);
    // Catch-up may submit several ordered ticks together. Early shadows still
    // use the previous projection; the following draw sees only the final tick.
    world.update(1 / 60).unwrap();
    world.update(1 / 60).unwrap();
    world.update(1 / 60).unwrap();
    expect(await present()).toEqual(depthShadow);
    expect(phase()).toBe(5);
    expect(await present()).toEqual(depthClear);
    expect(phase()).toBe(5);
    if (publisher !== undefined) {
      // Queue two distinct simulation ticks without awaiting either receipt.
      // Each pixel copy is enqueued directly after its draw, before the next
      // draw overwrites the shared target. Shadows must still use tick N-1.
      const source = publisher;
      const flights = [6, 7].map((tick) => {
        world.update(1 / 60).unwrap();
        const candidate = source.prepare(0).unwrap();
        const packet = structuredClone(candidate.packet, {
          transfer: [
            ...renderPublicationTransfers(candidate.packet),
            ...renderPublicationAssetTransfers(candidate.packet),
          ],
        });
        candidate.accept();
        const submitted = renderer.draw({
          publication: packet,
          onFeatureSourceSubmitted: (identity, feedback) => {
            source
              .acknowledgeFeatures(packet.revision, [
                { identity, feedback: structuredClone(feedback) },
              ])
              .unwrap();
          },
        });
        if (!submitted.ok) throw submitted.error;
        const draw = submitted.value;
        expect(phase()).toBe(tick);
        return { packet, draw, pixels: pixel() };
      });
      for (const [index, flight] of flights.entries()) {
        const completed = await flight.draw.completed;
        if (!completed.ok) throw completed.error;
        expect(await flight.pixels).toEqual(index === 0 ? depthClear : depthShadow);
        const buffers = renderPublicationTransfers(flight.packet);
        source
          .recycle(flight.packet.revision, structuredClone(buffers, { transfer: buffers }))
          .unwrap();
      }
      expect(phase()).toBe(7);
    }
    world.despawn(depthPlayer).unwrap();
    world.update(1 / 60).unwrap();
    expect(await present()).toEqual(depthClear);
    world.despawn(receiver).unwrap();
    options.signal.throwIfAborted();
    const replayAdapter = await pack.value.rhi.requestAdapter();
    if (!replayAdapter.ok) throw replayAdapter.error;
    const replayDevice = await replayAdapter.value.requestDevice(
      replayDeviceRequest(decoded.value, replayAdapter.value.features, replayAdapter.value.limits),
    );
    if (!replayDevice.ok) throw replayDevice.error;
    // Native lifetime cleanup stays in this Dawn fixture, outside Render/VFX.
    const replayRaw = pack.value._internal_getRawDevice?.(replayDevice.value) as
      | GPUDevice
      | undefined;
    if (replayRaw === undefined) throw new Error('Missing native replay device');
    try {
      const replay = await openReplay(decoded.value, {
        device: replayDevice.value,
        createShaderModule: pack.value.createShaderModule,
      });
      if (!replay.ok) throw replay.error;
      let disposalError: unknown;
      try {
        const lastWork = depthModel.works.at(-1);
        if (lastWork === undefined) throw new Error('Missing captured output work');
        const inspection = await replay.value.inspectWork(lastWork.workIndex, ['pixels']);
        if (!inspection.ok) throw inspection.error;
        const attachment = inspection.value.attachment;
        if (attachment === undefined) throw new Error('Missing replay pixels');
        expect(attachment.width).toBe(64);
        expect(attachment.height).toBe(64);
        const offset = (32 * 64 + 32) * 4;
        expect([...attachment.bytes.slice(offset, offset + 4)]).toEqual(changedDepthFrame);
      } finally {
        const disposed = await replay.value.dispose();
        if (!disposed.ok) disposalError = disposed.error;
      }
      if (disposalError !== undefined) throw disposalError;
    } finally {
      replayRaw.destroy();
    }
    if (options.sampledTextureLimit !== undefined) {
      expect(device?.limits.maxSampledTexturesPerShaderStage).toBe(options.sampledTextureLimit);
    }
    expect(errors).toEqual([]);
  } finally {
    cleanupStarted = true;
    publisher?.dispose();
    if (vfxAttached) await vfx.detachWorld({ world });
    renderer.dispose();
    target?.destroy();
    await recorder.dispose();
  }
}
