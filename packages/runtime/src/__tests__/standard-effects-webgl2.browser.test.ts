import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  AmbientOcclusion,
  ANTIALIAS_MSAA,
  CAMERA_EXPOSURE_MODE_AUTO,
  CAMERA_EXPOSURE_MODE_MANUAL,
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  ScreenSpaceReflection,
  Skylight,
  TONEMAP_LINEAR,
} from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRendererHost } from '../../../render/src/construct-renderer';
import { loadRhiPack } from '../backend-selection';
import { compactTape } from './compact-tape.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const WIDTH = 97;
const HEIGHT = 65;
const EVIDENCE = 'artifacts/ci-focus/standard-effects';

function enableEffects(
  world: World,
  camera: EntityHandle,
  effect: 'exposure' | 'ssr' | 'combined',
) {
  if (effect !== 'ssr')
    world
      .set(camera, Camera, { exposureMode: CAMERA_EXPOSURE_MODE_AUTO, rates: [20, 20] })
      .unwrap();
  if (effect !== 'exposure')
    world
      .addComponent(camera, {
        component: ScreenSpaceReflection,
        data: { maxDistance: 12, thickness: 0.2, maxRoughness: 0.65 },
      })
      .unwrap();
  if (effect === 'combined')
    world.addComponent(camera, { component: AmbientOcclusion, data: {} }).unwrap();
}

async function save(name: string, bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  await commands.writeFile(`${EVIDENCE}/${name}`, btoa(binary), 'base64');
}

function pixels(observation: {
  readonly bytes: Uint8Array;
  readonly metadata: { readonly bytesPerRow: number };
}) {
  const packed = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++)
    packed.set(
      observation.bytes.subarray(
        y * observation.metadata.bytesPerRow,
        y * observation.metadata.bytesPerRow + WIDTH * 4,
      ),
      y * WIDTH * 4,
    );
  return packed;
}

it.each([
  ['exposure', 'exposure', 0],
  ['ssr', 'ssr', 0],
  ['combined', 'combined', 0],
  ['combined-msaa', 'combined', ANTIALIAS_MSAA],
] as const)(
  'runs public Standard %s through 60 completed WebGL2 frames',
  async (effectCase, effect, antialias) => {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    document.body.append(canvas);
    const previousGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
    const recorder = attachRecorder(wgpu).unwrap();
    let host: Awaited<ReturnType<typeof constructRendererHost>> | undefined;
    try {
      host = await constructRendererHost(
        canvas,
        {
          // Fixture-local identity runs the real format/fallback admission.
          // Reports separately retain the tested checkout/build provenance.
          ssrIdentity: {
            sourceHead: 'fixture:standard-effects-webgl2',
            sourceTree: 'fixture:standard-effects-webgl2',
            lockSha256: 'fixture:standard-effects-webgl2',
            buildSha256: 'fixture:standard-effects-webgl2',
          },
        },
        { shaderManifestUrl: '/shaders/manifest.json' },
        loadRhiPack(
          { ...recorder.backend },
          {
            resolveSurfaceDevice: (device) =>
              ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
          },
        ),
      );
      if (!host.ok) throw new Error(JSON.stringify(host.error));
      const { renderer, assets } = host.value;
      expect(renderer.inspect().capabilities.backendKind).toBe('wgpu-webgl2');
      expect(renderer.inspect().capabilities.compute).toBe(false);
      const world = new World({ assets });
      const floor = assets
        .create(
          Materials.standard({ baseColor: [0.08, 0.08, 0.08, 1], metallic: 1, roughness: 0.08 }),
        )
        .unwrap();
      const pillar = assets
        .create(
          Materials.standard({
            baseColor: [0.8, 0.05, 0.02, 1],
            emissive: [1, 0.04, 0.01],
            emissiveIntensity: 3,
            roughness: 0.6,
          }),
        )
        .unwrap();
      for (const [size, position, material] of [
        [[12, 0.1, 12], [0, -0.05, -2], floor],
        [[1, 2, 1], [0, 1, -2], pillar],
      ] as const)
        world
          .spawn(
            { component: Transform, data: { pos: position } },
            {
              component: MeshFilter,
              data: {
                assetHandle: assets
                  .create(createBoxGeometry(size[0], size[1], size[2]).unwrap())
                  .unwrap(),
              },
            },
            { component: MeshRenderer, data: { materials: [material] } },
          )
          .unwrap();
      world.spawn({ component: Skylight, data: { intensity: 0.1 } }).unwrap();
      const camera = world
        .spawn(
          {
            component: Transform,
            data: { pos: [0, 1.2, 5], quat: [Math.sin(-0.1), 0, 0, Math.cos(-0.1)] },
          },
          {
            component: Camera,
            data: {
              near: 0.1,
              far: 30,
              fov: Math.PI / 3,
              aspect: WIDTH / HEIGHT,
              tonemap: TONEMAP_LINEAR,
              antialias,
              clearColor: [0.002, 0.002, 0.002, 1],
            },
          },
        )
        .unwrap();
      const lease = renderValue(renderer.attach(world));
      const errors: unknown[] = [];
      const unsubscribe = renderer.subscribe((event) => {
        if (event.kind === 'error') errors.push(event.error);
      });
      const draw = async (capture = false) => {
        world.update(1 / 60).unwrap();
        propagateTransforms(world).unwrap();
        return drawReadyFrame(
          renderer,
          { leases: [lease], camera: { lease }, environment: { lease } },
          capture ? ['final-display'] : undefined,
        );
      };
      const sample = async (name: string) => {
        const receipt = await draw(true);
        const observation = renderValue(
          await renderer.observe(receipt, { include: ['final-display'] }),
        ).observations?.find((image) => image.domain === 'final-display');
        if (observation === undefined) throw new Error('missing completed display observation');
        await save(`${effectCase}-${name}.rgba8`, pixels(observation));
        const shot = await page.elementLocator(canvas).screenshot({ base64: true });
        await commands.writeFile(
          `${EVIDENCE}/${effectCase}-${name}.png`,
          typeof shot === 'string' ? shot : shot.base64,
          'base64',
        );
        return pixels(observation);
      };
      try {
        const baseline = await sample('off');
        enableEffects(world, camera, effect);
        const startup = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        try {
          await draw();
        } finally {
          (await recorder.frameBoundary()).unwrap();
          await save(`${effectCase}-startup.rhitape`, compactTape((await startup).unwrap()).bytes);
        }
        for (let frame = 1; frame < 60; frame++) await draw();
        const capture = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        const enabled = await sample('on');
        (await recorder.frameBoundary()).unwrap();
        const tape = compactTape((await capture).unwrap());
        await save(`${effectCase}.rhitape`, tape.bytes);
        const model = buildFrameModel(decodeTape(tape.bytes).unwrap());
        const entryPoints = model.works.flatMap((work) =>
          work.pipeline.shaders.map((shader) => shader.entryPoint),
        );
        const inspection = renderer.inspect();
        await save(
          `${effectCase}.json`,
          new TextEncoder().encode(
            JSON.stringify({ inspection, entryPoints, completedFrames: 60 }),
          ),
        );
        expect(model.works.some((work) => work.kind === 'dispatchWorkgroups')).toBe(false);
        if (effect !== 'ssr') {
          expect(inspection.output.autoExposure?.actualState).toBe('gpu-resident');
          expect(inspection.output.autoExposure?.recentFailure).toBeUndefined();
          expect(entryPoints).toContain('auto_exposure_adapt_fragment');
        }
        if (effect !== 'exposure') {
          expect(inspection.ssr.status).toBe('admitted');
          expect(entryPoints).toContain('ssr_trace_fragment');
          expect(entryPoints).toContain('fs_ssr_compose_fragment');
        }
        if (effect === 'combined') expect(entryPoints).toContain('fs_ssao_calc');
        let changed = 0;
        for (let index = 0; index < baseline.length; index++)
          if (index % 4 !== 3 && Math.abs((baseline[index] ?? 0) - (enabled[index] ?? 0)) > 2)
            changed++;
        expect(changed).toBeGreaterThan(20);
        world.set(camera, Camera, { exposureMode: CAMERA_EXPOSURE_MODE_MANUAL }).unwrap();
        if (world.hasComponent(camera, ScreenSpaceReflection))
          world.removeComponent(camera, ScreenSpaceReflection).unwrap();
        if (world.hasComponent(camera, AmbientOcclusion))
          world.removeComponent(camera, AmbientOcclusion).unwrap();
        const restored = await sample('restored');
        let maximumRestoredError = 0;
        for (let index = 0; index < baseline.length; index++)
          maximumRestoredError = Math.max(
            maximumRestoredError,
            Math.abs((baseline[index] ?? 0) - (restored[index] ?? 0)),
          );
        expect(maximumRestoredError).toBeLessThanOrEqual(1);
        expect(errors).toEqual([]);
      } finally {
        unsubscribe();
        lease.dispose();
      }
    } finally {
      if (host?.ok) await host.value.renderer.dispose();
      (await recorder.dispose()).unwrap();
      if (previousGpu === undefined) Reflect.deleteProperty(navigator, 'gpu');
      else Object.defineProperty(navigator, 'gpu', previousGpu);
      canvas.remove();
    }
  },
  120_000,
);
