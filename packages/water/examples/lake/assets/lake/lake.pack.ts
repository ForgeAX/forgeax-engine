import { EngineContent } from '@forgeax/engine/content';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { quat } from '@forgeax/engine/math';
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine/pack/source';
import type { Plugin } from '@forgeax/engine/plugin';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  Skylight,
} from '@forgeax/engine/render';
import {
  Transform,
  WaterBodyInstance,
  WaterZoneInstance,
  worldDespawnScene,
} from '@forgeax/engine/scene';
import {
  ok,
  type SceneAsset,
  type WaterBodySource,
  type WaterWaveSetSource,
  type WaterZoneAsset,
} from '@forgeax/engine/types';
import { buildWaterPackOutputs, waterMaterialFamilySlots } from '@forgeax/engine/water';

const packageId = definePackageId('019bd2b6-9d9a-74ec-9432-f7c554beff1d');
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
const corners = [
  [-6, -6],
  [6, -6],
  [6, 6],
  [-6, 6],
] as const;
const cameraPosition = [5, 11, 10] as const;
const lakeSceneGuid = guid('scene/lake');

export const lake: Plugin.Object<{ readonly scene: string }> = {
  name: 'lake-starter',
  inject: ['assets', 'world'],
  async apply(ctx, { scene }) {
    const { assets, world } = ctx;
    if (assets === undefined) throw new Error('Lake starter requires the project asset registry');
    await ctx.effect(async function* () {
      const handle = (await assets.load(assets.parseGuid(scene), 'scene')).unwrap();
      yield () => assets.release(handle).unwrap();
      const root = assets.instantiate(handle, world).unwrap();
      yield () => worldDespawnScene(world, root).unwrap();
    });
  },
};

const scene: SceneAsset = {
  kind: 'scene',
  entities: {
    zone: { components: { Transform: {}, WaterZoneInstance: { zone: guid('zone/lake') } } },
    lake: { components: { Transform: {}, WaterBodyInstance: { body: guid('body/lake') } } },
    bed: {
      components: {
        Transform: { pos: [0, -1.6, 0] },
        MeshFilter: { assetHandle: guid('mesh/bed') },
        MeshRenderer: { materials: [guid('material/bed')] },
      },
    },
    camera: {
      components: {
        Transform: {
          pos: cameraPosition,
          quat: Array.from(quat.fromLookAt(quat.create(), cameraPosition, [0, 0, 0], [0, 1, 0])),
        },
        Camera: {
          fov: Math.PI / 3,
          near: 0.1,
          far: 40,
          antialias: 0,
          clearColor: [0.18, 0.34, 0.55, 1],
        },
      },
    },
    sun: { components: { DirectionalLight: { direction: [0, -1, -1], intensity: 3 } } },
    sky: { components: { Skylight: { intensity: 0.5, color: [1, 1, 1] } } },
  },
};

export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  name: 'Lake starter',
  plugins: true,
  sceneComponents: [
    Transform,
    WaterBodyInstance,
    WaterZoneInstance,
    MeshFilter,
    MeshRenderer,
    Camera,
    DirectionalLight,
    Skylight,
  ],
  async build() {
    const waves: WaterWaveSetSource = {
      kind: 'water-wave-set',
      waveSource: {
        kind: 'predefined',
        waves: [
          { directionXZ: [1, 0], wavelengthM: 4, amplitudeM: 0.13, steepness: 0.1 },
          { directionXZ: [0, 1], wavelengthM: 3, amplitudeM: 0.05, steepness: 0.04 },
        ],
      },
      maxWaveHeightM: 0.2,
      depthMaskM: 1.5,
      timeSource: 'scene-clock',
    };
    const zone: WaterZoneAsset = {
      kind: 'water-zone',
      extentM: { spanXM: 16, spanZM: 16 },
      tileSizeM: 2,
      tessellationFactor: 4,
      lodScale: 1,
      waterInfo: {
        resolution: { widthPx: 64, heightPx: 64 },
        format: 'rgba16f',
        blurRadius: 0,
        localTessellation: false,
      },
    };
    const body: WaterBodySource = {
      kind: 'water-body',
      type: 'lake',
      ...waterMaterialFamilySlots({ guids: EngineContent.water.materials }, 'lake'),
      zoneGuid: guid('zone/lake'),
      waveSetGuid: guid('waves/lake'),
      baseHeightM: 0,
      maxWaveHeightM: 0.2,
      overlapPriority: 0,
      flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
      collision: { type: 'none', enabled: false },
      queryFootprint: corners,
      spline: {
        closed: true,
        interpolationVersion: 'water-spline/2',
        points: corners.map(([x, z], inputKey) => ({
          inputKey,
          interpolationMode: 'linear',
          positionM: [x, 0, z],
          arriveTangentM: [0, 0, 0],
          leaveTangentM: [0, 0, 0],
          rotationQuat: [0, 0, 0, 1],
          up: [0, 1, 0],
          rollAngle: 0,
          angleUnit: 'degrees',
          widthM: 1,
          depthM: 1.5,
          velocityMPerSec: 0,
          audioIntensity: 0,
        })),
      },
    };
    const cooked = await buildWaterPackOutputs(
      { 'zone/lake': zone, 'body/lake': body, 'waves/lake': waves },
      { packageId },
    );
    if (!cooked.ok) return cooked;
    return ok({
      ...cooked.value,
      'mesh/bed': createBoxGeometry(16, 0.5, 16).unwrap(),
      'material/bed': Materials.standard({ baseColor: [0.34, 0.27, 0.16, 1], roughness: 1 }),
      'scene/lake': scene,
      'plugin/engine': {
        kind: 'plugin',
        module: { specifier: './lake.pack.ts', export: 'lake' },
        config: { scene: { $asset: lakeSceneGuid } },
      },
    });
  },
});
