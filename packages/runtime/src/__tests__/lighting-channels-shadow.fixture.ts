import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PointLightShadow,
  type Renderer,
  ShadowParticipation,
  SpotLight,
} from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  type EncodedTape,
  type RecorderAttachment,
} from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { compactTape } from './compact-tape.fixture';
import { luminanceRgba16f } from './contact-shadow.fixture';
import { testAssets } from './helpers/runtime-assets';
import { CHANNEL_EPSILON, CHANNEL_SIZE } from './lighting-channels.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

/** A visible receiver and off-center caster separate direct matching from casting. */
export async function verifyChannelShadows(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: (name: string, tape: EncodedTape, image: Float32Array, facts: unknown) => Promise<void>,
) {
  const world = new World();
  const strengths = { directional: 3, point: 20, spot: 20 } as const;
  const receiverMesh = testAssets(world)
    .create(createBoxGeometry(2, 2, 0.05).unwrap())
    .unwrap();
  const casterMesh = testAssets(world)
    .create(createBoxGeometry(0.4, 0.4, 0.2).unwrap())
    .unwrap();
  const material = testAssets(world)
    .create(
      Materials.standard({
        baseColor: [0.5, 0.5, 0.5, 1],
        roughness: 0.7,
        emissive: [0.02, 0.02, 0.02],
        emissiveIntensity: 1,
      }),
    )
    .unwrap();
  const receiver = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -4] } },
      { component: MeshFilter, data: { assetHandle: receiverMesh } },
      { component: MeshRenderer, data: { materials: [material], lightingChannels: 1 } },
      { component: ShadowParticipation, data: { cast: false } },
    )
    .unwrap();
  const caster = world
    .spawn(
      { component: Transform, data: { pos: [2 / 3, 0, -3] } },
      { component: MeshFilter, data: { assetHandle: casterMesh } },
      { component: MeshRenderer, data: { materials: [material], lightingChannels: 2 } },
      { component: ShadowParticipation, data: {} },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 20,
          tonemap: 0,
          bloom: 0,
          antialias: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  const sun = world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-2 / 3, 0, -1],
        intensity: strengths.directional,
        lightingChannels: 0,
        castShadow: false,
        mapSize: testQuality.shadowMapSize,
        shadowDistance: 12,
        depthBias: 0.001,
        normalBias: 0,
        shadowFilter: 1,
      },
    })
    .unwrap();
  const point = world
    .spawn(
      { component: Transform, data: { pos: [2, 0, -1] } },
      {
        component: PointLight,
        data: { intensity: strengths.point, range: 10, lightingChannels: 0 },
      },
    )
    .unwrap();
  const spot = world
    .spawn(
      { component: Transform, data: { pos: [2, 0, -1] } },
      {
        component: SpotLight,
        data: {
          direction: [-2, 0, -3],
          intensity: strengths.spot,
          // Pixel evidence was recorded with the former hard 60-degree cone.
          innerConeDeg: 60,
          range: 10,
          lightingChannels: 0,
          castShadow: false,
          mapSize: testQuality.shadowMapSize,
          depthBias: 0.001,
          normalBias: 0,
        },
      },
    )
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const setLight = (
    kind: 'directional' | 'point' | 'spot',
    mask: number,
    shadows: boolean,
    enabled = true,
  ) => {
    world
      .set(sun, DirectionalLight, {
        lightingChannels: kind === 'directional' ? mask : 0,
        intensity: enabled ? strengths.directional : 0,
        castShadow: kind === 'directional' && shadows,
      })
      .unwrap();
    world
      .set(point, PointLight, {
        lightingChannels: kind === 'point' ? mask : 0,
        intensity: enabled ? strengths.point : 0,
      })
      .unwrap();
    world
      .set(spot, SpotLight, {
        lightingChannels: kind === 'spot' ? mask : 0,
        intensity: enabled ? strengths.spot : 0,
        castShadow: kind === 'spot' && shadows,
      })
      .unwrap();
    if (world.hasComponent(point, PointLightShadow))
      world.removeComponent(point, PointLightShadow).unwrap();
    if (kind === 'point' && shadows)
      world
        .addComponent(point, {
          component: PointLightShadow,
          data: {
            mapSize: testQuality.shadowMapSize,
            depthBias: 0.001,
            normalBias: 0,
            farPlane: 10,
          },
        })
        .unwrap();
  };
  const draw = async (capture = false) => {
    const pending = capture ? recorder.captureFrame() : undefined;
    if (pending) (await recorder.frameBoundary()).unwrap();
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const receipt = await drawReadyFrame(
      renderer,
      { leases: [lease], camera: { lease }, environment: { lease } },
      ['linear-hdr'],
    );
    if (pending) (await recorder.frameBoundary()).unwrap();
    const observation = renderValue(
      await renderer.observe(receipt, { include: ['linear-hdr'] }),
    ).observations?.find((value) => value.domain === 'linear-hdr');
    if (!observation) throw new Error('missing shadow-channel HDR');
    const image = luminanceRgba16f(observation.bytes, CHANNEL_SIZE, CHANNEL_SIZE);
    return { image, tape: pending ? compactTape((await pending).unwrap()) : undefined };
  };
  const roi = (image: Float32Array) => {
    const values: number[] = [];
    for (let y = 29; y < 35; y++)
      for (let x = 29; x < 35; x++) values.push(image[y * CHANNEL_SIZE + x] ?? NaN);
    return values;
  };
  const same = (a: Float32Array, b: Float32Array) => {
    const left = roi(a),
      right = roi(b);
    for (let i = 0; i < left.length; i++)
      expect(Math.abs((left[i] ?? NaN) - (right[i] ?? NaN))).toBeLessThanOrEqual(CHANNEL_EPSILON);
  };
  const mean = (image: Float32Array) => roi(image).reduce((sum, value) => sum + value, 0) / 36;
  try {
    for (const path of ['forward', 'deferred'] as const) {
      renderValue(renderer.setProfile({ ...renderer.inspect().profile, renderPath: path }));
      for (let frame = 0; frame < testQuality.staticFrames; frame++) await draw();
      for (const kind of ['directional', 'point', 'spot'] as const) {
        world.set(receiver, MeshRenderer, { lightingChannels: 1 }).unwrap();
        world.set(caster, MeshRenderer, { lightingChannels: 2 }).unwrap();
        world.set(caster, ShadowParticipation, { cast: true, receive: true }).unwrap();
        setLight(kind, 1, false);
        await draw();
        const lit = (await draw()).image;
        setLight(kind, 1, true);
        // Capture the producer before a stable frame can reuse its shadow map.
        const shadow = await draw(true);
        same(shadow.image, (await draw()).image);
        if (!shadow.tape) throw new Error('missing shadow oracle tape');
        await save(`${path}-${kind}-occlusion-oracle`, shadow.tape, shadow.image, {
          stage: 'before-occlusion-assert',
          lit: mean(lit),
          shadow: mean(shadow.image),
          litPixels: Array.from(lit),
        });
        expect(mean(lit) - mean(shadow.image), `${path}:${kind}: actual occlusion`).toBeGreaterThan(
          0.002,
        );
        world.set(caster, MeshRenderer, { lightingChannels: 1 }).unwrap();
        await draw();
        same(shadow.image, (await draw()).image);
        world.set(caster, ShadowParticipation, { cast: false }).unwrap();
        await draw();
        same(lit, (await draw()).image);
        world.set(caster, ShadowParticipation, { cast: true }).unwrap();
        world.set(receiver, ShadowParticipation, { receive: false }).unwrap();
        await draw();
        same(lit, (await draw()).image);
        // Capture a real producer after an authored caster-roster change;
        // an unchanged nonmatch frame may correctly reuse the shadow cache.
        world.set(caster, ShadowParticipation, { cast: false }).unwrap();
        await draw();
        world.set(receiver, ShadowParticipation, { receive: true }).unwrap();
        world.set(receiver, MeshRenderer, { lightingChannels: 2 }).unwrap();
        world.set(caster, ShadowParticipation, { cast: true }).unwrap();
        const nonmatch = await draw(true);
        setLight(kind, 0, true, false);
        await draw();
        same(nonmatch.image, (await draw()).image);
        for (const [state, sample] of [
          ['match-shadow', shadow],
          ['nonmatch-shadow', nonmatch],
        ] as const) {
          if (!sample.tape) throw new Error('missing shadow producer tape');
          const model = buildFrameModel(decodeTape(sample.tape.bytes).unwrap());
          const producers = model.works.filter(
            (work) =>
              work.attachments?.depthStencilViewHandleId !== null &&
              work.attachments?.colorViewHandleIds.length === 0,
          );
          await save(`${path}-${kind}-${state}`, sample.tape, sample.image, {
            lit: mean(lit),
            shadow: mean(shadow.image),
            nonmatch: mean(nonmatch.image),
            producers,
          });
          expect(producers.length).toBeGreaterThan(0);
        }
      }
    }
    expect(errors).toEqual([]);
  } finally {
    off();
    lease.dispose();
  }
}
