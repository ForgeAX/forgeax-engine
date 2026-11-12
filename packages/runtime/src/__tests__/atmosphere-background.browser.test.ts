import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Atmosphere,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { compactTape } from './compact-tape.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const WIDTH = 97,
  HEIGHT = 65;
const EVIDENCE = 'artifacts/ci-focus/atmosphere-background';
async function save(name: string, bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  await commands.writeFile(`${EVIDENCE}/${name}`, btoa(binary), 'base64');
}
function changed(a: Uint8Array, b: Uint8Array) {
  let count = 0;
  for (let i = 0; i < a.length; i++)
    if (i % 4 !== 3 && Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 3) count++;
  return count;
}

it.each(['webgpu', 'wgpu-webgl2'] as const)('renders an explicit physical sky background on %s', {
  timeout: 180_000,
}, async (backend) => {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.body.append(canvas);
  const previousGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  if (backend === 'wgpu-webgl2')
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  const recorder = attachRecorder(backend === 'webgpu' ? webgpu : wgpu).unwrap();
  let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>> | undefined;
  let signalLoss: (() => void) | undefined;
  let lossRequested = false,
    expectedLossErrors = 0;
  try {
    host = await constructRuntimeRendererHost(canvas, {
      rhi: recorder.backend.rhi,
      rhiInstrumentation: {
        deviceLost: () =>
          new Promise((resolve) => {
            signalLoss = () =>
              resolve({ reason: 'unknown', message: 'host-injected physical sky recovery' });
          }),
        resolveSurfaceDevice: (device) =>
          ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
      },
    });
    if (!host.ok) throw host.error;
    const { renderer, assets } = host.value;
    expect(renderer.inspect().capabilities.backendKind).toBe(backend);
    const world = new World({ assets });
    const geometry = assets.create(createBoxGeometry(0.8, 0.8, 0.8).unwrap()).unwrap();
    const material = assets.create(Materials.unlit([4000, 500, 100, 1])).unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [-1, 1, -3] } },
        { component: MeshFilter, data: { assetHandle: geometry } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 1, 0] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            near: 0.1,
            far: 10000,
            aspect: WIDTH / HEIGHT,
            exposure: 1 / 5000,
            tonemap: TONEMAP_ACES_FILMIC,
            clearColor: [0, 0, 0, 1],
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
    const lease = renderValue(renderer.attach(world));
    const errors: unknown[] = [];
    const unsubscribe = renderer.subscribe((event) => {
      if (event.kind === 'error') {
        const cause = (event.error as { detail?: { cause?: { code?: string } } }).detail?.cause;
        if (lossRequested && cause?.code === 'device-lost') {
          expectedLossErrors++;
          return;
        }
        errors.push(event.error);
        console.error('[sky-background-error]', JSON.stringify(event.error));
      }
    });
    const draw = async (observe = false) => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      return drawReadyFrame(
        renderer,
        { leases: [lease], camera: { lease }, environment: { lease } },
        observe ? ['final-display'] : undefined,
      );
    };
    const sample = async (name: string) => {
      const receipt = await draw(true);
      const observation = renderValue(
        await renderer.observe(receipt, { include: ['final-display'] }),
      ).observations?.find((image) => image.domain === 'final-display');
      if (observation === undefined) throw new Error('missing completed sky image');
      const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
      for (let y = 0; y < HEIGHT; y++)
        bytes.set(
          observation.bytes.subarray(
            y * observation.metadata.bytesPerRow,
            y * observation.metadata.bytesPerRow + WIDTH * 4,
          ),
          y * WIDTH * 4,
        );
      await save(`${backend}-${name}.rgba8`, bytes);
      const shot = await page.elementLocator(canvas).screenshot({ base64: true });
      await commands.writeFile(
        `${EVIDENCE}/${backend}-${name}.png`,
        typeof shot === 'string' ? shot : shot.base64,
        'base64',
      );
      return bytes;
    };
    try {
      const off = await sample('off');
      const atmosphere = world
        .spawn({ component: Atmosphere, data: { backgroundOnly: true } })
        .unwrap();
      const startup = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      try {
        await draw();
      } finally {
        (await recorder.frameBoundary()).unwrap();
        await save(`${backend}-startup.rhitape`, compactTape((await startup).unwrap()).bytes);
      }
      const tape = compactTape((await startup).unwrap());
      const model = buildFrameModel(decodeTape(tape.bytes).unwrap());
      const entries = model.works.flatMap((work) =>
        work.pipeline.shaders.map((shader) => shader.entryPoint),
      );
      expect(entries).toContain('atmosphere_transmittance_fragment');
      expect(entries).toContain('atmosphere_multiple_scattering_fragment');
      expect(entries).toContain('atmosphere_sky_view_fragment');
      expect(entries).toContain('atmosphere_background_fs');
      const atmosphereWork = model.works.filter((work) =>
        work.pipeline.shaders.some((shader) => shader.entryPoint?.startsWith('atmosphere_')),
      );
      expect(atmosphereWork.some((work) => work.kind === 'dispatchWorkgroups')).toBe(false);
      if (backend === 'wgpu-webgl2')
        expect(model.works.some((work) => work.kind === 'dispatchWorkgroups')).toBe(false);
      for (let frame = 1; frame < 60; frame++) await draw();
      const day = await sample('day');
      canvas.width = WIDTH + 8;
      canvas.height = HEIGHT + 8;
      await draw();
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      const resized = await sample('resized');
      expect(changed(day, resized)).toBe(0);
      const generation = (await draw()).deviceGeneration;
      if (signalLoss === undefined) throw new Error('missing host loss observer');
      lossRequested = true;
      signalLoss();
      for (let attempt = 0; attempt < 100 && renderer.state() !== 'device-lost'; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 0));
      expect(renderer.state()).toBe('device-lost');
      renderValue(await renderer.recover());
      lossRequested = false;
      expect((await draw()).deviceGeneration).toBe(generation + 1);
      expect(expectedLossErrors).toBe(1);
      const recovered = await sample('recovered');
      expect(changed(day, recovered)).toBe(0);
      expect(changed(off, day)).toBeGreaterThan(WIDTH * HEIGHT);
      world.set(sun, DirectionalLight, { direction: [0, -0.05, 0.9987492] }).unwrap();
      const sunset = await sample('sunset');
      const foreground = (Math.floor(HEIGHT / 2) * WIDTH + 18) * 4;
      for (let channel = 0; channel < 4; channel++) {
        expect(day[foreground + channel]).toBe(off[foreground + channel]);
        expect(sunset[foreground + channel]).toBe(off[foreground + channel]);
      }
      expect(changed(day, sunset)).toBeGreaterThan(WIDTH * HEIGHT);
      world.set(camera, Transform, { pos: [0, 20000, 0] }).unwrap();
      const high = await sample('high');
      expect(changed(sunset, high)).toBeGreaterThan(100);
      world.set(camera, Transform, { pos: [0, 1, 0] }).unwrap();
      world.despawn(atmosphere).unwrap();
      const restored = await sample('restored');
      expect(changed(off, restored)).toBe(0);
      expect(errors).toEqual([]);
      await save(
        `${backend}.json`,
        new TextEncoder().encode(
          JSON.stringify({ entries, completedFrames: 60, inspection: renderer.inspect() }),
        ),
      );
    } finally {
      unsubscribe();
      lease.dispose();
    }
  } finally {
    if (host?.ok) renderValue(await host.value.renderer.dispose());
    (await recorder.dispose()).unwrap();
    if (backend === 'wgpu-webgl2') {
      if (previousGpu === undefined) Reflect.deleteProperty(navigator, 'gpu');
      else Object.defineProperty(navigator, 'gpu', previousGpu);
    }
    canvas.remove();
  }
});
