import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_NONE,
  BLOOM_DISABLED,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  type RenderResult,
  TONEMAP_ACES_FILMIC,
  TONEMAP_NONE,
  VolumetricFog,
  VolumetricFogSamplingValue,
} from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, scenePlugin, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { collectWebGpuValidationErrors } from './webgpu-validation.fixture';

const SIZE = 64;
const EVIDENCE = 'artifacts/pr-evidence/volumetric-fog-tonemap';

function value<T, E>(result: RenderResult<T, E>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

async function save(name: string, bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  await commands.writeFile(`${EVIDENCE}/${name}`, btoa(binary), 'base64');
}

function meanBlue(pixels: Uint8ClampedArray) {
  let sum = 0;
  for (let y = 24; y < 40; y++)
    for (let x = 24; x < 40; x++) sum += (pixels[(y * SIZE + x) * 4 + 2] ?? 0) / 255;
  return sum / 256;
}

it.each([
  'forward',
  'deferred',
] as const)('keeps local volume work and pixels through none → ACES → none in %s', {
  timeout: 240_000,
}, async (renderPath) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  document.body.append(canvas);
  const recorder = attachRecorder(webgpu).unwrap();
  const validation = collectWebGpuValidationErrors();
  const { renderer } = value(
    await constructRuntimeRendererHost(
      canvas,
      {
        rhi: recorder.backend.rhi,
        rhiInstrumentation: {
          resolveSurfaceDevice: recorder.backend.unwrapDeviceForSurface,
        },
      },
      { shaderManifestUrl: '/shaders/manifest.json' },
    ),
  );
  value(renderer.setProfile({ ...renderer.inspect().profile, renderPath }));
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const density = world.allocSharedRef('TextureAsset', {
    kind: 'texture',
    shape: { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(Array.from({ length: 8 }, () => [64, 128, 255, 255]).flat()),
  });
  const mesh = world.allocSharedRef('MeshAsset', createBoxGeometry(8, 8, 1).unwrap());
  const material = world.allocSharedRef('MaterialAsset', Materials.unlit([0, 0, 0, 1]));
  try {
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: {
            fov: 0.9,
            aspect: 1,
            near: 0.1,
            far: 20,
            tonemap: TONEMAP_NONE,
            antialias: ANTIALIAS_NONE,
            bloom: BLOOM_DISABLED,
            exposure: 1,
            clearColor: [0, 0, 0, 1],
          },
        },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, -2] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    const light = world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, -1], intensity: 4, castShadow: false },
      })
      .unwrap();
    const lease = value(renderer.attach(world));
    const surface = new OffscreenCanvas(SIZE, SIZE);
    const context = surface.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('volume tonemap readback unavailable');
    let completedFrames = 0;
    const draw = async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const receipt = value(
        renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
      );
      context.drawImage(canvas, 0, 0);
      value(await receipt.completed);
      completedFrames++;
    };
    const capture = async (stage: string, frames: number) => {
      for (let frame = 1; frame < frames; frame++) await draw();
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      await draw();
      (await recorder.frameBoundary()).unwrap();
      const captured = (await pending).unwrap();
      const model = buildFrameModel(decodeTape(captured.bytes).unwrap());
      const volumeWorks = model.works
        .filter((work) =>
          work.pipeline.shaders.some((shader) => shader.entryPoint?.startsWith('volume_')),
        )
        .map((work) => ({
          workIndex: work.workIndex,
          shaders: work.pipeline.shaders.map((shader) => shader.entryPoint),
          bindings: work.bindings,
        }));
      const blue = meanBlue(context.getImageData(0, 0, SIZE, SIZE).data);
      const inspection = renderer.inspect().volumetricFog;
      await save(`${renderPath}-${stage}.rhitape`, captured.bytes);
      await save(
        `${renderPath}-${stage}.png`,
        new Uint8Array(await (await surface.convertToBlob()).arrayBuffer()),
      );
      const report = {
        completedFrames,
        blue,
        inspection,
        digest: captured.digest,
        volumeWorks,
        resources: model.resources.map(({ consumers: _consumers, ...resource }) => resource),
        unseededResources: model.unseededResources,
        validation,
        errors,
      };
      await commands.writeFile(
        `${EVIDENCE}/${renderPath}-${stage}.json`,
        `${JSON.stringify(report, null, 2)}\n`,
      );
      return report;
    };
    const empty = await capture('empty', 4);
    const fog = world
      .spawn({
        component: VolumetricFog,
        data: {
          light,
          density,
          sampling: VolumetricFogSamplingValue.densityAlbedo,
          boundsMin: [-1.5, -1.5, -1],
          boundsMax: [1.5, 1.5, 2],
          extinction: [0.5, 0.5, 0.5],
          albedo: [1, 1, 1],
          anisotropy: 0,
          maxDistance: 20,
        },
      })
      .unwrap();
    const none = await capture('none', 18);
    world.set(camera, Camera, { tonemap: TONEMAP_ACES_FILMIC }).unwrap();
    const aces = await capture('aces', 18);
    world.set(camera, Camera, { tonemap: TONEMAP_NONE }).unwrap();
    const restored = await capture('none-restored', 18);
    world.despawn(fog).unwrap();
    const cleared = await capture('cleared', 2);

    // Capture the complete failing lifecycle before asserting. ACES is the
    // positive control; black output or missing volume work cannot pass.
    for (const report of [none, aces, restored]) {
      expect(report.volumeWorks).toHaveLength(4);
      expect(report.inspection).toMatchObject({ status: 'available', ownerCount: 1 });
      expect(report.blue - empty.blue).toBeGreaterThan(0.03);
    }
    expect(Math.abs(restored.blue - none.blue)).toBeLessThan(0.005);
    expect(cleared.inspection).toMatchObject({ status: 'off', ownerCount: 0, memoryBytes: 0 });
    expect(cleared.volumeWorks).toHaveLength(0);
    expect(Math.abs(cleared.blue - empty.blue)).toBeLessThan(0.005);
    expect(completedFrames).toBe(60);
    expect(validation).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    off();
    value(await renderer.dispose());
    await scene.fiber.dispose();
    world.sharedRefs.release(mesh).unwrap();
    world.sharedRefs.release(material).unwrap();
    world.sharedRefs.release(density).unwrap();
    (await recorder.dispose()).unwrap();
    canvas.remove();
  }
});
