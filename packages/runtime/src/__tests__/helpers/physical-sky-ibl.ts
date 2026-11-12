import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  Atmosphere,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine-render';
import { buildFrameModel, decodeTape, type RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../../scripts/test/ready-render-frame.mjs';
import { compactTape } from '../compact-tape.fixture';
import { captureForwardGtaoLinearHdr, type ForwardGtaoLinearCapture } from './forward-gtao-capture';
import { testAssets } from './runtime-assets';

export const PHYSICAL_SKY_IBL_SIZE = { width: 160, height: 96 };
type Save = (name: string, bytes: Uint8Array) => Promise<void>;
function rgb(capture: ForwardGtaoLinearCapture): Float32Array {
  const pixels = new Float32Array(capture.width * capture.height * 3);
  const view = new DataView(
    capture.bytes.buffer,
    capture.bytes.byteOffset,
    capture.bytes.byteLength,
  );
  for (let y = 0; y < capture.height; y++)
    for (let x = 0; x < capture.width; x++)
      for (let c = 0; c < 3; c++)
        pixels[(y * capture.width + x) * 3 + c] = halfFloat.f16ToF32(
          view.getUint16(y * capture.bytesPerRow + x * 8 + c * 2, true),
        );
  expect(Array.from(pixels).every(Number.isFinite)).toBe(true);
  return pixels;
}
function patch(pixels: Float32Array, x: number): number[] {
  const result = [0, 0, 0];
  for (let y = 44; y <= 52; y++)
    for (let px = x - 4; px <= x + 4; px++)
      for (let c = 0; c < 3; c++)
        result[c] =
          (result[c] ?? 0) + (pixels[(y * PHYSICAL_SKY_IBL_SIZE.width + px) * 3 + c] ?? 0) / 81;
  return result;
}
const energy = (value: readonly number[]) => value.reduce((sum, v) => sum + v, 0) / 3;
function maxDelta(a: Float32Array, b: Float32Array): number {
  let maximum = 0;
  for (let i = 0; i < a.length; i++)
    maximum = Math.max(maximum, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return maximum;
}
async function captureSkyWork(
  recorder: RecorderAttachment,
  draw: () => Promise<unknown>,
  save: Save,
  name: string,
  ibl: boolean,
) {
  const pending = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  try {
    await draw();
  } finally {
    (await recorder.frameBoundary()).unwrap();
  }
  const tape = compactTape((await pending).unwrap());
  await save(`${name}.rhitape`, tape.bytes);
  const decoded = decodeTape(tape.bytes).unwrap(),
    model = buildFrameModel(decoded);
  const entries = model.works.flatMap((work) =>
    work.pipeline.shaders
      .filter((shader) => shader.stage === 'fragment')
      .map((shader) => shader.entryPoint),
  );
  expect(entries.filter((entry) => entry === 'atmosphere_cubemap_fs')).toHaveLength(ibl ? 6 : 0);
  expect(entries.filter((entry) => entry === 'atmosphere_irradiance_fs')).toHaveLength(ibl ? 6 : 0);
  if (ibl) {
    const cube = model.works.filter((work) =>
      work.pipeline.shaders.some((shader) => shader.entryPoint === 'atmosphere_cubemap_fs'),
    );
    const uniformIds = cube.map(
      (work) =>
        work.bindings.find((binding) => binding.groupIndex === 0 && binding.binding === 0)
          ?.resourceId,
    );
    expect(uniformIds.every((id) => id !== undefined)).toBe(true);
    expect(new Set(uniformIds).size).toBe(1);
    const sourceTexture = (id: string | undefined) => {
      const resource = decoded.bootstrap.find((resource) => resource.handleId === id);
      const created = resource?.create;
      return created?.kind === 'createTextureView' ? created.sourceHandleId : undefined;
    };
    const cubeSources = cube.map((work) => sourceTexture(work.attachments.colorViewHandleIds[0]));
    expect(cubeSources.every((id) => id !== undefined)).toBe(true);
    expect(new Set(cubeSources).size).toBe(1);
    const irradiance = model.works.filter((work) =>
      work.pipeline.shaders.some((shader) => shader.entryPoint === 'atmosphere_irradiance_fs'),
    );
    for (const work of irradiance)
      expect(
        sourceTexture(
          work.bindings.find((binding) => binding.groupIndex === 0 && binding.binding === 0)
            ?.resourceId,
        ),
      ).toBe(cubeSources[0]);
  }

  expect(
    decoded.bootstrap.some((resource) =>
      JSON.stringify(resource.create).includes('atmosphere-aerial-'),
    ),
  ).toBe(false);
  return {
    digest: tape.digest,
    cubeFaces: entries.filter((entry) => entry === 'atmosphere_cubemap_fs').length,
    entries,
  };
}

/** All direct light channels are excluded, so material changes prove sky IBL. */
export async function verifyPhysicalSkyIbl(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: Save,
  image: (name: string, capture: ForwardGtaoLinearCapture) => Promise<void>,
  recover?: () => Promise<void>,
) {
  const world = new World();
  const assets = testAssets(world);
  const mesh = assets.create(createBoxGeometry(0.65, 0.65, 0.65).unwrap()).unwrap();
  for (const [x, metallic, roughness] of [
    [-0.7, 0, 0.8],
    [0.7, 1, 0.08],
  ] as const) {
    const material = assets
      .create(Materials.standard({ baseColor: [0.7, 0.7, 0.7, 1], metallic, roughness }))
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [x, 1, -0.6] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material], lightingChannels: 1 } },
      )
      .unwrap();
  }
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 1, 3] } },
      {
        component: Camera,
        data: {
          aspect: PHYSICAL_SKY_IBL_SIZE.width / PHYSICAL_SKY_IBL_SIZE.height,
          fov: 0.75,
          near: 0.1,
          far: 10000,
          antialias: 0,
          bloom: 0,
          exposure: 1 / 5000,
          tonemap: TONEMAP_ACES_FILMIC,
        },
      },
    )
    .unwrap();
  const sun = world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0, -0.6, 0.8],
        intensity: 100000,
        lightingChannels: 2,
        castShadow: false,
      },
    })
    .unwrap();
  let atmosphere = world.spawn({ component: Atmosphere, data: { backgroundOnly: true } }).unwrap();
  const lease = renderer.attach(world).unwrap();
  const errors: unknown[] = [];
  let recovering = false,
    expectedLosses = 0;
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind !== 'error') return;
    const cause = (event.error as { detail?: { cause?: { code?: string } } }).detail?.cause;
    if (recovering && cause?.code === 'device-lost') expectedLosses++;
    else errors.push(event.error);
  });
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    return drawReadyFrame(renderer, { leases: [lease], camera: { lease }, environment: { lease } });
  };
  const observations: unknown[] = [];
  const sample = async (name: string, ibl: boolean) => {
    const work = await captureSkyWork(recorder, draw, save, name, ibl);
    for (let frame = 0; frame < 60; frame++) await draw();
    const capture = await captureForwardGtaoLinearHdr(renderer, draw);
    await image(name, capture);
    const pixels = rgb(capture);
    const diffuse = patch(pixels, 56),
      specular = patch(pixels, 104);
    observations.push({
      name,
      receipt: capture.receipt,
      completedFrames: 60,
      diffuse,
      specular,
      work,
    });
    expect(errors).toEqual([]);
    return pixels;
  };
  try {
    const dark = await sample('no-skylight', false);
    expect(energy(patch(dark, 56))).toBeLessThan(0.001);
    expect(energy(patch(dark, 104))).toBeLessThan(0.001);
    const sky = world
      .spawn(
        { component: Transform, data: { pos: [0, 1, 0] } },
        { component: Skylight, data: { intensity: 1 } },
      )
      .unwrap();
    const day = await sample('day', true);
    const reference = Math.max(...patch(day, 56), ...patch(day, 104));
    expect(energy(patch(day, 56))).toBeGreaterThan(5);
    expect(energy(patch(day, 104))).toBeGreaterThan(5);
    expect(maxDelta(day, await sample('day-repeat', false))).toBeLessThan(
      Math.max(0.001, reference * 0.0001),
    );
    world.set(camera, Transform, { pos: [0.2, 1, 3] }).unwrap();
    await sample('camera-moved', false);
    world.set(camera, Transform, { pos: [0, 1, 3] }).unwrap();
    world.set(sun, DirectionalLight, { direction: [0, -0.1, 0.995] }).unwrap();
    const sunset = await sample('sunset', true);
    expect(Math.abs(energy(patch(day, 56)) - energy(patch(sunset, 56)))).toBeGreaterThan(
      reference * 0.01,
    );
    world.set(sun, DirectionalLight, { direction: [0, -0.6, 0.8] }).unwrap();
    const restored = await sample('sun-restored', true);
    expect(maxDelta(day, restored)).toBeLessThan(Math.max(0.001, reference * 0.0001));
    world.removeComponent(sky, Skylight).unwrap();
    const disabled = await sample('disabled', false);
    expect(energy(patch(disabled, 56))).toBeLessThan(0.001);
    expect(energy(patch(disabled, 104))).toBeLessThan(0.001);
    world.addComponent(sky, { component: Skylight, data: { intensity: 1 } }).unwrap();
    expect(maxDelta(day, await sample('reenabled', false))).toBeLessThan(
      Math.max(0.001, reference * 0.0001),
    );
    world.set(atmosphere, Atmosphere, { mieScattering: 200e-6 }).unwrap();
    const haze = await sample('haze', true);
    expect(Math.abs(energy(patch(haze, 56)) - energy(patch(day, 56)))).toBeGreaterThan(
      reference * 0.01,
    );
    world.set(atmosphere, Atmosphere, { mieScattering: 3.996e-6 }).unwrap();
    await sample('medium-restored', true);
    world.despawn(atmosphere).unwrap();
    const solid = await sample('atmosphere-removed', false);
    expect(energy(patch(solid, 56))).toBeLessThan(2);
    atmosphere = world.spawn({ component: Atmosphere, data: { backgroundOnly: true } }).unwrap();
    expect(maxDelta(day, await sample('recovered', true))).toBeLessThan(
      Math.max(0.001, reference * 0.0001),
    );
    if (recover !== undefined) {
      const generation = (await draw()).deviceGeneration;
      recovering = true;
      await recover();
      recovering = false;
      expect(expectedLosses).toBe(1);
      expect(maxDelta(day, await sample('device-recovered', true))).toBeLessThan(
        Math.max(0.001, reference * 0.0001),
      );
      expect((await draw()).deviceGeneration).toBe(generation + 1);
    }
    await save(
      'evidence.json',
      new TextEncoder().encode(
        JSON.stringify({ exposure: 1 / 5000, isolatedDirectLightChannels: true, observations }),
      ),
    );
  } catch (error) {
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    try {
      await draw();
    } catch {
      /* Preserve failing work. */
    }
    (await recorder.frameBoundary()).unwrap();
    const tape = await pending;
    if (tape.ok) await save('failure.rhitape', compactTape(tape.value).bytes);
    await save(
      'failure.json',
      new TextEncoder().encode(JSON.stringify({ error: String(error), errors, observations })),
    );
    throw error;
  } finally {
    unsubscribe();
    lease.dispose();
  }
}
