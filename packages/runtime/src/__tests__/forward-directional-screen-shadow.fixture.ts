import { World } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createPlaneGeometry,
  packInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import {
  ANTIALIAS_MSAA,
  Camera,
  ClippingPlanes,
  clippingPlanesData,
  DirectionalLight,
  DirectionalShadowFilterValue,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PointLightShadow,
  type Renderer,
  ShadowParticipation,
  Skylight,
  SpotLight,
} from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { compactTape } from './compact-tape.fixture';
import { luminanceRgba16f } from './contact-shadow.fixture';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { testAssets } from './helpers/runtime-assets';

export async function verifyForwardScreenShadow(
  geometryLane: 'automatic' | 'direct',
  options?: {
    readonly shaderManifestUrl?: string;
    readonly pointShadows?: false;
    readonly benchmark?: true;
    readonly writeEvidence?: (name: string, bytes: Uint8Array | string) => void;
  },
) {
  const recorder = attachRecorder(webgpu).unwrap();
  const size = options?.benchmark ? 1920 : 96;
  const height = options?.benchmark ? 1080 : size;
  const { writeEvidence, shaderManifestUrl } = options ?? {};
  const target =
    typeof document === 'undefined'
      ? offscreenCanvas(size, height)
      : (() => {
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = height;
          document.body.append(canvas);
          return { canvas, destroy: () => canvas.remove() };
        })();
  const host = await constructRuntimeRendererHost(
    target.canvas,
    { rhi: recorder.backend.rhi, ...(writeEvidence === undefined ? {} : { gpuPassTiming: {} }) },
    shaderManifestUrl === undefined ? {} : { shaderManifestUrl },
  );
  if (!host.ok) {
    target.destroy();
    (await recorder.dispose()).unwrap();
    throw host.error;
  }
  const { renderer } = host.value;
  const faults: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') {
      faults.push(event.error);
      console.error(
        JSON.stringify(event.error, (_key, value) =>
          value instanceof Error ? { ...value, message: value.message, stack: value.stack } : value,
        ),
      );
    }
  });
  const world = new World();
  const source = renderer.attach(world).unwrap();
  try {
    const assets = testAssets(world);
    const material = assets.create(Materials.standard({ baseColor: [0.7, 0.7, 0.7, 1] })).unwrap();
    for (const [dimensions, position] of [
      [
        [2, 2, 0.05],
        [0, 0, -4],
      ],
      [
        [0.4, 0.4, 0.2],
        [2 / 3, 0, -3],
      ],
    ] as const) {
      const geometry = assets.create(createBoxGeometry(...dimensions).unwrap()).unwrap();
      world
        .spawn(
          { component: Transform, data: { pos: [...position] } },
          { component: MeshFilter, data: { assetHandle: geometry } },
          { component: MeshRenderer, data: { materials: [material] } },
          { component: ShadowParticipation, data: { cast: position[2] > -3.5, receive: true } },
        )
        .unwrap();
    }
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            near: 0.1,
            far: 20,
            aspect: size / height,
            tonemap: 0,
            antialias: 0,
            bloom: 0,
          },
        },
      )
      .unwrap();
    const sun = world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [-2 / 3, 0, -1],
          intensity: 3,
          castShadow: true,
          mapSize: 256,
          shadowDistance: 12,
          depthBias: 0.001,
          cascadeCount: 2,
          shadowFilter: DirectionalShadowFilterValue.pcf3,
        },
      })
      .unwrap();
    const original = renderer.inspect().profile;
    const request = { source, geometryLane };
    let viewClippingActive = false;
    function setProfile(screen: boolean, ao: boolean, projection?: ProjectionTestOptions) {
      // View clipping requires the direct receiver. Keep the plane outside
      // this fixture so the control draws exactly the same visible geometry.
      if (viewClippingActive === screen) {
        if (screen) world.removeComponent(camera, ClippingPlanes).unwrap();
        else {
          world
            .addComponent(camera, {
              component: ClippingPlanes,
              data: clippingPlanesData({ planes: [[1, 0, 0, 100]] }),
            })
            .unwrap();
        }
        viewClippingActive = !screen;
      }
      renderer
        .setProfile({
          ...original,
          renderPath: 'forward',
          ambientOcclusion: ao
            ? {
                enabled: true,
                method: 'ssao',
                intensity: 1,
              }
            : { enabled: false },
          ...(projection?.gather ? { forwardShadowSpotFilter: 'gather' as const } : {}),
          ...(projection?.fade ? { forwardShadowViewFade: true as const } : {}),
        })
        .unwrap();
    }
    if (options?.benchmark) {
      if (writeEvidence === undefined) throw new Error('benchmark needs a receipt sink');
      await measureMixedProjection(world, renderer, request, setProfile, writeEvidence);
      expect(faults).toEqual([]);
      return;
    }
    async function draw(
      screen: boolean,
      tag = screen ? 'screen' : 'raw',
      ao = false,
      projection?: ProjectionTestOptions,
    ) {
      setProfile(screen, ao, projection);
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      await drawReadyFrame(renderer, request);
      // Binding assertions use the recorded work, and pixels come from the
      // live HDR attachment. Seed resources only for exported replay evidence.
      const recording = recorder.captureFrame(
        writeEvidence === undefined ? { seed: { maxResourceBytes: 0 } } : undefined,
      );
      (await recorder.frameBoundary()).unwrap();
      const receipt = await drawReadyFrame(renderer, request, ['linear-hdr']);
      (await recorder.frameBoundary()).unwrap();
      const tape = (await recording).unwrap();
      const image = (await renderer.observe(receipt, { include: ['linear-hdr'] }))
        .unwrap()
        .observations?.find((item) => item.domain === 'linear-hdr');
      if (image === undefined) throw new Error('missing scene linear-HDR output');
      if (writeEvidence !== undefined) {
        writeEvidence(`${geometryLane}-${tag}.rhitape`, compactTape(tape).bytes);
        writeEvidence(`${geometryLane}-${tag}.rgba16f`, image.bytes);
        const timings = [];
        for (let i = 0; i < 20; i++) {
          const timed = await drawReadyFrame(renderer, request);
          timings.push((await renderer.observe(timed, { include: ['timings'] })).unwrap().timings);
        }
        writeEvidence(
          `${geometryLane}-${tag}-timings.json`,
          JSON.stringify(timings, (_key, value) =>
            typeof value === 'bigint' ? value.toString() : value,
          ),
        );
      }
      return {
        model: buildFrameModel(tape.tape),
        pixels: luminanceRgba16f(image.bytes, size, height),
      };
    }
    const raw = await draw(false);
    expect(
      renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
    ).toEqual({ mode: 'raw', reason: 'coverage' });
    expect(faults).toEqual([]);
    const screen = await draw(true);
    expect(faults).toEqual([]);
    const entries = (entry: string) =>
      screen.model.works.filter((work) =>
        work.pipeline.shaders.some((shader) => shader.entryPoint === entry),
      );
    verifyDepthOnlyProjection(screen);
    expect(entries('fs_forward_sun_shadow').length).toBeGreaterThan(0);
    for (const draw of entries('fs_forward_sun_shadow')) {
      expect(
        draw.bindings.filter(
          ({ groupIndex, binding, resourceKind }) =>
            groupIndex === 0 &&
            resourceKind === 'textureView' &&
            [3, 5, 8, 24, 27, 28].includes(binding),
        ),
      ).toEqual([]);
      expect(
        draw.bindings.filter(({ groupIndex, binding }) => groupIndex === 0 && binding === 29),
      ).toHaveLength(1);
      expect(
        draw.bindings
          .filter(
            ({ groupIndex, resourceKind }) => groupIndex === 2 && resourceKind === 'textureView',
          )
          .map(({ binding }) => binding),
      ).toEqual([32]);
      expect(
        draw.bindings
          .filter(
            ({ groupIndex, binding }) => groupIndex === 0 && (binding === 34 || binding === 35),
          )
          .map(({ binding }) => binding),
      ).toEqual([34, 35]);
    }
    expect(entries('fs_opaque')).toHaveLength(0);
    expectDirectionalEdgeParity(raw, screen, 'directional');
    world.set(sun, DirectionalLight, { castShadow: false }).unwrap();
    const lit = await draw(true, 'lit');
    expect(faults).toEqual([]);
    expect(
      lit.model.works.some(({ pipeline }) =>
        pipeline.shaders.some(({ entryPoint }) => entryPoint === 'fs_forward_sun_shadow'),
      ),
    ).toBe(false);
    const shadowDelta = lit.pixels.reduce(
      (max, value, i) => Math.max(max, value - (raw.pixels[i] ?? 0)),
      0,
    );
    expect(shadowDelta).toBeGreaterThan(0.15);
    world.set(sun, DirectionalLight, { castShadow: true }).unwrap();
    world.set(camera, Transform, { pos: [0.12, 0.08, 0] }).unwrap();
    const movedRaw = await draw(false, 'moved-raw');
    const movedScreen = await draw(true, 'moved-screen');
    expect(faults).toEqual([]);
    expectDirectionalEdgeParity(movedRaw, movedScreen, 'moved camera');
    expect(
      renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
    ).toEqual({
      mode: 'screen',
      format: 'r8unorm',
      width: size,
      height: size,
      projectedLights: 1,
    });
    await verifyAoCoexistence(renderer, draw);
    world.set(sun, DirectionalLight, { contactShadowLength: 0.3 }).unwrap();
    const combinedRaw = await draw(false, 'contact-ao-raw', true);
    const combined = await draw(true, 'contact-ao-screen', true);
    expect(
      renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
    ).toMatchObject({ mode: 'screen', contact: true, ambientOcclusion: true });
    expect(entryWorks(combined, 'fs_directional_rgba')).toHaveLength(1);
    expect(renderer.inspect().perFramePassNames).not.toContain('forward-contact-shadow');
    expect(renderer.inspect().perFramePassNames).not.toContain('ssao-calc');
    expectDirectionalEdgeParity(combinedRaw, combined, 'contact shadows with AO');
    world.set(sun, DirectionalLight, { contactShadowLength: 0 }).unwrap();
    await verifyCoverageEdges(world, renderer, draw, camera);
    await verifySkinnedCoverageFallback(world, renderer, draw);
    await verifyCookieOwnership(world, renderer, draw);
    if (options?.pointShadows === false) {
      await verifyCompactSpotProjection(world, renderer, draw, camera, sun);
    } else {
      await verifyPunctualProjection(
        world,
        renderer,
        draw,
        async () => {
          world.update(1 / 60).unwrap();
          propagateTransforms(world).unwrap();
          return (await drawReadyFrame(renderer, request)).graphGeneration;
        },
        sun,
        camera,
        writeEvidence === undefined
          ? undefined
          : (name, value) => writeEvidence(`${geometryLane}-${name}`, value),
      );
    }
    expect(faults).toEqual([]);
  } catch (error) {
    console.error(
      JSON.stringify(error, (_key, value) =>
        value instanceof Error ? { ...value, message: value.message, cause: value.cause } : value,
      ),
    );
    throw error;
  } finally {
    unsubscribe();
    source.dispose();
    await renderer.dispose();
    target.destroy();
    (await recorder.dispose()).unwrap();
  }
}

async function measureMixedProjection(
  world: World,
  renderer: Renderer,
  request: Parameters<Renderer['draw']>[0],
  setProfile: (screen: boolean, ao: boolean) => void,
  evidence: (name: string, bytes: string) => void,
) {
  world
    .spawn(
      { component: Transform, data: { pos: [2, 0, -1] } },
      { component: PointLight, data: { intensity: 25, range: 10 } },
      { component: PointLightShadow, data: { mapSize: 256, farPlane: 10 } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [2, 0, -1] } },
      {
        component: SpotLight,
        data: {
          direction: [-2, 0, -3],
          intensity: 25,
          range: 10,
          castShadow: true,
          innerConeDeg: 60,
          mapSize: 256,
        },
      },
    )
    .unwrap();
  world.update(1 / 60).unwrap();
  propagateTransforms(world).unwrap();
  for (const [round, order] of [
    [false, true],
    [true, false],
    [false, true],
  ].entries()) {
    for (const screen of order) {
      setProfile(screen, false);
      for (let i = 0; i < 60; i++) await drawReadyFrame(renderer, request);
      const inspection = renderer.inspect({ fields: ['directionalShadow', 'deviceInfo'] });
      const receiver = inspection.directionalShadow.forwardReceiver;
      if (screen)
        expect(receiver).toMatchObject({
          mode: 'screen',
          projectedLights: 3,
          width: 1920,
          height: 1080,
        });
      const samples = [];
      for (let i = 0; i < 240; i++) {
        const receipt = await drawReadyFrame(renderer, request);
        const timings = (await renderer.observe(receipt, { include: ['timings'] })).unwrap()
          .timings;
        expect(timings?.status).toBe('complete');
        samples.push(timings);
      }
      evidence(
        `1080p-${round + 1}-${screen ? 'screen' : 'raw'}.json`,
        JSON.stringify(
          { receiver, deviceInfo: inspection.deviceInfo, warmupFrames: 60, samples },
          (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
        ),
      );
    }
  }
}

async function verifyCoverageEdges(
  world: World,
  renderer: Renderer,
  draw: (screen: boolean, tag: string, ao?: boolean) => Promise<ShadowFrame>,
  camera: Parameters<World['set']>[0],
) {
  const assets = testAssets(world);
  const geometry = assets.create(createPlaneGeometry(1.25, 1.25, 8, 8).unwrap()).unwrap();
  // Alternate covered columns in green (opacity) and height in red.
  const data = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++)
      data.set([x < 4 ? 0 : 255, x % 2 ? 0 : 255, 0, 255], (y * 8 + x) * 4);
  }
  const texture = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 8, height: 8 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data,
    })
    .unwrap();
  const sampler = assets
    .create({
      kind: 'sampler',
      minFilter: 'nearest',
      magFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    .unwrap();
  const surface = { baseColor: [0.1, 0.2, 0.35, 1] as const, roughness: 1 };
  const occupied = assets.create(Materials.standard(surface)).unwrap();
  const masked = assets
    .create(
      Materials.standard({
        ...surface,
        alphaTexture: { texture, sampler },
        alphaCutoff: 0.5,
      }),
    )
    .unwrap();
  const displaced = assets
    .create(
      Materials.standard({
        ...surface,
        displacementTexture: { texture, sampler },
        displacementScale: 0.55,
      }),
    )
    .unwrap();
  const card = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -3.55] } },
      { component: MeshFilter, data: { assetHandle: geometry } },
      { component: MeshRenderer, data: { materials: [occupied] } },
      { component: ShadowParticipation, data: { cast: false, receive: true } },
    )
    .unwrap();
  const flat = await draw(false, 'coverage-flat');
  for (const [name, material] of [
    ['masked', masked],
    ['displaced', displaced],
  ] as const) {
    world.set(card, MeshRenderer, { materials: [material] }).unwrap();
    const raw = await draw(false, `coverage-${name}-raw`);
    const projected = await draw(true, `coverage-${name}-screen`);
    expect(maxPixelDelta(flat, raw, true), name).toBeGreaterThan(0.05);
    expect(
      renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver?.mode,
      name,
    ).toBe('screen');
    verifyDepthOnlyProjection(projected);
    expectDirectionalEdgeParity(raw, projected, name);
  }
  world.set(card, ShadowParticipation, { receive: false }).unwrap();
  const unshadowedRaw = await draw(false, 'coverage-unshadowed-raw');
  const unshadowedProjected = await draw(true, 'coverage-unshadowed-screen');
  expectDirectionalEdgeParity(unshadowedRaw, unshadowedProjected, 'receive disabled');
  world.set(card, MeshRenderer, { materials: [masked] }).unwrap();
  world.set(camera, Camera, { antialias: ANTIALIAS_MSAA }).unwrap();
  const msaaRaw = await draw(false, 'coverage-msaa-raw');
  const msaaRequested = await draw(true, 'coverage-msaa-screen-request');
  expect(
    renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
  ).toEqual({ mode: 'raw', reason: 'capability' });
  expect(
    entryWorks(msaaRequested, 'fs_opaque').some(
      ({ pipeline }) =>
        (pipeline.descriptor as { desc?: { multisample?: { count?: number } } })?.desc?.multisample
          ?.count === 4,
    ),
  ).toBe(true);
  expect(maxPixelDelta(msaaRaw, msaaRequested, true)).toBe(0);
  world.set(camera, Camera, { antialias: 0 }).unwrap();
  world.despawn(card).unwrap();
}

async function verifySkinnedCoverageFallback(
  world: World,
  renderer: Renderer,
  draw: (screen: boolean, tag: string, ao?: boolean) => Promise<ShadowFrame>,
) {
  const assets = testAssets(world);
  const geometry = createPlaneGeometry(0.8, 0.8).unwrap();
  const count = (geometry.attributes.position as Float32Array).length / 3;
  const attributes = {
    ...geometry.attributes,
    skinIndex: new Uint16Array(count * 4),
    skinWeight: Float32Array.from({ length: count * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
  };
  const mesh = assets
    .create({
      ...geometry,
      attributes,
      vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
    })
    .unwrap();
  const joint = world.spawn({ component: Transform, data: {} }).unwrap();
  const skeleton = assets
    .create({
      kind: 'skeleton',
      jointCount: 1,
      inverseBindMatrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      bounds: new Float32Array([-1, -1, -1, 1, 1, 1]),
    })
    .unwrap();
  const material = assets
    .create({
      kind: 'material',
      values: { baseColor: [0.15, 0.3, 0.5, 1] },
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::pbr-skin' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
    })
    .unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -3.5] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
      { component: ShadowParticipation, data: { cast: false, receive: true } },
      { component: Skin, data: { skeleton, joints: new Uint32Array([joint]) } },
    )
    .unwrap();
  const before = await draw(false, 'coverage-skin-before-motion');
  world.set(joint, Transform, { quat: [0, Math.sin(0.5), 0, Math.cos(0.5)] }).unwrap();
  const raw = await draw(false, 'coverage-skin-raw');
  const requested = await draw(true, 'coverage-skin-screen-request');
  expect(maxPixelDelta(before, raw, true)).toBeGreaterThan(0.05);
  expect(
    renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
  ).toEqual({ mode: 'raw', reason: 'coverage' });
  expect(maxPixelDelta(raw, requested, true)).toBe(0);
  world.despawn(entity).unwrap();
  world.despawn(joint).unwrap();
}

async function verifyCookieOwnership(
  world: World,
  renderer: Renderer,
  draw: (screen: boolean, tag: string, ao?: boolean) => Promise<ShadowFrame>,
) {
  const assets = testAssets(world);
  const makeCookie = (color: readonly number[]) =>
    assets
      .create({
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: 'rgba8unorm',
        colorSpace: 'linear',
        mips: { kind: 'none' },
        data: new Uint8Array(color),
      })
      .unwrap();
  const scalar = makeCookie([77, 77, 77, 255]);
  const colored = makeCookie([255, 5, 5, 255]);
  const geometry = assets.create(createPlaneGeometry(1.6, 1.6).unwrap()).unwrap();
  const material = assets.create(Materials.standard({ baseColor: [0.8, 0.8, 0.8, 1] })).unwrap();
  const receiver = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -3.6] } },
      { component: MeshFilter, data: { assetHandle: geometry } },
      { component: MeshRenderer, data: { materials: [material] } },
      { component: ShadowParticipation, data: { cast: false, receive: false } },
    )
    .unwrap();
  const light = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -1] } },
      {
        component: SpotLight,
        data: {
          direction: [0, 0, -1],
          intensity: 80,
          range: 8,
          castShadow: true,
          mapSize: 256,
        },
      },
    )
    .unwrap();
  // Sample inside the receiver card. Shadow edges on other geometry are
  // outside this Cookie oracle and can move under the depth-only bias policy.
  function cardDelta(a: ShadowFrame, b: ShadowFrame): number {
    let maximum = 0;
    for (let y = 39; y < 54; y++) {
      for (let x = 38; x < 52; x++) {
        const i = y * 96 + x;
        maximum = Math.max(maximum, Math.abs((a.pixels[i] ?? 0) - (b.pixels[i] ?? 0)));
      }
    }
    return maximum;
  }
  const neutral = await draw(false, 'cookie-neutral-raw');
  for (const [name, cookie] of [
    ['scalar', scalar],
    ['rgb', colored],
  ] as const) {
    world.set(light, SpotLight, { cookie }).unwrap();
    const raw = await draw(false, `cookie-${name}-raw`);
    const projected = await draw(true, `cookie-${name}-screen-request`);
    expect(cardDelta(neutral, raw), name).toBeGreaterThan(0.05);
    expect(cardDelta(raw, projected), name).toBeLessThanOrEqual(0.007);
    const active = renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow
      .forwardReceiver;
    const color = entryWorks(
      projected,
      active?.mode === 'screen' ? 'fs_forward_sun_shadow' : 'fs_opaque',
    );
    expect(
      color.some(({ bindings }) =>
        bindings.some(
          ({ groupIndex, binding, resourceKind }) =>
            groupIndex === 0 && binding === 12 && resourceKind === 'textureView',
        ),
      ),
    ).toBe(true);
  }
  world.despawn(light).unwrap();
  world.despawn(receiver).unwrap();
}

async function verifyAoCoexistence(
  renderer: Renderer,
  draw: (screen: boolean, tag: string, ao?: boolean) => Promise<ShadowFrame>,
) {
  const raw = await draw(false, 'ao-raw', true);
  const projected = await draw(true, 'ao-screen', true);
  const inspection = renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow
    .forwardReceiver;
  expect(inspection).toMatchObject({
    mode: 'screen',
    ambientOcclusion: true,
    format: 'rgba8unorm',
  });
  const works = entryWorks(projected, 'fs_forward_sun_shadow');
  expect(works.length).toBeGreaterThan(0);
  expect(entryWorks(projected, 'fs_ao_alpha')).toHaveLength(0);
  const directional = entryWorks(projected, 'fs_directional_rgba');
  expect(directional).toHaveLength(1);
  expect(directional[0]?.pipeline.descriptor).toMatchObject({
    desc: { fragment: { targets: [{ format: 'rgba8unorm', writeMask: 9 }] } },
  });
  const alphaTarget = directional[0]?.attachments?.colorViewHandleIds[0];
  expect(alphaTarget).toBeDefined();
  expect(renderer.inspect().standardLighting?.ambientOcclusion).toMatchObject({
    status: 'active',
    output: { channel: 'a' },
  });
  expect(renderer.inspect().perFramePassNames).not.toContain('ssao-calc');
  for (const work of works) {
    expect(
      work.bindings.some(({ groupIndex, binding }) => groupIndex === 0 && binding === 25),
    ).toBe(false);
    const mask = work.bindings.find(
      ({ groupIndex, binding }) => groupIndex === 0 && binding === 29,
    );
    expect(mask).toMatchObject({ resourceKind: 'textureView', resourceId: alphaTarget });
  }
  expectDirectionalEdgeParity(raw, projected, 'AO coexistence');
}

interface ProjectionTestOptions {
  readonly gather?: true;
  readonly fade?: true;
}

interface ShadowFrame {
  readonly model: ReturnType<typeof buildFrameModel>;
  readonly pixels: Float32Array;
}

async function verifyPunctualProjection(
  world: World,
  renderer: Renderer,
  draw: (screen: boolean, tag: string, ao?: boolean) => Promise<ShadowFrame>,
  graphGeneration: () => Promise<number | undefined>,
  sun: Parameters<World['set']>[0],
  camera: Parameters<World['set']>[0],
  evidence?: (name: string, bytes: string) => void,
) {
  world.set(sun, DirectionalLight, { intensity: 0.05 }).unwrap();
  const point = world
    .spawn(
      { component: Transform, data: { pos: [2, 0, -1] } },
      { component: PointLight, data: { intensity: 25, range: 10 } },
    )
    .unwrap();
  const spot = world
    .spawn(
      { component: Transform, data: { pos: [2, 0, -1] } },
      {
        component: SpotLight,
        data: {
          direction: [-2, 0, -3],
          intensity: 0,
          range: 10,
          innerConeDeg: 60,
          mapSize: 256,
          depthBias: 0.001,
          normalBias: 0,
          castShadow: false,
        },
      },
    )
    .unwrap();
  const pointLit = await draw(false, 'point-lit');
  world
    .addComponent(point, {
      component: PointLightShadow,
      data: { mapSize: 256, depthBias: 0.001, normalBias: 0, farPlane: 10 },
    })
    .unwrap();
  // The initial screen profile reserves R for a live sun. Its contribution is
  // identical in every fixture and is measured separately from the punctual lights.
  const pointRaw = await draw(false, 'point-raw');
  const pointScreen = await draw(true, 'point-screen');
  expect(renderer.inspect({ fields: ['pointShadow'] }).pointShadow).toMatchObject({
    status: 'ready',
    requested: 1,
    shadowed: 1,
  });
  expect(entryWorks(pointScreen, 'vs_point_volume')[0]?.pipeline.descriptor).toMatchObject({
    desc: { depthStencil: { depthCompare: 'always' }, primitive: { cullMode: 'front' } },
  });
  world.set(point, PointLightShadow, { shadowFilter: 1 }).unwrap();
  const basicPoint = await draw(true, 'point-basic');
  expect(entryWorks(basicPoint, 'fs_point_basic')).toHaveLength(1);
  expect(maxPixelDelta(pointLit, basicPoint)).toBeGreaterThan(0.1);
  world.set(point, PointLightShadow, { shadowFilter: 6 }).unwrap();
  world.set(camera, Transform, { pos: [0.12, 0.08, 14] }).unwrap();
  const pointVolumeRaw = await draw(false, 'point-volume-raw');
  const pointVolumeScreen = await draw(true, 'point-volume-screen');
  expect(entryWorks(pointVolumeScreen, 'vs_point_volume')).toHaveLength(1);
  expect(maxPixelDelta(pointVolumeRaw, pointVolumeScreen, true)).toBeLessThanOrEqual(0.02);
  world.set(camera, Transform, { pos: [0.12, 0.08, 0] }).unwrap();
  world.set(point, PointLight, { intensity: 0 }).unwrap();
  world.set(spot, SpotLight, { intensity: 25 }).unwrap();
  const spotLit = await draw(false, 'spot-lit');
  world.set(spot, SpotLight, { castShadow: true }).unwrap();
  const spotRaw = await draw(false, 'spot-raw');
  const spotScreen = await draw(true, 'spot-screen');
  for (const [kind, lit, raw, screen] of [
    ['point', pointLit, pointRaw, pointScreen],
    ['spot', spotLit, spotRaw, spotScreen],
  ] as const) {
    const occlusion = maxPixelDelta(lit, raw);
    const projectionError = maxPixelDelta(raw, screen, true);
    evidence?.(`${kind}-pixel-metrics.json`, JSON.stringify({ occlusion, projectionError }));
    expect(occlusion, kind).toBeGreaterThan(0.1);
    expect(maxPixelDelta(lit, screen), kind).toBeGreaterThan(0.1);
    expect(projectionError, kind).toBeLessThanOrEqual(0.015);
    expect(entryWorks(screen, `fs_${kind}`)).toHaveLength(1);
    verifyScreenBindings(screen);
  }
  world.set(point, PointLight, { intensity: 25 }).unwrap();
  const mixedRaw = await draw(false, 'mixed-raw');
  const mixedScreen = await draw(true, 'mixed-screen');
  const mixedError = maxPixelDelta(mixedRaw, mixedScreen, true);
  evidence?.('mixed-pixel-metrics.json', JSON.stringify({ mixedError }));
  expect(mixedError).toBeLessThanOrEqual(0.025);
  verifyScreenBindings(mixedScreen);
  expect(entryWorks(mixedScreen, 'fs_point')).toHaveLength(1);
  expect(entryWorks(mixedScreen, 'fs_spot')).toHaveLength(1);
  expect(
    renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
  ).toMatchObject({
    mode: 'screen',
    format: 'rgba8unorm',
    projectedLights: 3,
    punctual: { channelCount: 2, point: true, spot: 'uniform' },
  });
  const extraSpots = [15, -15].map((x) =>
    world
      .spawn(
        { component: Transform, data: { pos: [2 + x, 0, -1] } },
        {
          component: SpotLight,
          data: { direction: [-2, 0, -3], intensity: 25, range: 1, castShadow: true, mapSize: 256 },
        },
      )
      .unwrap(),
  );
  const reused = await draw(true, 'reuse-screen');
  expect(maxPixelDelta(mixedScreen, reused, true)).toBe(0);
  const spotWrites = entryWorks(reused, 'fs_spot');
  // The two offscreen Spots never enter the View's channel allocation.
  expect(spotWrites).toHaveLength(1);
  expect(spotWrites[0]?.pipeline.descriptor).toMatchObject({
    desc: { fragment: { targets: [{ format: 'rgba8unorm', writeMask: 2 }] } },
  });
  expect(
    renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
  ).toMatchObject({ mode: 'screen', projectedLights: 3, punctual: { channelCount: 2 } });
  const movingSpot = extraSpots[0];
  if (movingSpot === undefined) throw new Error('missing additional Spot');
  const beforeMotion = await graphGeneration();
  world.set(movingSpot, Transform, { pos: [12.5, 0, -1] }).unwrap();
  expect(beforeMotion).toBeDefined();
  expect(await graphGeneration()).toBe(beforeMotion);
  expect(
    renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
  ).toMatchObject({ mode: 'screen', projectedLights: 3, punctual: { channelCount: 2 } });
  for (const entity of extraSpots) {
    world.set(entity, Transform, { pos: [2, 0, -1] }).unwrap();
    world.set(entity, SpotLight, { range: 10 }).unwrap();
  }
  const overflow = await draw(true, 'overflow-screen');
  const overflowRaw = await draw(false, 'overflow-raw');
  expect(maxPixelDelta(overflowRaw, overflow, true)).toBe(0);
  expect(entryWorks(overflow, 'fs_forward_sun_shadow')).toHaveLength(0);
  await draw(true, 'overflow-check');
  expect(
    renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
  ).toEqual({ mode: 'raw', reason: 'channel-overflow' });
  for (const entity of extraSpots)
    world.set(entity, SpotLight, { castShadow: false, intensity: 0 }).unwrap();
  const recovered = await draw(true, 'recovered-screen');
  expect(maxPixelDelta(mixedScreen, recovered, true)).toBeLessThanOrEqual(0.007);
  verifyScreenBindings(recovered);
  await verifyLocalOnlyChannels(world, renderer, draw, sun, extraSpots);
}

async function verifyLocalOnlyChannels(
  world: World,
  renderer: Renderer,
  draw: (screen: boolean, tag: string, ao?: boolean) => Promise<ShadowFrame>,
  sun: Parameters<World['set']>[0],
  extraSpots: readonly (typeof sun)[],
) {
  world.set(sun, DirectionalLight, { castShadow: false, intensity: 0.3 }).unwrap();
  for (const entity of extraSpots) {
    // Keep the bias policy equal across the two receivers. The allocation
    // control needs three overlapping Spot lights with visible shadows.
    world
      .set(entity, SpotLight, {
        castShadow: true,
        intensity: 25,
        depthBias: 0.001,
        normalBias: 0,
      })
      .unwrap();
  }
  const raw = await draw(false, 'local-only-raw');
  const screen = await draw(true, 'local-only-screen');
  expect(maxPixelDelta(raw, screen, true)).toBeLessThanOrEqual(0.025);
  expect(
    renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
  ).toMatchObject({
    mode: 'screen',
    directional: false,
    projectedLights: 4,
    punctual: {
      channelCount: 4,
      lights: expect.arrayContaining([
        expect.objectContaining({ slot: expect.any(Number), entity: expect.any(Number) }),
      ]),
    },
  });
  for (const entity of extraSpots) world.set(entity, SpotLight, { normalBias: 0.1 }).unwrap();
  const biased = await draw(true, 'local-only-normal-bias-ignored');
  expect(maxPixelDelta(screen, biased, true)).toBe(0);
  for (const entity of extraSpots) world.set(entity, SpotLight, { normalBias: 0 }).unwrap();
  const skylight = world.spawn({ component: Skylight, data: {} }).unwrap();
  const rawAo = await draw(false, 'local-only-ao-raw', true);
  const overflowAo = await draw(true, 'local-only-ao-overflow', true);
  expect(
    renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
  ).toEqual({ mode: 'raw', reason: 'channel-overflow' });
  expect(maxPixelDelta(rawAo, overflowAo, true)).toBe(0);
  expect(entryWorks(overflowAo, 'fs_forward_sun_shadow')).toHaveLength(0);

  const extraSpot = extraSpots[0];
  if (extraSpot === undefined) throw new Error('missing overlapping Spot');
  world.set(extraSpot, SpotLight, { castShadow: false }).unwrap();
  const threeShadowsRawAo = await draw(false, 'local-only-three-ao-raw', true);
  // Keep the projected receiver selected across the AO-only toggle.
  const screenAoOff = await draw(true, 'local-only-skylight');
  const screenAo = await draw(true, 'local-only-ao-screen', true);
  expect(maxPixelDelta(screenAoOff, screenAo, true)).toBeGreaterThan(0.002);
  expect(maxPixelDelta(threeShadowsRawAo, screenAo, true)).toBeLessThanOrEqual(0.025);
  expect(
    renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
  ).toMatchObject({
    mode: 'screen',
    ambientOcclusion: true,
    projectedLights: 3,
    punctual: { channelCount: 3 },
  });
  world.set(extraSpot, SpotLight, { castShadow: true }).unwrap();
  world.despawn(skylight).unwrap();

  expect(entryWorks(screenAo, 'fs_ao_alpha')).toHaveLength(0);
  const directionAndAo = entryWorks(screenAo, 'fs_directional_rgba');
  expect(directionAndAo).toHaveLength(1);
  expect(directionAndAo[0]?.pipeline.descriptor).toMatchObject({
    desc: { fragment: { targets: [{ format: 'rgba8unorm', writeMask: 9 }] } },
  });
  const maskTarget = directionAndAo[0]?.attachments?.colorViewHandleIds[0];
  expect(maskTarget).toBeDefined();
  const projectedEntry = 'fs_forward_sun_shadow';
  const receiverPrograms = (frame: ShadowFrame) =>
    new Set(
      entryWorks(frame, projectedEntry).map(({ pipeline }) =>
        JSON.stringify(
          pipeline.shaders.map(({ stage, entryPoint, source }) => ({ stage, entryPoint, source })),
        ),
      ),
    );
  expect(receiverPrograms(screenAo)).toEqual(receiverPrograms(screenAoOff));
  const receivers = entryWorks(screenAo, projectedEntry);
  expect(receivers.length).toBeGreaterThan(0);
  for (const { bindings } of receivers) {
    expect(bindings).toContainEqual(
      expect.objectContaining({ groupIndex: 0, binding: 29, resourceId: maskTarget }),
    );
    expect(
      bindings.some(
        ({ groupIndex, binding }) => groupIndex === 0 && [3, 5, 8, 24, 25].includes(binding),
      ),
    ).toBe(false);
  }
  const localProjectionWorks = (frame: ShadowFrame) => [
    ...entryWorks(frame, 'fs_point'),
    ...entryWorks(frame, 'fs_spot'),
  ];
  const local = localProjectionWorks(screen);
  expect(local).toHaveLength(4);
  expect(entryWorks(screen, 'fs_directional_rgba')).toHaveLength(0);
  const shadowWriteMask = (work: (typeof local)[number]) => {
    expect(work.pipeline.descriptor).toMatchObject({
      desc: { fragment: { targets: [{ format: 'rgba8unorm', writeMask: expect.any(Number) }] } },
    });
    const descriptor = work.pipeline.descriptor as {
      desc: { fragment: { targets: readonly { writeMask: number }[] } };
    };
    return descriptor.desc.fragment.targets[0]?.writeMask;
  };
  expect(new Set(local.map(shadowWriteMask))).toEqual(new Set([1, 2, 4, 8]));
  expect(new Set(localProjectionWorks(screenAo).map(shadowWriteMask))).toEqual(new Set([1, 2, 4]));
  world
    .spawn(
      { component: Transform, data: { pos: [2, 0, -1] } },
      {
        component: SpotLight,
        data: { direction: [-2, 0, -3], intensity: 25, range: 10, castShadow: true, mapSize: 256 },
      },
    )
    .unwrap();
  const overflowRaw = await draw(false, 'local-only-overflow-raw');
  const overflow = await draw(true, 'local-only-overflow');
  expect(
    renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
  ).toEqual({ mode: 'raw', reason: 'channel-overflow' });
  expect(maxPixelDelta(overflowRaw, overflow, true)).toBe(0);
}

async function verifyCompactSpotProjection(
  world: World,
  renderer: Renderer,
  draw: (
    screen: boolean,
    tag: string,
    ao?: boolean,
    projection?: ProjectionTestOptions,
  ) => Promise<ShadowFrame>,
  camera: Parameters<World['set']>[0],
  sun: Parameters<World['set']>[0],
) {
  // Keep the compact Spot's entire proxy in front of the camera near plane.
  world.set(camera, Transform, { pos: [0.12, 0.08, 8.5] }).unwrap();
  const spot = world
    .spawn(
      { component: Transform, data: { pos: [2, 0, -1] } },
      {
        component: SpotLight,
        data: {
          direction: [-2, 0, -3],
          intensity: 120,
          range: 5,
          innerConeDeg: 60,
          mapSize: 256,
          depthBias: 0.001,
          normalBias: 0,
          castShadow: false,
        },
      },
    )
    .unwrap();
  const lit = await draw(false, 'compact-spot-lit');
  world.set(spot, SpotLight, { castShadow: true }).unwrap();
  const raw = await draw(false, 'compact-spot-raw');
  const screen = await draw(true, 'compact-spot-screen');
  expect(maxPixelDelta(lit, raw)).toBeGreaterThan(0.1);
  expect(maxPixelDelta(raw, screen, true)).toBeLessThanOrEqual(0.015);
  expect(entryWorks(screen, 'fs_spot_compact')).toHaveLength(1);
  expect(entryWorks(screen, 'vs_spot_volume')).toHaveLength(1);
  verifyScreenBindings(screen);
  const gather = await draw(true, 'compact-spot-gather', false, { gather: true });
  expect(entryWorks(gather, 'fs_spot_gather')).toHaveLength(1);
  expect(maxPixelDelta(lit, gather)).toBeGreaterThan(0.1);
  verifyScreenBindings(gather);
  const tiny = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -1] } },
      {
        component: SpotLight,
        data: {
          direction: [0, 0, -1],
          intensity: 25,
          range: 0.85,
          outerConeDeg: 20,
          castShadow: true,
          mapSize: 256,
        },
      },
    )
    .unwrap();
  await draw(true, 'small-spot-active');
  expect(
    renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
  ).toMatchObject({ mode: 'screen', projectedLights: 3 });
  await draw(true, 'small-spot-faded', false, { fade: true });
  expect(
    renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
  ).toMatchObject({ mode: 'screen', projectedLights: 2 });
  world.set(sun, DirectionalLight, { castShadow: false }).unwrap();
  world.set(spot, SpotLight, { castShadow: false }).unwrap();
  const neutral = await draw(true, 'all-spot-shadows-faded', false, { fade: true });
  expect(entryWorks(neutral, 'fs_forward_sun_shadow').length).toBeGreaterThan(0);
  expect(entryWorks(neutral, 'fs_spot_compact')).toHaveLength(0);
  expect(
    renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
  ).toMatchObject({ mode: 'screen', directional: false, projectedLights: 0 });
  world.set(sun, DirectionalLight, { castShadow: true }).unwrap();
  world.set(spot, SpotLight, { castShadow: true }).unwrap();
  world.set(tiny, SpotLight, { shadowIntensity: 0 }).unwrap();
  await draw(true, 'small-spot-zero-opacity');
  expect(
    renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
  ).toMatchObject({ mode: 'screen', projectedLights: 2 });
  world.set(tiny, SpotLight, { castShadow: false, intensity: 0 }).unwrap();
  world.set(camera, Transform, { scale: [-1, 1, 1] }).unwrap();
  const reflectedRaw = await draw(false, 'reflected-spot-raw');
  const reflectedScreen = await draw(true, 'reflected-spot-screen');
  expect(entryWorks(reflectedScreen, 'vs_spot_volume')[0]?.pipeline.descriptor).toMatchObject({
    desc: { primitive: { cullMode: 'front' } },
  });
  expect(maxPixelDelta(reflectedRaw, reflectedScreen, true)).toBeLessThanOrEqual(0.015);
  world.set(camera, Transform, { scale: [1, 1, 1] }).unwrap();
  expect(
    renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
  ).toMatchObject({ mode: 'screen', punctual: { point: false, spot: 'compact' } });
  world
    .spawn(
      { component: Transform, data: { pos: [2, 0, -1] } },
      { component: PointLight, data: { intensity: 10, range: 10 } },
      { component: PointLightShadow, data: { mapSize: 256, farPlane: 10 } },
    )
    .unwrap();
  const fallback = await draw(true, 'point-publication-fallback');
  expect(entryWorks(fallback, 'fs_forward_sun_shadow')).toHaveLength(0);
  expect(
    renderer.inspect({ fields: ['directionalShadow'] }).directionalShadow.forwardReceiver,
  ).toEqual({ mode: 'raw', reason: 'shadow-family' });
}

// The fixed receiver squares visibility and shifts its PCF taps along the
// receiving plane. Compare stable interiors at the original HDR tolerance.
function expectDirectionalEdgeParity(
  reference: ShadowFrame,
  projected: ShadowFrame,
  label: string,
) {
  expect(projected.pixels.length, label).toBe(reference.pixels.length);
  const side = Math.sqrt(reference.pixels.length);
  expect(Number.isInteger(side), label).toBe(true);
  const tolerance = 0.007;
  const radius = 2;
  const mismatches: number[] = [];
  for (const [index, value] of reference.pixels.entries()) {
    const error = Math.abs(value - (projected.pixels[index] ?? 0));
    if (error <= tolerance) continue;
    const x = index % side;
    const y = Math.floor(index / side);
    let atEdge = false;
    for (let dy = Math.max(0, y - radius); dy <= Math.min(side - 1, y + radius); dy++) {
      for (let dx = Math.max(0, x - radius); dx <= Math.min(side - 1, x + radius); dx++) {
        if (Math.abs((reference.pixels[dy * side + dx] ?? 0) - value) > tolerance) atEdge = true;
      }
    }
    if (!atEdge) mismatches.push(index);
  }
  expect(mismatches, label).toEqual([]);
}

function maxPixelDelta(a: ShadowFrame, b: ShadowFrame, absolute = false): number {
  return a.pixels.reduce((max, value, i) => {
    const delta = value - (b.pixels[i] ?? 0);
    return Math.max(max, absolute ? Math.abs(delta) : delta);
  }, 0);
}

function entryWorks(frame: ShadowFrame, entry: string) {
  return frame.model.works.filter(({ pipeline }) =>
    pipeline.shaders.some(({ entryPoint }) => entryPoint === entry),
  );
}

function verifyDepthOnlyProjection(frame: ShadowFrame) {
  const opaque = entryWorks(frame, 'fs_forward_sun_shadow')[0];
  const sceneDepth = opaque?.attachments?.depthStencilViewHandleId;
  expect(sceneDepth).toBeTruthy();
  expect(
    frame.model.passes.some(
      (pass) =>
        pass.passIndex < (opaque?.passIndex ?? 0) &&
        pass.depthStencilViewHandleId === sceneDepth &&
        pass.colorAttachmentViewHandleIds.length === 0,
    ),
  ).toBe(true);
  for (const work of entryWorks(frame, 'vs_position_only')) {
    expect(work.bindings.filter(({ resourceKind }) => resourceKind === 'textureView')).toEqual([]);
  }
  const projection = frame.model.works.filter((work) => {
    const descriptor = work.pipeline.descriptor as { desc?: { label?: string } } | undefined;
    const label = descriptor?.desc?.label;
    return label === 'forward-directional-shadow' || label?.startsWith('forward-shadow-');
  });
  expect(projection.length).toBeGreaterThan(0);
  for (const work of projection) {
    expect(
      work.bindings
        .filter(
          ({ groupIndex, resourceKind }) => groupIndex === 1 && resourceKind === 'textureView',
        )
        .map(({ binding }) => binding),
    ).toEqual([0]);
  }
}

function verifyScreenBindings(frame: ShadowFrame) {
  const directional = entryWorks(frame, 'fs_directional_rgba');
  expect(directional).toHaveLength(1);
  expect(directional[0]?.pipeline.descriptor).toMatchObject({
    desc: { fragment: { targets: [{ format: 'rgba8unorm' }] } },
  });
  const maskId = directional[0]?.attachments?.colorViewHandleIds[0];
  expect(maskId).toBeDefined();
  verifyDepthOnlyProjection(frame);
  const opaque = entryWorks(frame, 'fs_forward_sun_shadow');
  expect(opaque.length).toBeGreaterThan(0);
  for (const { bindings } of opaque) {
    expect(
      bindings.filter(
        ({ groupIndex, binding, resourceKind }) =>
          groupIndex === 0 && resourceKind === 'textureView' && [3, 5, 8, 24].includes(binding),
      ),
    ).toEqual([]);
    expect(
      bindings.some(
        ({ groupIndex, binding, resourceKind, resourceId }) =>
          groupIndex === 0 &&
          binding === 29 &&
          resourceKind === 'textureView' &&
          resourceId === maskId,
      ),
    ).toBe(true);
  }
}
