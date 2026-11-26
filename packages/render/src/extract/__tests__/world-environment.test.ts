import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Disabled, Time, World } from '@forgeax/engine-ecs';
import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  cloudMaterialDecoder,
  cloudMaterialKind,
  createCloudCookers,
} from '../../cloud/authoring/assets';
import type { CloudMaterialAsset } from '../../cloud/contracts';
import type { ExtractedCloudLayer } from '../../cloud/extract';
import { DirectionalLight } from '../../components/directional-light';
import { Fog } from '../../components/fog';
import { PointLight } from '../../components/point-light';
import { VolumetricCloudLayer } from '../../components/volumetric-cloud-layer';
import {
  createWorldInternalView,
  prepareExtractContext,
  selectFogFrame,
} from '../../render-system-extract';
import { EnvironmentFrameGate } from '../environment-frame-gate';
import { extractWorldEnvironment } from '../world-environment';

function extractor(world: World) {
  const context = { ...prepareExtractContext(world), environmentGate: new EnvironmentFrameGate() };
  const internal = createWorldInternalView(world);
  return {
    internal,
    extract: () => extractWorldEnvironment(world, context, internal, undefined),
  };
}

function cookedCloud(layer: ExtractedCloudLayer | undefined) {
  if (layer?.status !== 'analytic') throw new Error('Expected the cooked uniform cloud fixture');
  return layer;
}

async function cloudWorld() {
  const registry = new NativeCookerRegistry();
  const unexpectedCompile = async (): Promise<never> => {
    throw new Error('The uniform extraction fixture needs no renderer compilation');
  };
  for (const cooker of createCloudCookers({
    loadSource: unexpectedCompile,
    compilerIdentity: unexpectedCompile,
    compile: unexpectedCompile,
  }))
    registry.register(cooker);
  const draft = (
    await registry.runDraft<CloudMaterialAsset>('cloud-material', {
      guid: '019a50a5-0000-7000-8000-000000000004',
      sourcePath: 'environment-cloud.pack.ts',
      source: {
        version: 1,
        model: {
          kind: 'uniform',
          sample: {
            extinctionPerMeter: 0.002,
            albedo: [1, 1, 1],
            emissivePerMeter: [0, 0, 0],
            materialAO: 1,
          },
        },
        parameters: {},
      },
    })
  ).unwrap();
  const decoded = (
    await cloudMaterialDecoder.decoder.decode({
      envelope: { guid: draft.guid, payload: draft.payload, refs: draft.refs, artifacts: {} },
      artifacts: { read: async () => ok(new Uint8Array()) },
      signal: new AbortController().signal,
    } as never)
  ).unwrap();
  const assets = new AssetRegistry();
  assets.installDecoder(cloudMaterialKind, cloudMaterialDecoder.decoder);
  const material = assets.create(cloudMaterialKind, decoded).unwrap();
  return { world: new World({ assets }), material };
}

describe('World environment storage matching', () => {
  it('reuses an unchanged point light snapshot and rebuilds it after a write', () => {
    const world = new World();
    const { extract } = extractor(world);
    const lamp = world
      .spawn({ component: PointLight, data: { intensity: 2 } }, { component: Transform, data: {} })
      .unwrap();
    world
      .set(lamp, GlobalTransform, { world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1] })
      .unwrap();
    const first = extract().lights.point[0];
    expect(extract().lights.point[0]).toBe(first);
    world.set(lamp, PointLight, { intensity: 7 }).unwrap();
    const changed = extract().lights.point[0];
    expect(changed).not.toBe(first);
    expect(changed?.intensity).toBe(7);
    expect(changed?.position).toBe(first?.position);
    world
      .set(lamp, GlobalTransform, { world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1] })
      .unwrap();
    const moved = extract().lights.point[0];
    expect(moved).not.toBe(changed);
    expect(moved?.position[0]).toBe(4);
    expect(moved?.color).toBe(changed?.color);
  });

  it('publishes current point columns when another light triggers extraction', () => {
    const world = new World();
    const a = world.spawn({ component: PointLight, data: { intensity: 2 } }).unwrap();
    const b = world.spawn({ component: PointLight, data: {} }).unwrap();
    const { extract } = extractor(world);
    const before = extract().lights.point;
    world.set(a, PointLight, { color: [0.5, 1, 0], intensity: 8 }, false).unwrap();
    world.set(b, PointLight, { intensity: 3 }).unwrap();
    const after = extract().lights.point;
    expect(Array.from(after[0]?.color ?? [])).toEqual([4, 8, 0]);
    expect(Array.from(before[0]?.color ?? [])).toEqual([2, 2, 2]);
    expect(after[1]?.intensity).toBe(3);
  });

  it('preserves surviving light rows after swap removal and retains older publications', () => {
    const world = new World();
    const ids = Array.from({ length: 4 }, (_, i) =>
      world.spawn({ component: PointLight, data: { intensity: i + 1 } }).unwrap(),
    );
    const { extract } = extractor(world);
    const before = extract().lights.point;
    world.despawn(ids[0] as (typeof ids)[number]).unwrap();
    const after = extract().lights.point;
    expect(after).toHaveLength(3);
    for (const light of after)
      expect(light).toBe(before.find((row) => row.entity === light.entity));
    expect(before.map((light) => light.intensity)).toEqual([1, 2, 3, 4]);
  });

  it('keeps retained light projections private to independent source readers', () => {
    const world = new World();
    world.spawn({ component: PointLight, data: { intensity: 2 } }).unwrap();
    const a = extractor(world).extract;
    const b = extractor(world).extract;
    const first = a().lights.point[0];
    const second = b().lights.point[0];
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(a().lights.point[0]).toBe(first);
    expect(b().lights.point[0]).toBe(second);
  });

  it('keeps live Fog, cooked cloud edits and moving poses independent of older produced frames', async () => {
    const { world, material } = await cloudWorld();
    const fog = world.spawn({ component: Fog, data: { density: 0.03 } }).unwrap();
    const cloud = world.spawn({ component: VolumetricCloudLayer, data: { material } }).unwrap();
    world.spawn({ component: DirectionalLight, data: { direction: [0, -1, 0] } }).unwrap();
    const lamp = world
      .spawn({ component: PointLight, data: {} }, { component: Transform, data: {} })
      .unwrap();
    const context = {
      ...prepareExtractContext(world),
      environmentGate: new EnvironmentFrameGate(),
    };
    const internal = createWorldInternalView(world);
    const extract = () => extractWorldEnvironment(world, context, internal, selectFogFrame(world));
    world.update(1 / 60).unwrap();
    const first = extract();
    const firstTime = world.getResource(Time).elapsed;
    expect(cookedCloud(first.cloudLayer).sample.extinctionPerMeter).toBe(0.002);
    world.set(fog, Fog, { density: 0.06 }).unwrap();
    world.set(cloud, VolumetricCloudLayer, { extinctionOverridePerMeter: 0.004 }).unwrap();
    world.update(1 / 60).unwrap();
    world
      .set(lamp, GlobalTransform, { world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1] })
      .unwrap();
    const second = extract();
    expect(world.getResource(Time).elapsed).toBeGreaterThan(firstTime);
    expect(cookedCloud(second.cloudLayer).sample.extinctionPerMeter).toBeCloseTo(0.004);
    expect(cookedCloud(first.cloudLayer).sample.extinctionPerMeter).toBe(0.002);
    expect(first.environment.fog?.density).toBeCloseTo(0.03);
    expect(second.environment.fog?.density).toBeCloseTo(0.06);
    expect(first.lights.point[0]?.position[0]).toBe(0);
    expect(second.lights.point[0]?.position[0]).toBe(3);
  });

  it('reads current values and membership after table and archetype growth', () => {
    const world = new World();
    const { extract } = extractor(world);
    expect(extract().lights.point).toHaveLength(0);

    const light = world.spawn({ component: PointLight, data: { intensity: 2 } }).unwrap();
    expect(extract().lights.point[0]?.color[0]).toBe(2);
    world.set(light, PointLight, { intensity: 5 }).unwrap();
    expect(extract().lights.point[0]?.color[0]).toBe(5);
    world.addComponent(light, { component: Disabled, data: {} }).unwrap();
    expect(extract().lights.point).toHaveLength(0);
    world.removeComponent(light, Disabled).unwrap();
    world.addComponent(light, { component: Transform, data: { pos: [3, 4, 5] } }).unwrap();
    world
      .set(light, GlobalTransform, {
        world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1],
      })
      .unwrap();
    expect(Array.from(extract().lights.point[0]?.position ?? [])).toEqual([3, 4, 5]);
    world.despawn(light).unwrap();
    expect(extract().lights.point).toHaveLength(0);
  });

  it('keeps World queries independent and discovers a cloud after an empty extraction', async () => {
    const { world: first, material } = await cloudWorld();
    const second = new World();
    const a = extractor(first).extract;
    const b = extractor(second).extract;
    expect(a().cloudLayer).toBeUndefined();
    expect(b().cloudLayer).toBeUndefined();
    const cloud = first
      .spawn({ component: VolumetricCloudLayer, data: { material, bottomMeters: 3000 } })
      .unwrap();
    const sun = first
      .spawn({
        component: DirectionalLight,
        data: { intensity: 2, direction: [0, -1, 0], castShadow: false },
      })
      .unwrap();
    const snapshot = a();
    expect(cookedCloud(snapshot.cloudLayer).bottomMeters).toBe(3000);
    expect(Array.from(snapshot.lights.directional?.color ?? [])).toEqual([2, 2, 2]);
    expect(b().cloudLayer).toBeUndefined();
    first.set(sun, DirectionalLight, { intensity: 4 }).unwrap();
    expect(Array.from(a().lights.directional?.color ?? [])).toEqual([4, 4, 4]);
    expect(Array.from(snapshot.lights.directional?.color ?? [])).toEqual([2, 2, 2]);
    first.despawn(cloud).unwrap();
    expect(a().cloudLayer).toBeUndefined();
  });

  it('gives the sun lane to the castShadow DirectionalLight whatever its entity order', () => {
    const world = new World();
    const fill = world
      .spawn({
        component: DirectionalLight,
        data: { intensity: 1.5, castShadow: false, direction: [0, -1, 0] },
      })
      .unwrap();
    const sun = world
      .spawn({
        component: DirectionalLight,
        data: { intensity: 2, castShadow: true, direction: [0, -1, 0] },
      })
      .unwrap();
    const lights = extractor(world).extract().lights;
    expect(lights.directionalCount).toBe(2);
    expect(lights.directional?.entity).toBe(sun);
    expect(lights.directional?.intensity).toBe(2);
    expect(lights.additionalDirectional?.map((light) => light.entity)).toEqual([fill]);
    expect(lights.directionalCsmConfig).toBeDefined();
    expect(lights.ignoredDirectionalShadowCasters).toEqual([]);
  });

  it('reports every castShadow DirectionalLight beyond the CSM owner as ignored', () => {
    const world = new World();
    const first = world
      .spawn({ component: DirectionalLight, data: { castShadow: true, direction: [0, -1, 0] } })
      .unwrap();
    const second = world
      .spawn({ component: DirectionalLight, data: { castShadow: true, direction: [0, -1, 0] } })
      .unwrap();
    const lights = extractor(world).extract().lights;
    expect(lights.directional?.entity).toBe(first);
    expect(lights.ignoredDirectionalShadowCasters).toEqual([second]);
    expect(lights.additionalDirectional?.map((light) => light.entity)).toEqual([second]);
  });

  it('keeps an authored shadow matrix with its selected sun across row edits and owner changes', () => {
    const world = new World();
    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 2, 0, 0, 1];
    const fill = world
      .spawn({ component: DirectionalLight, data: { direction: [0, -1, 0] } })
      .unwrap();
    const sun = world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [0, -1, 0],
          castShadow: true,
          shadowProjection: 1,
          shadowViewProjection: matrix,
        },
      })
      .unwrap();
    const { extract } = extractor(world);
    const first = extract().lights;
    expect(first.directional?.entity).toBe(sun);
    expect(Array.from(first.directionalCsmConfig?.shadowViewProjection ?? [])).toEqual(matrix);
    matrix[12] = 7;
    world.set(sun, DirectionalLight, { shadowViewProjection: matrix }).unwrap();
    const edited = extract().lights;
    expect(edited.directionalCsmConfig?.shadowViewProjection?.[12]).toBe(7);
    world.set(fill, DirectionalLight, { castShadow: true }).unwrap();
    const replaced = extract().lights;
    expect(replaced.directional?.entity).toBe(fill);
    expect(replaced.directionalCsmConfig?.shadowViewProjection).toBeUndefined();
    expect(replaced.ignoredDirectionalShadowCasters).toEqual([sun]);
    expect(first.directionalCsmConfig?.shadowViewProjection?.[12]).toBe(2);
    expect(edited.directionalCsmConfig?.shadowViewProjection?.[12]).toBe(7);
  });

  it('keeps the first light as the sun lane when no DirectionalLight casts a shadow', () => {
    const world = new World();
    const first = world
      .spawn({ component: DirectionalLight, data: { castShadow: false, direction: [0, -1, 0] } })
      .unwrap();
    world
      .spawn({ component: DirectionalLight, data: { castShadow: false, direction: [0, -1, 0] } })
      .unwrap();
    const lights = extractor(world).extract().lights;
    expect(lights.directional?.entity).toBe(first);
    expect(lights.directionalCsmConfig).toBeUndefined();
    expect(lights.ignoredDirectionalShadowCasters).toEqual([]);
  });

  it('allows nested extraction from an error callback and releases queries after a throw', () => {
    const world = new World();
    const light = world.spawn({ component: PointLight, data: { decay: -1 } }).unwrap();
    const { extract, internal } = extractor(world);
    let nested = false;
    internal._routeError = () => {
      if (nested) return;
      nested = true;
      expect(extract().lights.point).toHaveLength(0);
    };
    expect(extract().lights.point).toHaveLength(0);
    expect(nested).toBe(true);
    internal._routeError = () => {
      throw new Error('consumer-error');
    };
    expect(extract).toThrow('consumer-error');
    world.set(light, PointLight, { decay: 2 }).unwrap();
    expect(extract().lights.point).toHaveLength(1);
  });
});
