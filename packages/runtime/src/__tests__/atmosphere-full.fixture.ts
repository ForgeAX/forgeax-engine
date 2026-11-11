import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createPrimitiveMesh } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  AmbientOcclusion,
  Atmosphere,
  Camera,
  CubeCamera,
  DirectionalLight,
  Fog,
  Materials,
  MeshFilter,
  MeshRenderer,
  PlanarReflection,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { commands, page } from 'vitest/browser';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { compactTape } from './compact-tape.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const WIDTH = 97,
  HEIGHT = 65;
const EVIDENCE = 'artifacts/ci-focus/atmosphere-full';
export async function saveAtmosphere(name: string, bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  await commands.writeFile(`${EVIDENCE}/${name}`, btoa(binary), 'base64');
}
export function atmosphereImageError(a: Uint8Array, b: Uint8Array) {
  expect(a.length).toBe(b.length);
  const errors = Array.from(a, (_, i) =>
    i % 4 === 3 ? undefined : Math.abs((a[i] ?? 0) - (b[i] ?? 0)) / 255,
  )
    .filter((x): x is number => x !== undefined)
    .sort((a, b) => a - b);
  return {
    p95: errors[Math.floor(errors.length * 0.95)] ?? 0,
    p99: errors[Math.floor(errors.length * 0.99)] ?? 0,
    max: errors.at(-1) ?? 0,
    changed: errors.filter((x) => x > 3 / 255).length,
  };
}

function assertAerialRois(backend: string, day: Uint8Array, noAerial: Uint8Array): void {
  for (const [centerX, centerY] of [
    [36, 32],
    [65, 32],
    [36, 17],
  ] as const) {
    let delta = 0;
    for (let y = centerY - 3; y <= centerY + 3; y++)
      for (let x = centerX - 2; x <= centerX + 2; x++)
        for (let c = 0; c < 3; c++)
          delta += Math.abs(
            (day[(y * WIDTH + x) * 4 + c] ?? 0) - (noAerial[(y * WIDTH + x) * 4 + c] ?? 0),
          );
    expect(delta, `${backend} finite transport ROI ${centerX}`).toBeGreaterThan(20);
  }
}

function assertVacuumForeground(vacuum: Uint8Array, off: Uint8Array): void {
  for (let y = 30; y <= 34; y++)
    for (let x = 34; x <= 38; x++)
      for (let c = 0; c < 3; c++)
        expect(
          Math.abs((vacuum[(y * WIDTH + x) * 4 + c] ?? 0) - (off[(y * WIDTH + x) * 4 + c] ?? 0)),
        ).toBeLessThanOrEqual(1);
}

/** Real Renderer and production materials on each backend; measurements are completed images, not CPU-rendered references. */
export async function fullAtmosphereCases(backend: 'webgpu' | 'wgpu-webgl2') {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.body.append(canvas);
  const previous = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  if (backend === 'wgpu-webgl2')
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  const recorder = attachRecorder(backend === 'webgpu' ? webgpu : wgpu).unwrap();
  let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>> | undefined;
  let lossRequested = false,
    lossErrors = 0;
  try {
    host = await constructRuntimeRendererHost(canvas, {
      rhi: recorder.backend.rhi,
      rhiInstrumentation: {
        resolveSurfaceDevice: (device) =>
          ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
      },
    });
    if (!host.ok) throw host.error;
    const { renderer, assets } = host.value;
    expect(renderer.inspect().capabilities.backendKind).toBe(backend);
    const gl = backend === 'wgpu-webgl2' ? canvas.getContext('webgl2') : null;
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    await commands.writeFile(
      `${EVIDENCE}/${backend}-capabilities.json`,
      JSON.stringify(
        {
          capabilities: renderer.inspect().capabilities,
          limits: renderer.inspect().limits,
          renderer: gl?.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
          vendor: gl?.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR),
        },
        null,
        2,
      ),
    );
    const world = new World({ assets });
    const geometry = assets.create(createBoxGeometry(800, 800, 800).unwrap()).unwrap();
    for (const [position, source] of [
      [[-900, 400, -4000], Materials.unlit([4000, 500, 100, 1])],
      [[0, 400, -4000], Materials.standard({ baseColor: [0.4, 0.5, 0.8, 1], roughness: 0.4 })],
      [
        [900, 400, -3000],
        Materials.unlit([1500, 3000, 200, 0.65], {
          queue: 3000,
          renderState: {
            depthWriteEnabled: false,
            cullMode: 'none',
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        }),
      ],
    ] as const) {
      const material = assets.create(source).unwrap();
      world
        .spawn(
          { component: Transform, data: { pos: position } },
          { component: MeshFilter, data: { assetHandle: geometry } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
    }
    const spriteMaterial = assets
      .create({
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'forgeax::sprite' },
            renderState: {
              tags: { LightMode: 'Forward' },
              queue: 3000,
              depthWriteEnabled: false,
              cullMode: 'none',
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            },
          },
        ],
        parameters: [
          { name: 'baseColorTexture', type: 'texture' },
          { name: 'colorTint', type: 'color' },
          { name: 'region', type: 'vec4' },
          { name: 'pivotAndSize', type: 'vec4' },
          { name: 'slicesAndMode', type: 'vec4' },
          { name: 'flipX', type: 'f32', default: 0 },
          { name: 'flipY', type: 'f32', default: 0 },
        ],
        values: {
          colorTint: [4000, 1000, 300, 0.7],
          region: [0, 0, 1, 1],
          pivotAndSize: [0.5, 0.5, 1, 1],
          slicesAndMode: [0, 0, 0, 0],
        },
      })
      .unwrap();
    const spriteGeometry = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [-900, 1400, -4000], scale: [800, 800, 1] } },
        { component: MeshFilter, data: { assetHandle: spriteGeometry } },
        { component: MeshRenderer, data: { materials: [spriteMaterial] } },
      )
      .unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 400, 0] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            aspect: WIDTH / HEIGHT,
            near: 0.1,
            far: 20000,
            exposure: 1 / 5000,
            tonemap: TONEMAP_ACES_FILMIC,
          },
        },
      )
      .unwrap();
    const sun = world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0, -0.6, 0.8], intensity: 100000, castShadow: false },
      })
      .unwrap();
    world.spawn({ component: Skylight, data: {} }).unwrap();
    const lease = renderValue(renderer.attach(world));
    const errors: unknown[] = [];
    const unsubscribe = renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      const cause = (event.error as { detail?: { cause?: { code?: string } } }).detail?.cause;
      if (lossRequested && cause?.code === 'device-lost') {
        lossErrors++;
        return;
      }
      errors.push(event.error);
      if (errors.length <= 3) console.error('[full-atmosphere-error]', JSON.stringify(event.error));
    });
    const request = { leases: [lease], camera: { lease }, environment: { lease } };
    const draw = async (observe = false) => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      return drawReadyFrame(renderer, request, observe ? ['final-display'] : undefined);
    };
    const sample = async (name: string) => {
      const receipt = await draw(true);
      const image = renderValue(
        await renderer.observe(receipt, { include: ['final-display'] }),
      ).observations?.find((row) => row.domain === 'final-display');
      if (image === undefined) throw new Error('Missing completed full atmosphere display');
      const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
      for (let y = 0; y < HEIGHT; y++)
        bytes.set(
          image.bytes.subarray(
            y * image.metadata.bytesPerRow,
            y * image.metadata.bytesPerRow + WIDTH * 4,
          ),
          y * WIDTH * 4,
        );
      // Observations retain their physical channel order; compare canonical RGBA.
      if (image.metadata.format.startsWith('bgra'))
        for (let i = 0; i < bytes.length; i += 4) {
          const red = bytes[i + 2] ?? 0;
          bytes[i + 2] = bytes[i] ?? 0;
          bytes[i] = red;
        }
      await saveAtmosphere(`${backend}-${name}.rgba8`, bytes);
      const shot = await page.elementLocator(canvas).screenshot({ base64: true });
      await commands.writeFile(
        `${EVIDENCE}/${backend}-${name}.png`,
        typeof shot === 'string' ? shot : shot.base64,
        'base64',
      );
      expect(errors).toEqual([]);
      return bytes;
    };
    const capture = async (name: string) => {
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      let failure: unknown;
      try {
        await draw();
      } catch (cause) {
        failure = cause;
      } finally {
        (await recorder.frameBoundary()).unwrap();
      }
      const tape = compactTape((await pending).unwrap());
      await saveAtmosphere(`${backend}-${name}.rhitape`, tape.bytes);
      if (failure !== undefined) throw failure;
      return buildFrameModel(decodeTape(tape.bytes).unwrap());
    };
    try {
      const off = await sample('off');
      const atmosphere = world.spawn({ component: Atmosphere, data: {} }).unwrap();
      const cold = await capture('startup');
      const entries = cold.works.flatMap((work) =>
        work.pipeline.shaders.map((shader) => shader.entryPoint),
      );
      const expected =
        backend === 'webgpu'
          ? 'atmosphere_aerial_perspective'
          : 'atmosphere_packed_aerial_fragment';
      expect(entries).toContain(expected);
      if (backend === 'wgpu-webgl2') {
        expect(cold.works.some((work) => work.kind === 'dispatchWorkgroups')).toBe(false);
        expect(entries).toContain('atmosphere_packed_medium_fragment');
        expect(entries).toContain('atmosphere_distant_sky_light_fragment');
      }
      for (let frame = 1; frame < 60; frame++) expect((await draw()).presentation).toBe('ready');
      const day = await sample('day');
      expect(atmosphereImageError(day, off).changed).toBeGreaterThan(1000);
      // One-shot observation copies change graph topology. Settle the ordinary
      // graph before measuring steady-state table work.
      await draw();
      const warm = await capture('warm');
      const warmEntries = warm.works.flatMap((work) =>
        work.pipeline.shaders.map((shader) => shader.entryPoint),
      );
      expect(warmEntries).not.toContain(expected);
      expect(warmEntries).not.toContain('atmosphere_transmittance');
      expect(warmEntries).not.toContain('atmosphere_transmittance_fragment');
      expect(warmEntries).not.toContain('atmosphere_packed_medium_fragment');
      const initial = structuredClone(world.get(atmosphere, Atmosphere).unwrap());
      world
        .set(atmosphere, Atmosphere, {
          rayleighScattering: [0, 0, 0],
          mieScattering: 0,
          mieAbsorption: 0,
          absorption: [0, 0, 0],
        })
        .unwrap();
      const vacuum = await sample('zero-medium');
      assertVacuumForeground(vacuum, off);
      world.set(atmosphere, Atmosphere, initial).unwrap();
      expect(atmosphereImageError(day, await sample('medium-restored')).max).toBe(0);
      const fogEntity = world
        .spawn({
          component: Fog,
          data: { color: [0.1, 0.15, 0.2], density: 0.00003, maxOpacity: 0.8 },
        })
        .unwrap();
      const fog = await sample('height-fog');
      expect(atmosphereImageError(day, fog).changed).toBeGreaterThan(100);
      world.despawn(fogEntity).unwrap();
      expect(atmosphereImageError(day, await sample('fog-removed')).max).toBe(0);
      world
        .addComponent(camera, {
          component: AmbientOcclusion,
          data: { radius: 500, thickness: 300 },
        })
        .unwrap();
      const ao = await sample('ambient-occlusion');
      world.removeComponent(camera, AmbientOcclusion).unwrap();
      expect(atmosphereImageError(day, await sample('ao-removed')).max).toBe(0);
      world.set(atmosphere, Atmosphere, { aerialPerspectiveDistanceScale: 0 }).unwrap();
      await capture('aerial-disabled');
      const noAerial = await sample('aerial-disabled');
      // The left opaque Unlit box and right blended Unlit box have no solar BRDF.
      // Their changes isolate finite-distance transport from the sky and PBR.
      assertAerialRois(backend, day, noAerial);
      world.set(atmosphere, Atmosphere, { aerialPerspectiveDistanceScale: 1 }).unwrap();
      expect(atmosphereImageError(day, await sample('restored-aerial')).max).toBe(0);
      world.set(sun, DirectionalLight, { direction: [0, -0.02, 0.99979998] }).unwrap();
      const sunset = await sample('sunset');
      expect(atmosphereImageError(day, sunset).changed).toBeGreaterThan(1000);
      world.set(sun, DirectionalLight, { direction: [0, -0.6, 0.8] }).unwrap();
      world.set(camera, Transform, { pos: [0, 20000, 0] }).unwrap();
      const high = await sample('high');
      expect(atmosphereImageError(day, high).changed).toBeGreaterThan(1000);
      world.set(camera, Transform, { pos: [0, 400, 0] }).unwrap();
      expect(atmosphereImageError(day, await sample('camera-return')).max).toBe(0);
      canvas.width = WIDTH + 8;
      canvas.height = HEIGHT + 8;
      await draw();
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      expect(atmosphereImageError(day, await sample('resized')).max).toBe(0);
      const makeCube = () => {
        const target = renderValue(
          renderer.createRenderTarget({
            shape: 'cube',
            width: 16,
            height: 16,
            format: 'rgba16float',
            sampleCount: 1,
            mipLevels: 1,
            sampled: true,
            readback: true,
          }),
        );
        const writer = world
          .spawn(
            { component: Transform, data: { pos: [0, 400, 0] } },
            {
              component: CubeCamera,
              data: {
                target: world.allocSharedRef('RenderTarget', target),
                near: 0.1,
                far: 20000,
                faceBudget: 1,
              },
            },
          )
          .unwrap();
        return { target, writer };
      };
      const targetPixels = async (target: ReturnType<typeof makeCube>['target'], layers = 6) => {
        const tickets = Array.from({ length: layers }, (_, layer) =>
          renderValue(renderer.requestTargetReadback(target, { mipLevel: 0, layer })),
        );
        const receipt = await draw();
        const observed = renderValue(
          await renderer.observe(receipt, {
            include: ['target-readbacks'],
            targetReadbacks: tickets,
          }),
        );
        return tickets.flatMap((ticket, face) => {
          const data = observed.targetReadbacks?.find((row) => row.ticket === ticket);
          if (data === undefined) throw new Error(`Missing completed cube face ${face}`);
          const view = new DataView(
            data.bytes.buffer,
            data.bytes.byteOffset,
            data.bytes.byteLength,
          );
          return Array.from({ length: 16 * 16 * 3 }, (_, index) => {
            const pixel = Math.floor(index / 3),
              x = pixel % 16,
              y = Math.floor(pixel / 16);
            return halfFloat.f16ToF32(
              view.getUint16(y * data.bytesPerRow + x * 8 + (index % 3) * 2, true),
            );
          });
        });
      };
      const planarTarget = renderValue(
        renderer.createRenderTarget({
          shape: '2d',
          width: 16,
          height: 16,
          format: 'rgba16float',
          sampleCount: 1,
          mipLevels: 1,
          sampled: true,
          readback: true,
        }),
      );
      world
        .addComponent(camera, {
          component: PlanarReflection,
          data: { target: world.allocSharedRef('RenderTarget', planarTarget) },
        })
        .unwrap();
      await capture('planar');
      const planar = await targetPixels(planarTarget, 1);
      expect(planar.every(Number.isFinite)).toBe(true);
      expect(Math.max(...planar)).toBeGreaterThan(10);
      await commands.writeFile(`${EVIDENCE}/${backend}-planar.json`, JSON.stringify(planar));
      world.removeComponent(camera, PlanarReflection).unwrap();
      renderValue(renderer.destroyRenderTarget(planarTarget));
      const firstCube = makeCube();
      await capture('first-cube');
      for (let frame = 0; frame < 20; frame++) await draw();
      const cube = await targetPixels(firstCube.target);
      expect(cube.every(Number.isFinite)).toBe(true);
      expect(Math.max(...cube)).toBeGreaterThan(10);
      world.despawn(firstCube.writer).unwrap();
      const pinnedCube = makeCube();
      await draw();
      await draw();
      world.set(sun, DirectionalLight, { direction: [0, -0.02, 0.99979998] }).unwrap();
      await capture('pinned-cube-sunset-display');
      for (let frame = 0; frame < 20; frame++) await draw();
      const pinned = await targetPixels(pinnedCube.target);
      expect(pinned).toEqual(cube);
      await commands.writeFile(
        `${EVIDENCE}/${backend}-cube.json`,
        JSON.stringify({ cube, pinned }),
      );
      world.despawn(pinnedCube.writer).unwrap();
      renderValue(renderer.destroyRenderTarget(firstCube.target));
      renderValue(renderer.destroyRenderTarget(pinnedCube.target));
      world.set(sun, DirectionalLight, { direction: [0, -0.6, 0.8] }).unwrap();
      if (backend === 'wgpu-webgl2') {
        const generation = (await draw()).deviceGeneration;
        const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
        if (!extension) throw new Error('Actual WebGL context-loss extension required');
        lossRequested = true;
        extension.loseContext();
        await expect.poll(() => renderer.state()).toBe('device-lost');
        const restored = new Promise<void>((resolve) =>
          canvas.addEventListener('webglcontextrestored', () => resolve(), { once: true }),
        );
        extension.restoreContext();
        await restored;
        renderValue(await renderer.recover());
        expect((await draw()).deviceGeneration).toBe(generation + 1);
        for (let frame = 1; frame < 60; frame++) await draw();
        lossRequested = false;
        expect(lossErrors).toBe(1);
        expect(atmosphereImageError(day, await sample('recovered')).max).toBe(0);
      }
      world.despawn(atmosphere).unwrap();
      expect(atmosphereImageError(off, await sample('removed')).max).toBe(0);
      expect(errors).toEqual([]);
      return { day, noAerial, sunset, high, cube, vacuum, fog, ao, planar };
    } finally {
      unsubscribe();
      lease.dispose();
    }
  } finally {
    if (host?.ok) renderValue(await host.value.renderer.dispose());
    (await recorder.dispose()).unwrap();
    if (previous === undefined) Reflect.deleteProperty(navigator, 'gpu');
    else Object.defineProperty(navigator, 'gpu', previous);
    canvas.remove();
  }
}
