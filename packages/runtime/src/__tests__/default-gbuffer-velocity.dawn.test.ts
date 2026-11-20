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

it.each([
  { antialias: ANTIALIAS_NONE, scale: 1, name: 'no temporal AA' },
  { antialias: ANTIALIAS_TAA, scale: 1, name: 'TAA' },
  { antialias: ANTIALIAS_TAA, scale: 0.75, name: 'TAAU' },
  { antialias: ANTIALIAS_TSR, scale: 1, name: 'TSR' },
])('writes object velocity with depth and reconstructs camera velocity on static foreground ($name)', async ({
  antialias,
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
          renderPath: 'deferred',
          gbufferFormat: 'default',
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
        data: { direction: [0, 0, -1], castShadow: false },
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
      return drawReadyFrame(renderer, { source, geometryLane: 'direct' });
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
    if (antialias !== ANTIALIAS_NONE)
      expect(inspection.temporal).toMatchObject({ historyValid: true });
    expect(inspection.motionBlur).toMatchObject({ status: 'active' });
    const tape = decodeTape((await pending).unwrap().bytes).unwrap();
    const model = buildFrameModel(tape);
    const raw = model.works.find((work) =>
      work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_scene_velocity'),
    );
    const blur = model.works.find((work) =>
      work.pipeline.shaders.some(
        (shader) =>
          shader.source?.includes('fn sceneTemporalFromVelocity') &&
          shader.entryPoint === 'reconstruct',
      ),
    );
    expect(blur).toBeDefined();
    const resolved = model.works.find((work) =>
      work.pipeline.shaders.some(
        (shader) =>
          shader.source?.includes('fn sceneTemporalFromVelocity') &&
          (shader.entryPoint === 'fs_main' || shader.entryPoint === 'tsr_reconstruct'),
      ),
    );
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
            ? work?.bindings.find((binding) => binding.binding === 10 + location)?.resourceId
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
      expect(object(34, 0)).toBe(0);
      const word = object(47, 0);
      // SM5 gamma companding of NDC +0.1875 with zero Y displacement.
      expect(word >>> 16).toBe(32767);
      expect(word & 65535).toBe(Math.round(Math.sqrt(0.375) * 0.2495 * 65535 + 32767));
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
