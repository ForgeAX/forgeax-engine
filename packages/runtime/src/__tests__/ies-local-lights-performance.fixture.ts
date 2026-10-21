import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  RectAreaLight,
  type Renderer,
} from '@forgeax/engine-render';
import { summarizeGpuPassTimingIntervals } from '@forgeax/engine-render/internal';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { toShared } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { testAssets } from './helpers/runtime-assets';
import { type IesLightKind, localIesProfile } from './ies-local-lights.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

/** Fixed overdraw workload; real pass timestamps, alternating 60-frame windows. */
export async function measureLocalIes(renderer: Renderer, kind: IesLightKind, count: number) {
  const world = new World();
  const component = kind === 'point' ? PointLight : RectAreaLight;
  const handles = Array.from({ length: Math.min(32, count) }, (_, i) => {
    const profile = localIesProfile('uniform');
    // Distinct payloads avoid measuring only repeated bindings to one cache line.
    new DataView(profile.data.buffer).setUint16(i * 2, 0x3800, true);
    return testAssets(world).create(profile).unwrap();
  });
  const mesh = testAssets(world).create(createPlaneGeometry(6, 6).unwrap()).unwrap();
  const material = testAssets(world)
    .create(Materials.standard({ baseColor: [0.7, 0.7, 0.7, 1], roughness: 0.5 }))
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 6] } },
      {
        component: Camera,
        data: { projection: 1, left: -3, right: 3, bottom: -3, top: 3, near: 0.1, far: 20 },
      },
    )
    .unwrap();
  const lights = Array.from({ length: count }, (_, i) =>
    world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [((i % 8) - 3.5) * 0.2, ((Math.floor(i / 8) % 8) - 3.5) * 0.2, 2.5],
            quat: [0, 1, 0, 0],
          },
        },
        { component, data: { intensity: 10 / count, range: 20 } },
      )
      .unwrap(),
  );
  const lease = renderValue(renderer.attach(world));
  renderValue(
    renderer.setProfile({
      ...renderer.inspect().profile,
      renderPath: 'deferred',
      lightCount: 256,
      ibl: false,
    }),
  );
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const draw = async () => {
    const began = performance.now();
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const receipt = renderValue(
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
    );
    const cpuMs = performance.now() - began;
    renderValue(await receipt.completed);
    const timing = renderValue(await renderer.observe(receipt, { include: ['timings'] })).timings;
    if (timing?.status !== 'complete')
      throw new Error(`IES GPU timing unavailable: ${JSON.stringify(timing)}`);
    const intervals = summarizeGpuPassTimingIntervals(
      timing.frame.passes,
      timing.frame.timestampPeriodNanoseconds,
    ).unwrap();
    expect(intervals.unmeasuredPassCount).toBe(0);
    return { cpuMs, intervals, passes: timing.frame.passes };
  };
  const windows = [];
  try {
    for (let frame = 0; frame < 60; frame++) await draw();
    for (let round = 0; round < 3; round++) {
      const variants =
        round % 2 === 0
          ? (['none', 'shared', 'distinct'] as const)
          : (['distinct', 'shared', 'none'] as const);
      for (const variant of variants) {
        for (const [i, entity] of lights.entries()) {
          const profile =
            variant === 'none'
              ? toShared<'IesProfileAsset'>(0)
              : handles[variant === 'shared' ? 0 : i % handles.length];
          if (profile === undefined) throw new Error('missing performance profile');
          world.set(entity, component, { iesProfile: profile }).unwrap();
        }
        for (let frame = 0; frame < 10; frame++) await draw();
        const frames = [];
        for (let frame = 0; frame < 60; frame++) frames.push(await draw());
        windows.push({ round, variant, frames });
      }
    }
    expect(errors).toEqual([]);
    const passCounts = windows.flatMap((window) =>
      window.frames.map((frame) => frame.passes.length),
    );
    expect(new Set(passCounts).size).toBe(1);
    return { kind, count, frameCountPerWindow: 60, rounds: 3, path: 'deferred', windows };
  } finally {
    off();
    lease.dispose();
  }
}
