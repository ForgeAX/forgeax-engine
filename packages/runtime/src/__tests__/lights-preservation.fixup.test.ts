import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { Camera, PointLight, SpotLight } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import {
  computeInvRangeSquared,
  degToCos,
  validatePointLightShadowData,
  validateSpotLightData,
} from '../../../render/src/components/light-helpers';
import {
  DIRECT_LIGHT_SLOT_KIND_MASK,
  packDirectLightSlot,
} from '../../../render/src/light-buffer-layout';
import { buildPbrViewBglEntries } from '../../../render/src/pbr-pipeline';
import type {
  PointLightSnapshot,
  SpotLightSnapshot,
} from '../../../render/src/render-system-extract';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';

function pointSnapshot(): PointLightSnapshot {
  return {
    kind: 'point',
    position: vec3.create(1, 2, 3),
    color: vec3.create(2, 1, 0.5),
    intensity: 2,
    invRangeSquared: 0.25,
  };
}

function spotSnapshot(): SpotLightSnapshot {
  return {
    kind: 'spot',
    position: vec3.create(1, 2, 3),
    direction: vec3.create(0, -1, 0),
    color: vec3.create(2, 1, 0.5),
    intensity: 2,
    invRangeSquared: 0.25,
    cosInner: degToCos(15),
    cosOuter: degToCos(30),
    castShadow: false,
    lightViewProj: undefined,
    mapSize: 512,
    nearPlane: 0.1,
    farPlane: 25,
    shadowAtlasTile: -1,
  };
}

describe('Point/Spot and shared-light regression guard', () => {
  it('keeps extract facts for point range and spot cone in the shared light path', () => {
    const world = new World();
    const pointSpawn = world.spawn(
      { component: Transform, data: { pos: [1, 2, 3] } },
      { component: PointLight, data: { range: 2 } },
    );
    const spotSpawn = world.spawn(
      { component: Transform, data: { pos: [4, 5, 6] } },
      {
        component: SpotLight,
        data: {
          castShadow: true,
          direction: [0, -1, 0],
          range: 4,
          innerConeDeg: 15,
          outerConeDeg: 30,
        },
      },
    );
    world.spawn(
      { component: Transform, data: {} },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
    );
    expect(pointSpawn.ok, JSON.stringify(pointSpawn)).toBe(true);
    expect(spotSpawn.ok, JSON.stringify(spotSpawn)).toBe(true);

    const lights = extractFrame(world, prepareExtractContext(world)).lights;
    expect(lights.point).toHaveLength(1);
    expect(lights.point[0]?.invRangeSquared).toBeCloseTo(0.25, 6);
    expect(lights.spot).toHaveLength(1);
    expect(lights.spot[0]?.cosInner).toBeCloseTo(degToCos(15), 6);
    expect(lights.spot[0]?.cosOuter).toBeCloseTo(degToCos(30), 6);
  });

  it('keeps attenuation and cone helpers as finite, shared semantic owners', () => {
    expect(computeInvRangeSquared(2)).toBeCloseTo(0.25, 8);
    expect(computeInvRangeSquared(0)).toBe(1e8);
    expect(computeInvRangeSquared(Number.POSITIVE_INFINITY)).toBe(0);
    expect(degToCos(0)).toBeCloseTo(1, 8);
    expect(degToCos(60)).toBeCloseTo(0.5, 8);
  });

  it('keeps Point/Spot packing in the shared DirectLightSlot owner', () => {
    const point = pointSnapshot();
    const spot = spotSnapshot();
    const pointSlot = packDirectLightSlot({ ...point, shadowAtlasLayer: 2 });
    const spotSlot = packDirectLightSlot(spot);

    expect(pointSlot.byteLength).toBe(96);
    expect(spotSlot.byteLength).toBe(96);
    expect(new Uint32Array(pointSlot.buffer)[16]).toBe(0);
    expect(new Uint32Array(pointSlot.buffer)[17]).toBe(2);
    expect((new Uint32Array(spotSlot.buffer)[16] ?? 0) & DIRECT_LIGHT_SLOT_KIND_MASK).toBe(1);
    expect(new Uint32Array(spotSlot.buffer)[17]).toBe(0xffffffff);
  });

  it('keeps local lights out of the PBR view group and gates cube-array point shadows', () => {
    const storageBindings = buildPbrViewBglEntries({ storageBuffer: true });
    const uniformBindings = buildPbrViewBglEntries({ storageBuffer: false });
    expect(storageBindings.filter((entry) => entry.binding !== 5 && entry.binding !== 6)).toEqual(
      uniformBindings,
    );
    expect(storageBindings.find((entry) => entry.binding === 5)?.texture).toEqual({
      sampleType: 'depth',
      viewDimension: 'cube-array',
    });
    expect(storageBindings.find((entry) => entry.binding === 6)?.buffer?.type).toBe('uniform');
    expect(uniformBindings.find((entry) => entry.binding === 5)).toBeUndefined();
    expect(uniformBindings.find((entry) => entry.binding === 6)).toBeUndefined();
    // Local lights are consumed through the cluster payload in group(2). The
    // shared view group therefore has no legacy direct-light storage/uniform
    // entries at bindings 1/2. Only point-shadow bindings 5/6 differ between
    // these profiles; cube-array textures are unavailable without storage.
    expect(storageBindings.find((entry) => entry.binding === 1)).toBeUndefined();
    expect(storageBindings.find((entry) => entry.binding === 2)).toBeUndefined();
    expect(uniformBindings.find((entry) => entry.binding === 1)).toBeUndefined();
    expect(uniformBindings.find((entry) => entry.binding === 2)).toBeUndefined();
  });

  it('keeps Point/Spot pcfKernelSize validation independent of Directional quality', () => {
    expect(
      validatePointLightShadowData({ mapSize: 512, nearPlane: 0.1, farPlane: 20, pcfKernelSize: 5 })
        .ok,
    ).toBe(true);
    expect(
      validateSpotLightData({ castShadow: true, direction: [0, -1, 0], pcfKernelSize: 3 }).ok,
    ).toBe(true);
    expect(validatePointLightShadowData({ pcfKernelSize: 2 }).ok).toBe(false);
    expect(
      validateSpotLightData({ castShadow: true, direction: [0, -1, 0], pcfKernelSize: 2 }).ok,
    ).toBe(false);
  });
});
