import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createRuntimeAssetImportTransport, runtimeBinding } from 'virtual:forgeax/pack-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import {
  ANTIALIAS_MSAA,
  ANTIALIAS_TAA,
  Camera,
  DirectionalLight,
  type FrameReceipt,
  Materials,
  MeshFilter,
  MeshRenderer,
  MotionBlur,
  ScreenSpaceReflection,
  Skylight,
} from '@forgeax/engine-render';
import {
  propagateTransforms,
  scenePlugin,
  Transform,
  WaterBodyInstance,
  WaterZoneInstance,
} from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost, type RendererHostAssembly } from '../renderer-host';
import { waterScenePlugin, waterSceneSnapshot } from '../water-scene-plugin';
import { completedReadyFrame } from './helpers/completed-ready-frame';
import { waterVisibilityGuid } from './water-mesh-visibility.fixture';

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function waterVisibilitySetup(ssr: boolean) {
  if (!ssr) return { renderBackend: 'webgpu' as const };
  return {
    renderBackend: 'webgpu' as const,
    ssrIdentity: {
      sourceHead: 'fixture:water-mesh',
      sourceTree: 'fixture:water-mesh',
      lockSha256: 'fixture:water-mesh',
      buildSha256: 'fixture:water-mesh',
    },
  };
}

function expectWaterTopology(
  inspection: ReturnType<RendererHostAssembly['renderer']['inspect']>,
  {
    lane,
    compact,
    ssr,
    forwardSsr,
    msaa,
    motion,
  }: {
    lane: 'forward' | 'deferred';
    compact: boolean;
    ssr: boolean;
    forwardSsr: boolean;
    msaa: boolean;
    motion: boolean;
  },
) {
  const waterPasses = inspection.waterGraph?.passes.map(({ name }) => name);
  expect(waterPasses).toContain('water-slw-inner-color');
  if (compact) expect(waterPasses).toContain('water-reflection-composite');
  else {
    expect(waterPasses).not.toContain('water-reflection-composite');
    expect(inspection.waterGraph?.resources.map(({ label }) => label)).not.toContain(
      'water-normal-roughness',
    );
  }
  const key = inspection.featureGraph?.last.topologyKey;
  const topology = key === undefined ? undefined : JSON.parse(key).topology;
  expect(topology?.opaque?.lane).toBe(lane);
  if (compact) {
    expect(topology?.compactGbuffer).toBe('standard-gbuffer/4');
    expect(waterPasses.includes('water-ssr-trace')).toBe(ssr);
    if (ssr) {
      expect(inspection.ssr?.status, JSON.stringify(inspection.ssr?.failure)).toBe('admitted');
    } else {
      const prepass = inspection.waterGraph?.passes.find(
        ({ name }) => name === 'water-depth-prepass',
      );
      expect(prepass?.accesses).toContainEqual({
        resource: 'scene-velocity',
        usage: 'color-attachment',
      });
      expect(inspection.perFramePassNames).toContain('taa-resolve');
      expect(inspection.perFramePassNames).not.toContain('standard-scene-data');
    }
  } else {
    expect(waterPasses).not.toContain('water-ssr-trace');
    expect(waterPasses).not.toContain('water-slw-current-scene');
  }
  if (forwardSsr) {
    expect(inspection.ssr?.status, JSON.stringify(inspection.ssr?.failure)).toBe('admitted');
    const waterColor = inspection.waterGraph?.passes.find(
      ({ name }) => name === 'water-slw-inner-color',
    );
    expect(waterColor?.accesses).toEqual(
      expect.arrayContaining([
        { resource: 'hzb', usage: 'sampled-read' },
        { resource: 'water-no-water-raw-depth', usage: 'sampled-read' },
      ]),
    );
    expect(waterPasses).not.toContain('water-hzb-seed');
  }
  if (msaa) {
    expect(waterPasses).toContain('water-opaque-msaa-surface-resolve');
    expect(waterPasses).not.toContain('water-opaque-normal-msaa');
    const resources = inspection.waterGraph?.resources.map(({ label }) => label);
    expect(resources).not.toContain('water-opaque-normal');
    expect(resources?.includes('water-opaque-temporal-msaa')).toBe(motion);
  }
  if (motion) {
    expect(waterPasses).not.toContain('water-scene-temporal');
    expect(
      inspection.waterGraph?.passes.find(({ name }) => name === 'water-slw-inner-color')?.accesses,
    ).toContainEqual({
      resource: msaa ? 'standard-scene-temporal' : 'scene-velocity',
      usage: 'color-attachment',
    });
    expect(inspection.motionBlur).toMatchObject({ status: 'active' });
    const passes = inspection.perFramePassNames;
    expect(passes).toContain('standard-depth-velocity');
    expect(passes.indexOf('standard-depth-velocity')).toBeLessThan(passes.indexOf('main'));
    expect(passes).not.toContain('standard-scene-data');
  }
}

function visibilityScenario(label: string, lane: 'forward' | 'deferred') {
  const compact = lane === 'deferred';
  const motion = label === 'forward-motion' || label === 'forward-msaa-motion';
  const msaa = label === 'forward-msaa' || label === 'forward-msaa-motion';
  const forwardSsr = label === 'forward-ssr';
  const taa = label === 'compact-deferred-taa';
  const ssr = label === 'compact-deferred-ssr' || forwardSsr;
  return {
    compact,
    motion,
    msaa,
    forwardSsr,
    taa,
    ssr,
    needsOpaqueBackdrop: ssr || msaa || motion || taa,
  };
}

it.each([
  { mode: 'cpu', lane: 'forward', label: 'cpu' },
  { mode: 'gpu', lane: 'forward', label: 'gpu' },
  { mode: 'cpu', lane: 'forward', label: 'forward-msaa' },
  { mode: 'cpu', lane: 'forward', label: 'forward-motion' },
  { mode: 'cpu', lane: 'forward', label: 'forward-msaa-motion' },
  { mode: 'cpu', lane: 'forward', label: 'forward-ssr' },
  { mode: 'cpu', lane: 'deferred', label: 'compact-deferred-ssr' },
  { mode: 'cpu', lane: 'deferred', label: 'compact-deferred-taa' },
] as const)('renders visible WaterMesh for 60 completed frames ($label)', {
  timeout: 60_000,
}, async ({ mode, lane, label }) => {
  const deadline = Date.now() + 60_000;
  const { compact, motion, msaa, forwardSsr, taa, ssr, needsOpaqueBackdrop } = visibilityScenario(
    label,
    lane,
  );
  if (runtimeBinding === undefined) throw new Error('Water visibility Pack binding missing');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  document.body.append(canvas);
  let host: RendererHostAssembly | undefined;
  let context: Awaited<ReturnType<typeof createWorldContext>> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    host = value(
      await constructRuntimeRendererHost(canvas, waterVisibilitySetup(ssr), {
        ...forgeaxBundlerAdapter(),
        importTransport: createRuntimeAssetImportTransport(runtimeBinding),
      }),
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
      renderer.setProfile({
        ...renderer.inspect().profile,
        renderPath: lane,
        ambientOcclusion: { enabled: forwardSsr },
        ...(compact
          ? {
              gbufferFormat: 'default',
              deferredDirectionalShadowReceiver: 'projected',
            }
          : {}),
      }),
    );
    const zone = (await assets.load(waterVisibilityGuid(`zone/${mode}`), 'water-zone')).unwrap();
    const body = (await assets.load(waterVisibilityGuid(`body/${mode}`), 'water-body')).unwrap();
    const cooked = assets.read(body).unwrap();
    if (cooked.waterInfoMeshGuid === undefined) throw new Error('WaterInfo mesh GUID missing');
    const mesh = assets
      .read((await assets.load(cooked.waterInfoMeshGuid, 'mesh')).unwrap())
      .unwrap();
    if (needsOpaqueBackdrop)
      await Promise.all(
        [cooked.visibleMeshGuid, cooked.dilatedWaterInfoMeshGuid].map(async (guid) => {
          if (guid !== undefined) (await assets.load(guid, 'mesh')).unwrap();
        }),
      );
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
    if (needsOpaqueBackdrop) {
      const floor = assets.create(createBoxGeometry(14, 0.5, 14).unwrap()).unwrap();
      const baseColor = [0.08, 0.15, 0.05, 1] as const;
      const matte = assets
        .create(msaa ? Materials.unlit(baseColor) : Materials.standard({ baseColor }))
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { pos: [0, -1.5, 0] } },
          { component: MeshFilter, data: { assetHandle: floor } },
          { component: MeshRenderer, data: { materials: [matte] } },
        )
        .unwrap();
    }
    const camera = world
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
            antialias: msaa ? ANTIALIAS_MSAA : taa ? ANTIALIAS_TAA : 0,
            bloom: 0,
            clearColor: [0.25, 0, 0.25, 1],
          },
        },
      )
      .unwrap();
    if (motion) world.addComponent(camera, { component: MotionBlur, data: {} }).unwrap();
    if (ssr)
      world
        .addComponent(camera, {
          component: ScreenSpaceReflection,
          data: { maxDistance: 12, thickness: 0.2, maxRoughness: 0.65 },
        })
        .unwrap();
    const lease = value(renderer.attach(world));
    const draw = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const receipt = needsOpaqueBackdrop
        ? await drawReadyFrame(renderer, { source: lease }, undefined, {
            timeoutMs: Math.max(1, deadline - Date.now()),
          })
        : await completedReadyFrame(() => value(renderer.draw({ source: lease })), deadline);
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
        `artifacts/water-mesh-visibility/${label}-${phase}.png`,
        typeof screenshot === 'string' ? screenshot : screenshot.base64,
        'base64',
      );
      return pixels;
    };
    for (let frame = 0; frame < 60; frame++) await draw();
    const visible = await readPixels('water');
    const inspection = renderer.inspect({
      fields: [
        'frame',
        'waterGraph',
        'meshMaterialBindings',
        'featureGraph',
        'ssr',
        'motionBlur',
        'perFramePassNames',
      ],
    });
    expectWaterTopology(inspection, { lane, compact, ssr, forwardSsr, msaa, motion });
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
      `artifacts/water-mesh-visibility/${label}.json`,
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
