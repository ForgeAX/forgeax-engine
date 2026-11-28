import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  ANTIALIAS_NONE,
  ANTIALIAS_TAA,
  ANTIALIAS_TSR,
  Camera,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  DynamicResolution,
  Materials,
  MeshFilter,
  MeshRenderer,
  MotionBlur,
} from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { shaderPublicationUrl } from './shader-manifest-url.fixture';

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

// tsr_reconstruct writes colorOutput at binding 14 and temporalOutput (motion) at binding 15
// (twelve sampled inputs, the sampler and the params buffer come first).
const TSR_RECONSTRUCT_OUTPUT_BINDING = 14;
const temporalModes = [
  { antialias: ANTIALIAS_TAA, scale: 1, name: 'TAA' },
  { antialias: ANTIALIAS_TAA, scale: 0.75, name: 'TAAU' },
  { antialias: ANTIALIAS_TSR, scale: 1, name: 'TSR' },
] as const;

it.each([
  {
    renderPath: 'forward',
    antialias: ANTIALIAS_NONE,
    scale: 1,
    name: 'Motion Blur',
    gpu: false,
    contact: false,
  },
  {
    renderPath: 'deferred',
    antialias: ANTIALIAS_NONE,
    scale: 1,
    name: 'no temporal AA',
    gpu: false,
    contact: false,
  },
  {
    renderPath: 'forward',
    antialias: ANTIALIAS_TAA,
    scale: 1,
    name: 'GPU Scene TAA',
    gpu: true,
    contact: false,
  },
  ...temporalModes.flatMap((mode) =>
    (['forward', 'deferred'] as const).map((renderPath) => ({
      ...mode,
      renderPath,
      gpu: false,
      contact: false,
    })),
  ),
  {
    renderPath: 'forward',
    antialias: ANTIALIAS_TAA,
    scale: 1,
    name: 'contact shadows',
    gpu: false,
    contact: true,
  },
  {
    renderPath: 'forward',
    antialias: ANTIALIAS_TAA,
    scale: 1,
    name: 'GPU Scene contact shadows',
    gpu: true,
    contact: true,
  },
] as const)('writes object velocity with depth and reconstructs camera velocity on static foreground ($renderPath $name)', async ({
  antialias,
  gpu,
  contact,
  renderPath,
  scale,
}) => {
  const target = offscreenCanvas(64);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = value(
    await constructRuntimeRendererHost(
      target.canvas,
      {
        rhi: recorder.backend.rhi,
        standardProfile: {
          ...DEFAULT_STANDARD_PROFILE,
          renderPath,
          ...(renderPath === 'deferred' ? { gbufferFormat: 'default' as const } : {}),
          ambientOcclusion: { enabled: false },
        },
      },
      {
        shaderManifestUrl: shaderPublicationUrl(
          await buildEngineShaderTemplateManifest({ hdrpSsao: false }),
        ),
      },
    ),
  );
  const { renderer, assets } = host;
  try {
    value(await host.initialization);
    const world = new World({ assets });
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0, 0, -1], castShadow: false, contactShadowLength: contact ? 0.2 : 0 },
      })
      .unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: {
            projection: 1,
            left: -2,
            right: 2,
            bottom: -2,
            top: 2,
            near: 0.1,
            far: 20,
            antialias,
            bloom: 0,
          },
        },
      )
      .unwrap();
    if (scale !== 1)
      world
        .addComponent(camera, {
          component: DynamicResolution,
          data: { minScale: scale, maxScale: scale, targetGpuMs: 16.67 },
        })
        .unwrap();
    world.addComponent(camera, { component: MotionBlur, data: {} }).unwrap();
    const material = assets
      .create(
        Materials.standard({
          baseColor: [0.6, 0.6, 0.6, 1],
          emissive: [0.8, 0.3, 0.2],
        }),
      )
      .unwrap();
    const plane = (size: number, z: number) =>
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, z] } },
          {
            component: MeshFilter,
            data: { assetHandle: assets.create(createPlaneGeometry(size, 2).unwrap()).unwrap() },
          },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
    const moving = plane(2, -1);
    plane(1, 0);
    const source = value(renderer.attach(world));
    const draw = () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      return drawReadyFrame(renderer, { source, geometryLane: gpu ? 'automatic' : 'direct' });
    };
    await draw();
    world.set(moving, Transform, { pos: [-0.25, 0, -1] }).unwrap();
    await draw();
    world.set(moving, Transform, { pos: [0, 0, -1] }).unwrap();
    await draw();
    world.set(camera, Transform, { pos: [0.125, 0, 4] }).unwrap();
    world.set(moving, Transform, { pos: [0.5, 0, -1] }).unwrap();
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await draw();
    (await recorder.frameBoundary()).unwrap();
    const inspection = renderer.inspect();
    const stageFacts = JSON.stringify({
      output: inspection.output,
      passes: inspection.perFramePassNames,
      views: inspection.views?.map(({ temporal }) => temporal),
      diagnostics: inspection.featureDiagnostics,
    });
    if (antialias !== ANTIALIAS_NONE)
      expect(inspection.temporal, stageFacts).toMatchObject({ historyValid: true });
    expect(inspection.motionBlur, stageFacts).toMatchObject({ status: 'active' });
    const tape = decodeTape((await pending).unwrap().bytes).unwrap();
    const model = buildFrameModel(tape);
    if (renderPath === 'forward') {
      expect(inspection.perFramePassNames).not.toContain('standard-scene-data');
      expect(
        model.works.some((work) =>
          work.pipeline.shaders.some((shader) =>
            shader.source?.includes('fn sceneTemporalFromVelocity'),
          ),
        ),
      ).toBe(true);
    }
    const rawWriters = model.works.filter((work) =>
      work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_scene_velocity'),
    );
    const raw = rawWriters.at(-1);
    if (gpu) {
      expect(rawWriters.map((work) => work.kind)).toEqual([
        'drawIndexedIndirect',
        'drawIndexedIndirect',
      ]);
    }
    const blur = model.works.find((work) =>
      work.pipeline.shaders.some(
        (shader) =>
          shader.source?.includes('fn sceneTemporalFromVelocity') &&
          shader.entryPoint === 'reconstruct',
      ),
    );
    if (renderPath === 'deferred') expect(blur).toBeDefined();
    else {
      expect(inspection.perFramePassNames).not.toContain('gpu-driven.occlusion-cull');
      const prepass = 'standard-depth-velocity';
      if (contact) {
        const receiver = inspection.directionalShadow.forwardReceiver;
        const projected = receiver?.mode === 'screen';
        if (projected) expect(receiver).toMatchObject({ contact: true });
        const contactPass = projected ? 'forward-directional-shadow' : 'forward-contact-shadow';
        expect(inspection.perFramePassNames.indexOf(contactPass)).toBeGreaterThan(
          inspection.perFramePassNames.indexOf(prepass),
        );
        expect(inspection.perFramePassNames.indexOf(contactPass)).toBeLessThan(
          inspection.perFramePassNames.indexOf('main'),
        );
      }
      expect(inspection.perFramePassNames).toContain(prepass);
      expect(inspection.perFramePassNames.indexOf(prepass)).toBeLessThan(
        inspection.perFramePassNames.indexOf('main'),
      );
    }
    const resolved = model.works.find((work) =>
      work.pipeline.shaders.some(
        (shader) =>
          (renderPath === 'forward'
            ? shader.source?.includes('fn fs_taa_resolve') ||
              shader.entryPoint === 'tsr_reconstruct'
            : shader.entryPoint === 'tsr_reconstruct' ||
              shader.source?.includes('fn sceneTemporalFromVelocity')) &&
          (shader.entryPoint === 'fs_main' || shader.entryPoint === 'tsr_reconstruct'),
      ),
    );
    if (renderPath === 'deferred' && antialias === ANTIALIAS_TSR) {
      const dilatedVelocity = model.works.find((work) =>
        work.pipeline.shaders.some(
          (shader) =>
            shader.entryPoint === 'tsr_dilate' &&
            shader.source?.includes('fn sceneTemporalFromVelocity'),
        ),
      );
      expect(dilatedVelocity).toBeDefined();
    }
    expect(raw).toBeDefined();
    if (antialias !== ANTIALIAS_NONE) expect(resolved).toBeDefined();
    if (raw === undefined) throw new Error('Missing velocity writer');
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    const replay = (
      await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      const read = async (work: typeof raw, location: number) => {
        const id =
          work?.attachments?.colorViewHandleIds[location] ??
          (antialias === ANTIALIAS_TSR
            ? work?.bindings.find(
                (binding) => binding.binding === TSR_RECONSTRUCT_OUTPUT_BINDING + location,
              )?.resourceId
            : undefined);
        if (work === undefined || id === undefined) throw new Error('Missing velocity attachment');
        const attachment = (await replay.readResourceAtWork(id, work.workIndex)).unwrap();

        const bytes = new DataView(
          attachment.bytes.buffer,
          attachment.bytes.byteOffset,
          attachment.bytes.byteLength,
        );
        const width = attachment.width ?? 0;
        const height = attachment.height ?? 0;
        const pixel = (x: number) =>
          Math.floor((32.5 * height) / 64) * width + Math.floor(((x + 0.5) * width) / 64);
        if (attachment.format === 'r32uint') {
          expect({ width, height }).toEqual({ width: 64 * scale, height: 64 * scale });
          return (x: number) => bytes.getUint32(pixel(x) * 4, true);
        }
        expect({ width, height }).toEqual({ width: 64, height: 64 });
        return (x: number, channel: number) =>
          halfFloat.f16ToF32(bytes.getUint16(pixel(x) * 8 + channel * 2, true));
      };
      const object = await read(raw, 0);
      const staticWord = object(34, 0);
      const packedX = (word: number) => word & 0xffff;
      const packedY = (word: number) => word >>> 16;
      const expectedX = (ndc: number) =>
        Math.round(32767 + Math.sign(ndc) * Math.sqrt(2 * Math.abs(ndc)) * 0.2495 * 65535);
      if (gpu) {
        // The vertex transforms can differ by a rounding step before companding.
        expect(Math.abs(packedY(staticWord) - 32767)).toBeLessThanOrEqual(1);
        expect(Math.abs(packedX(staticWord) - expectedX(-0.0625))).toBeLessThanOrEqual(1);
      } else expect(staticWord).toBe(0);
      const word = object(47, 0);
      // SM5 gamma companding of NDC +0.1875 into two UNORM16 lanes.
      expect(packedY(word)).toBe(32767);
      expect(Math.abs(packedX(word) - expectedX(0.1875))).toBeLessThanOrEqual(1);
      if (resolved !== undefined) {
        const motion = await read(resolved, 1);
        expect(motion(34, 0)).toBeCloseTo(-0.03125, 4);
        expect(motion(47, 0)).toBeCloseTo(0.09375, 4);
        expect(motion(5, 2)).toBe(-1);
      }
    } finally {
      (await replay.dispose()).unwrap();
      webgpu.disposeDevice(device);
    }
  } finally {
    await renderer.dispose();
    target.destroy();
  }
}, 120_000);
