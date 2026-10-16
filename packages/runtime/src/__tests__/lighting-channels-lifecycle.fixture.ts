import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  type Renderer,
  type RenderWorldLease,
  Skylight,
} from '@forgeax/engine-render';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { decodeTape, type RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import type { RhiBackendInstrumentation } from '../../../render/src/assembly/backend-contract';
import { compactTape } from './compact-tape.fixture';
import { luminanceRgba16f } from './contact-shadow.fixture';
import { CHANNEL_EPSILON, CHANNEL_SIZE } from './lighting-channels.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

export function channelHostLoss(recorder: RecorderAttachment) {
  const signals: (() => void)[] = [];
  const instrumentation: RhiBackendInstrumentation = {
    onDeviceLost: () => recorder.deviceLost(),
    deviceLost: () =>
      new Promise<Awaited<RhiDevice['lost']>>((resolve) => {
        signals.push(() =>
          resolve({ reason: 'unknown', message: 'lighting-channels host loss injection' }),
        );
      }),
  };
  return {
    instrumentation,
    async recover(renderer: Renderer) {
      const trigger = signals.at(-1);
      if (trigger === undefined) throw new Error('missing host loss signal');
      trigger();
      for (let attempt = 0; renderer.state() !== 'device-lost' && attempt < 100; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(renderer.state()).toBe('device-lost');
      renderValue(await renderer.recover());
    },
  };
}

/** Different receiver masks in one batch, replacement assets, retirement and recovery. */
export async function verifyChannelLifecycle(
  renderer: Renderer,
  recorder: RecorderAttachment,
  loss: ReturnType<typeof channelHostLoss>,
  save: (name: string, bytes: Uint8Array) => void | Promise<void>,
  warmupFrames = testQuality.staticFrames,
) {
  const makeWorld = () => {
    const world = new World();
    const mesh = world.allocSharedRef('MeshAsset', createBoxGeometry(0.8, 1.2, 0.1).unwrap());
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({
        baseColor: [0.5, 0.5, 0.5, 1],
        roughness: 0.7,
        emissive: [0.02, 0.02, 0.02],
        emissiveIntensity: 1,
      }),
    );
    const receivers = [-0.6, 0.6].map((x, index) =>
      world
        .spawn(
          { component: Transform, data: { pos: [x, 0, -4] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          {
            component: MeshRenderer,
            data: { materials: [material], lightingChannels: index === 0 ? 0x80000000 : 1 },
          },
        )
        .unwrap(),
    );
    const sun = world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [0, 0, -1],
          intensity: 3,
          castShadow: false,
          lightingChannels: 0x80000000,
        },
      })
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
            antialias: 0,
            bloom: 0,
            tonemap: 0,
          },
        },
      )
      .unwrap();
    return { world, sun, receivers };
  };
  let scene = makeWorld();
  let lease: RenderWorldLease = renderValue(renderer.attach(scene.world));
  const samples: unknown[] = [];
  const draw = async (name?: string) => {
    scene.world.update(1 / 60).unwrap();
    propagateTransforms(scene.world).unwrap();
    const pending = name === undefined ? undefined : recorder.captureFrame();
    if (pending) (await recorder.frameBoundary()).unwrap();
    const receipt = await drawReadyFrame(
      renderer,
      { leases: [lease], camera: { lease }, environment: { lease } },
      ['linear-hdr'],
    );
    if (pending) {
      (await recorder.frameBoundary()).unwrap();
      const tape = compactTape((await pending).unwrap());
      await save(`${name}.rhitape`, tape.bytes);
      expect(
        decodeTape(tape.bytes)
          .unwrap()
          .events.filter((event) => event.kind === 'submit'),
      ).toHaveLength(1);
    }
    const observation = renderValue(
      await renderer.observe(receipt, { include: ['linear-hdr'] }),
    ).observations?.find((value) => value.domain === 'linear-hdr');
    if (observation === undefined) throw new Error('missing lifecycle HDR');
    const image = luminanceRgba16f(
      observation.bytes,
      CHANNEL_SIZE,
      CHANNEL_SIZE,
      observation.metadata.bytesPerRow,
    );
    if (name) {
      await save(`${name}.rgba16float`, observation.bytes);
      samples.push({
        name,
        generation: receipt.deviceGeneration,
        left: image[32 * CHANNEL_SIZE + 24],
        right: image[32 * CHANNEL_SIZE + 40],
      });
    }
    return image;
  };
  const center = (image: Float32Array, x: number) => image[32 * CHANNEL_SIZE + x] ?? NaN;
  const receiver = (index: number) => {
    const value = scene.receivers[index];
    if (value === undefined) throw new Error('missing lifecycle receiver');
    return value;
  };
  try {
    for (const path of ['forward', 'deferred'] as const) {
      renderValue(renderer.setProfile({ ...renderer.inspect().profile, renderPath: path }));
      for (let frame = 0; frame < warmupFrames; frame++) await draw();
      const initial = await draw(`${path}-different-masks`);
      expect(center(initial, 24) - center(initial, 40)).toBeGreaterThan(0.01);
      const fill = scene.world
        .spawn(
          { component: Transform, data: { pos: [0, 0, -2] } },
          { component: PointLight, data: { intensity: 1, range: 10 } },
        )
        .unwrap();
      const ambient = scene.world.spawn({ component: Skylight, data: { intensity: 0.1 } }).unwrap();
      scene.world.set(scene.sun, DirectionalLight, { lightingChannels: 0xffffffff }).unwrap();
      await draw();
      const beforeGrouping = await draw(`${path}-group-before`);
      scene.world.set(scene.sun, DirectionalLight, { lightingChannels: 0x80000000 }).unwrap();
      await draw();
      const afterGrouping = await draw(`${path}-group-after`);
      expect(Math.abs(center(beforeGrouping, 24) - center(afterGrouping, 24))).toBeLessThanOrEqual(
        CHANNEL_EPSILON,
      );
      expect(center(beforeGrouping, 40) - center(afterGrouping, 40)).toBeGreaterThan(0.01);
      scene.world.set(scene.sun, DirectionalLight, { lightingChannels: 0 }).unwrap();
      await draw();
      const remaining = await draw(`${path}-ambient-and-fill`);
      expect(Math.abs(center(afterGrouping, 40) - center(remaining, 40))).toBeLessThanOrEqual(
        CHANNEL_EPSILON,
      );
      expect(center(afterGrouping, 24) - center(remaining, 24)).toBeGreaterThan(0.01);
      scene.world.set(fill, PointLight, { lightingChannels: 0 }).unwrap();
      await draw();
      const ambientOnly = await draw(`${path}-ambient-only`);
      expect(center(remaining, 40) - center(ambientOnly, 40)).toBeGreaterThan(0.001);
      scene.world.set(ambient, Skylight, { intensity: 0 }).unwrap();
      scene.world.set(scene.sun, DirectionalLight, { intensity: 0 }).unwrap();
      scene.world.set(fill, PointLight, { intensity: 0 }).unwrap();
      await draw();
      const emissiveOnly = await draw(`${path}-emissive-only`);
      expect(center(ambientOnly, 40) - center(emissiveOnly, 40)).toBeGreaterThan(0.001);
      expect(center(emissiveOnly, 40)).toBeCloseTo(0.02, 3);
      scene.world.despawn(fill).unwrap();
      scene.world.despawn(ambient).unwrap();
      scene.world
        .set(scene.sun, DirectionalLight, { lightingChannels: 0x80000000, intensity: 3 })
        .unwrap();
      await draw();
      scene.world.set(receiver(0), MeshRenderer, { lightingChannels: 1 }).unwrap();
      scene.world.set(receiver(1), MeshRenderer, { lightingChannels: 0x80000000 }).unwrap();
      await draw();
      const exchanged = await draw(`${path}-mask-mutation`);
      expect(center(exchanged, 40) - center(exchanged, 24)).toBeGreaterThan(0.01);
      const replacement = scene.world.allocSharedRef(
        'MaterialAsset',
        Materials.standard({
          baseColor: [0.5, 0.5, 0.5, 1],
          roughness: 0.7,
          emissive: [0.05, 0.05, 0.05],
          emissiveIntensity: 1,
        }),
      );
      scene.world.set(receiver(0), MeshRenderer, { materials: [replacement] }).unwrap();
      await draw();
      const changed = await draw(`${path}-material-replacement`);
      expect(center(changed, 24) - center(exchanged, 24)).toBeGreaterThan(0.02);
      const generation = renderer.inspect().frame.deviceGeneration;
      await loss.recover(renderer);
      for (let frame = 0; frame < warmupFrames; frame++) await draw();
      const recovered = await draw(`${path}-recovered`);
      expect(renderer.inspect().frame.deviceGeneration).toBeGreaterThan(generation);
      for (const x of [24, 40])
        expect(Math.abs(center(changed, x) - center(recovered, x))).toBeLessThanOrEqual(
          CHANNEL_EPSILON,
        );
      scene.world.despawn(scene.sun).unwrap();
      await draw();
      const removed = await draw(`${path}-light-removed`);
      expect(center(removed, 40)).toBeCloseTo(0.02, 3);
      expect(center(removed, 24)).toBeCloseTo(0.05, 3);
      scene.world.despawn(receiver(0)).unwrap();
      await draw();
      expect(center(await draw(`${path}-receiver-removed`), 24)).toBeLessThan(CHANNEL_EPSILON);
      lease.dispose();
      scene = makeWorld();
      lease = renderValue(renderer.attach(scene.world));
      for (let frame = 0; frame < warmupFrames; frame++) await draw();
      const swapped = await draw(`${path}-world-swap`);
      for (const x of [24, 40])
        expect(Math.abs(center(initial, x) - center(swapped, x))).toBeLessThanOrEqual(
          CHANNEL_EPSILON,
        );
    }
    await save(
      'samples.json',
      new TextEncoder().encode(
        JSON.stringify(
          { recovery: 'unknown host signal; no native driver reset', samples },
          null,
          2,
        ),
      ),
    );
  } finally {
    lease.dispose();
  }
}
