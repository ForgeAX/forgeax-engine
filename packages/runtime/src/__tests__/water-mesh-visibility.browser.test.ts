import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createRuntimeAssetImportTransport, runtimeBinding } from 'virtual:forgeax/pack-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { Camera, DirectionalLight, type FrameReceipt, Skylight } from '@forgeax/engine-render';
import {
  propagateTransforms,
  scenePlugin,
  Transform,
  WaterBodyInstance,
  WaterZoneInstance,
} from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { constructRuntimeRendererHost, type RendererHostAssembly } from '../renderer-host';
import { waterScenePlugin, waterSceneSnapshot } from '../water-scene-plugin';
import { completedReadyFrame } from './helpers/completed-ready-frame';
import { waterVisibilityGuid } from './water-mesh-visibility.fixture';

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

it.each([
  'cpu',
  'gpu',
] as const)('renders visible %s WaterMesh from published canonical mesh assets for 60 completed frames', {
  timeout: 60_000,
}, async (mode) => {
  const deadline = Date.now() + 60_000;
  if (runtimeBinding === undefined) throw new Error('Water visibility Pack binding missing');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  document.body.append(canvas);
  let host: RendererHostAssembly | undefined;
  let context: Awaited<ReturnType<typeof createWorldContext>> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    host = value(
      await constructRuntimeRendererHost(
        canvas,
        { renderBackend: 'webgpu' },
        {
          ...forgeaxBundlerAdapter(),
          importTransport: createRuntimeAssetImportTransport(runtimeBinding),
        },
      ),
    );
    const { renderer, assets } = host;
    assets.configureRuntimeBinding(runtimeBinding);
    const world = new World({ assets });
    context = await createWorldContext(world, [
      {
        name: 'water-visibility-assets',
        provide: 'assets',
        apply: (ctx) => ctx.provide('assets', assets),
      },
      scenePlugin(),
      waterScenePlugin(),
    ]);
    const errors: unknown[] = [];
    unsubscribe = renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    let completedFrames = 0;
    const catalog = await fetch(runtimeBinding.catalogUrl);
    if (!catalog.ok) throw new Error(`Water fixture Catalog failed: ${await catalog.text()}`);
    value(
      renderer.setProfile({ ...renderer.inspect().profile, renderPath: 'forward', ssao: false }),
    );
    const zone = (await assets.load(waterVisibilityGuid(`zone/${mode}`), 'water-zone')).unwrap();
    const body = (await assets.load(waterVisibilityGuid(`body/${mode}`), 'water-body')).unwrap();
    const cooked = assets.read(body).unwrap();
    if (cooked.waterInfoMeshGuid === undefined) throw new Error('WaterInfo mesh GUID missing');
    const mesh = assets
      .read((await assets.load(cooked.waterInfoMeshGuid, 'mesh')).unwrap())
      .unwrap();
    // Layout declarations must stay empty: the real decoder owns interleaved vertex bytes.
    expect(mesh.attributeStorage).toBe('interleaved');
    expect(mesh.attributes.position?.byteLength).toBe(0);
    expect(mesh.vertices.length).toBeGreaterThan(0);
    world
      .spawn({ component: Transform, data: {} }, { component: WaterZoneInstance, data: { zone } })
      .unwrap();
    const water = world
      .spawn({ component: Transform, data: {} }, { component: WaterBodyInstance, data: { body } })
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [0, -1, -1],
          intensity: 3,
          castShadow: false,
        },
      })
      .unwrap();
    world.spawn({ component: Skylight, data: { intensity: 0.5, color: [1, 1, 1] } }).unwrap();
    world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [0, 8, 8],
            quat: quat.fromLookAt(quat.create(), [0, 8, 8], [0, 0, 0], [0, 1, 0]),
          },
        },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            aspect: 1,
            near: 0.1,
            far: 40,
            antialias: 0,
            bloom: 0,
            clearColor: [0.25, 0, 0.25, 1],
          },
        },
      )
      .unwrap();
    const lease = value(renderer.attach(world));
    const draw = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const receipt = await completedReadyFrame(
        () => value(renderer.draw({ source: lease })),
        deadline,
      );
      completedFrames++;
      return receipt;
    };
    const readPixels = async (phase: 'water' | 'without-water'): Promise<Uint8Array> => {
      const armed = renderer.requestObservation?.(['final-display']);
      if (armed === undefined) throw new Error('Water surface observation unavailable');
      value(armed);
      const receipt: FrameReceipt = await draw();
      const observed = value(await renderer.observe(receipt, { include: ['final-display'] }));
      const image = observed.observations?.find((entry) => entry.domain === 'final-display');
      if (image === undefined) throw new Error('Completed Water surface pixels missing');
      const pixels = new Uint8Array(64 * 64 * 4);
      for (let y = 0; y < 64; y++) {
        const start = (y + 32) * image.metadata.bytesPerRow + 32 * 4;
        pixels.set(image.bytes.subarray(start, start + 64 * 4), y * 64 * 4);
      }
      const screenshot = await page
        .elementLocator(canvas)
        .screenshot({ base64: true, save: false });
      await commands.writeFile(
        `artifacts/water-mesh-visibility/${mode}-${phase}.png`,
        typeof screenshot === 'string' ? screenshot : screenshot.base64,
        'base64',
      );
      return pixels;
    };
    for (let frame = 0; frame < 60; frame++) await draw();
    const visible = await readPixels('water');
    const inspection = renderer.inspect({
      fields: ['frame', 'waterGraph', 'meshMaterialBindings'],
    });
    const state = waterSceneSnapshot(world, water);
    world.despawn(water).unwrap();
    await draw();
    const absent = await readPixels('without-water');
    let changedPixels = 0;
    for (let offset = 0; offset < visible.length; offset += 4) {
      if (
        [0, 1, 2].some(
          (channel) =>
            Math.abs((visible[offset + channel] ?? 0) - (absent[offset + channel] ?? 0)) > 8,
        )
      )
        changedPixels++;
    }
    await commands.writeFile(
      `artifacts/water-mesh-visibility/${mode}.json`,
      JSON.stringify(
        {
          completedFrames,
          changedPixels,
          geometry: state?.outputs.geometry,
          frame: inspection.frame,
          waterInfo: inspection.waterGraph?.waterInfo,
          bindings: inspection.meshMaterialBindings,
          errors,
        },
        null,
        2,
      ),
    );
    expect(changedPixels, `${mode}: WaterMesh must cover the central water region`).toBeGreaterThan(
      1024,
    );
    expect(completedFrames).toBeGreaterThanOrEqual(60);
    expect(state?.outputs.geometry).toBe('ready');
    expect(errors).toEqual([]);
    expect(inspection.meshMaterialBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityKey: water,
          bindings: expect.arrayContaining([
            expect.objectContaining({
              drawReceipt: expect.objectContaining({ frameId: inspection.frame?.frameId }),
            }),
          ]),
        }),
      ]),
    );
    expect(inspection.waterGraph?.waterInfo).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          unavailable: [],
          rows: expect.arrayContaining([
            expect.objectContaining({
              bodyGuid: `scene-entity:${water}`,
              frameGeneration: inspection.frame?.frameId,
              outputGeneration: state?.outputGenerations.waterInfo,
            }),
          ]),
        }),
      ]),
    );
  } finally {
    unsubscribe?.();
    if (host !== undefined) await host.renderer.dispose();
    await context?.fiber.dispose();
    host?.assets.dispose();
    canvas.remove();
  }
});
