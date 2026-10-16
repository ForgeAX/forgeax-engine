import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { expect, it } from 'vitest';
import { PointLight, SpotLight } from '../components';
import { validatePointLightDecay } from '../components/point-light';
import { packDirectLightSlot } from '../light-buffer-layout';
import { packLights } from '../raytracing/path-input';
import { extractFrames } from '../render-system-extract-tail';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing point-decay fixture value');
  return value;
}

it('defaults to inverse-square and carries authored point decay without changing Spot lanes', () => {
  const world = new World();
  const point = world.spawn({ component: PointLight, data: {} }).unwrap();
  world
    .spawn({
      component: SpotLight,
      data: { innerConeDeg: 10, outerConeDeg: 30, castShadow: false },
    })
    .unwrap();
  const assets = new AssetRegistry({} as never);
  const before = extractFrames([world], 0, assets).lights;
  expect(before.point[0]).toMatchObject({ decay: 2 });
  const spotBefore = packDirectLightSlot(required(before.spot[0]));
  world.set(point, PointLight, { decay: 1.4 }).unwrap();
  const after = extractFrames([world], 0, assets).lights;
  expect(after.point[0]?.decay).toBeCloseTo(1.4);
  expect(packDirectLightSlot(required(after.point[0]))[7]).toBeCloseTo(1.4);
  expect(packDirectLightSlot(required(after.point[0])).byteLength).toBe(96);
  const analytic = packLights([required(after.point[0])]).unwrap();
  expect(analytic.byteLength).toBe(64);
  const analyticFloats = new Float32Array(
    analytic.buffer,
    analytic.byteOffset,
    analytic.byteLength / 4,
  );
  expect(analyticFloats[7]).toBeCloseTo(1.4);
  expect(packDirectLightSlot(required(after.spot[0]))).toEqual(spotBefore);
});

it.each([0, 1.4, 2, 4, 3.4028234663852886e38])('accepts finite GPU exponent %s', (decay) => {
  expect(validatePointLightDecay(decay)).toBeNull();
});
it.each([
  -1,
  Infinity,
  -Infinity,
  Number.MAX_VALUE,
])('rejects invalid exponent %s before extraction', (decay) => {
  const world = new World();
  const point = world.spawn({ component: PointLight, data: { decay } }).unwrap();
  expect(world.get(point, PointLight).unwrap().decay).toBe(decay);
  expect(validatePointLightDecay(decay)).toMatchObject({
    code: 'resource-invalid-value',
    detail: { receivedKey: 'decay' },
  });
  expect(extractFrames([world], 0, new AssetRegistry({} as never)).lights.point).toHaveLength(0);
  world.set(point, PointLight, { decay: 1.4 }).unwrap();
  expect(
    extractFrames([world], 0, new AssetRegistry({} as never)).lights.point[0]?.decay,
  ).toBeCloseTo(1.4);
});
it('rejects NaN at the ECS numeric boundary', () => {
  expect(new World().spawn({ component: PointLight, data: { decay: NaN } })).toMatchObject({
    ok: false,
    error: { code: 'component-numeric-value-invalid' },
  });
});
