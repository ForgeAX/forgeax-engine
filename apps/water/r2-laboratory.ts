import type { App } from '@forgeax/engine/app';
import type { EntityHandle } from '@forgeax/engine/ecs';
import { Time } from '@forgeax/engine/ecs';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { WATER_SYSTEM_RESOURCE } from '@forgeax/engine/runtime';
import {
  Transform,
  WaterBodyInstance,
  WaterExclusionMode,
  WaterExclusionVolume,
  WaterTerrainProvider,
  WaterZoneInstance,
} from '@forgeax/engine/scene';
import { Terrain } from '@forgeax/engine/terrain';
import type { WaterZoneAsset } from '@forgeax/engine/types';
import {
  cookWaterAsset,
  WaterQueryFlags,
  type WaterSystem,
  waterInfoWorldToUv,
} from '@forgeax/engine/water';
import { BODY_QUERY_PACKAGE_NAMESPACE } from './body-query/src/identity';
import { demoWaveSetSource } from './demo-wave-set';
import { presentationGuid } from './presentation-identity';
import { runtimeForm, runtimeObjectFields } from './runtime-form';
import { WATER_INFO_DEMO_PACKAGE } from './water-info/src/identity';
import { WAVES_PACKAGE_NAMESPACE } from './waves/src/identity';

export type R2LaboratoryMode = 'query' | 'info' | 'waves';
/** One World owns all R2 experiments; only the selected scene mounts Water inputs. */
export async function mountR2Laboratory(app: App, parent: HTMLElement) {
  const { world, assets } = app;
  if (!assets) throw new Error('R2 requires the asset owner');
  const g = (namespace: Parameters<typeof AssetGuid.derive>[0], key: string) =>
    AssetGuid.format(AssetGuid.derive(namespace, key));
  const q = (key: string) => g(BODY_QUERY_PACKAGE_NAMESPACE, key),
    i = (key: string) => g(WATER_INFO_DEMO_PACKAGE, key),
    w = (key: string) => g(WAVES_PACKAGE_NAMESPACE, key);
  const water = () => world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
  const plank = (await assets.load(presentationGuid('mesh/plank'), 'mesh')).unwrap(),
    brass = (await assets.load(presentationGuid('material/brass'), 'material')).unwrap();
  const marker = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: plank } },
    )
    .unwrap();
  const panels = new Map<R2LaboratoryMode, HTMLElement>();
  const panel = (mode: R2LaboratoryMode, title: string) => {
    const element = document.createElement('section');
    element.hidden = true;
    element.className = 'water-runtime-panel';
    const heading = document.createElement('h2');
    heading.textContent = title;
    element.append(heading);
    parent.append(element);
    panels.set(mode, element);
    return element;
  };
  const queryPanel = panel('query', '分层水体 · 查询 / Terrain / 排除 / 作者查询网格夹具');
  const fixtureNote = document.createElement('p');
  fixtureNote.textContent =
    '查询网格使用显式作者夹具，验证查询源选择；真实 GPU Bake 与冷启动恢复请查看 R7。';
  queryPanel.append(fixtureNote);
  const querySettings = {
    x: 0,
    y: -1,
    z: 0,
    upper: false,
    terrain: true,
    exclusion: false,
    baked: false,
    location: true,
    normal: true,
    depth: true,
    immersion: true,
    velocity: true,
    waves: true,
    simple: false,
    ignoreExclusion: false,
  };
  runtimeForm(
    queryPanel,
    '查询输入与来源',
    runtimeObjectFields(
      () => ({ ...querySettings }),
      (value) => {
        Object.assign(querySettings, value);
      },
    ),
  );
  const queryEntries = await Promise.all(
    (['lower', 'upper'] as const).map(async (key) => {
      const handle = (
        await assets.load(q(key === 'lower' ? 'body/lower-lake' : 'body/upper-ocean'), 'water-body')
      ).unwrap();
      const zone = (await assets.load(q(`zone/${key}`), 'water-zone')).unwrap();
      const position: [number, number, number] = [
        key === 'lower' ? 0 : 40,
        key === 'lower' ? 0 : 4,
        0,
      ];
      const entity = world.spawn({ component: Transform, data: { pos: position } }).unwrap();
      const zoneEntity = world.spawn({ component: Transform, data: { pos: position } }).unwrap();
      return { key, handle, zone, entity, zoneEntity, position };
    }),
  );
  const queryTerrain = (await assets.load(q('terrain/terrain'), 'terrain')).unwrap();
  const queryGround = world.spawn({ component: Transform, data: { pos: [-24, 0, -24] } }).unwrap();
  const exclusion = world.spawn({ component: Transform, data: {} }).unwrap();
  const infoPanel = panel('info', 'WaterInfo · 地形采集与世界投影');
  const infoZone = (await assets.load(i('zone/main'), 'water-zone')).unwrap(),
    infoBody = (await assets.load(i('body/river'), 'water-body')).unwrap();
  const infoZoneEntity = world.spawn({ component: Transform, data: { pos: [32, 0, 32] } }).unwrap(),
    infoBodyEntity = world.spawn({ component: Transform, data: { pos: [32, 0, 32] } }).unwrap();
  const infoTerrains = await Promise.all(
    ['a', 'b'].map(async (variant) =>
      (await assets.load(i(`terrain/planned-${variant}/terrain`), 'terrain')).unwrap(),
    ),
  );
  const infoGround = world.spawn({ component: Transform, data: {} }).unwrap();
  const infoSettings = { terrainVariant: 'a', terrain: true, probeXM: 32, probeZM: 32 };
  runtimeForm(
    infoPanel,
    '采集地形与探针（m）',
    runtimeObjectFields(
      () => ({ ...infoSettings }),
      (value) => {
        Object.assign(infoSettings, value);
      },
      { terrainVariant: ['a', 'b'] },
    ),
  );
  runtimeForm(
    infoPanel,
    '区域参数 / 分辨率 / 格式 / 模糊 / 局部细分',
    runtimeObjectFields(
      () => ({ ...assets.read(infoZone).unwrap() }),
      (value) => {
        assets.replace(infoZone, value as unknown as WaterZoneAsset).unwrap();
      },
      { 'waterInfo.format': ['rgba16f', 'rgba32f'] },
    ),
  );
  const wavePanel = panel('waves', 'Gerstner · 全波 / 简波 / 深度衰减 / LWC');
  const waveZone = (await assets.load(w('zone/ocean'), 'water-zone')).unwrap(),
    waveBody = (await assets.load(w('body/ocean'), 'water-body')).unwrap(),
    waves = (await assets.load(w('waves/seed-731-v1'), 'water-wave-set')).unwrap();
  const origin: [number, number, number] = [31453.28, 0, 10484.76];
  const waveEntity = world.spawn({ component: Transform, data: { pos: origin } }).unwrap(),
    waveZoneEntity = world.spawn({ component: Transform, data: { pos: origin } }).unwrap();
  const waveSettings = { depthM: 1, xM: 0, zM: 0, simple: false };
  runtimeForm(
    wavePanel,
    '固定查询点与全波 / 简波',
    runtimeObjectFields(
      () => ({ ...waveSettings }),
      (value) => {
        Object.assign(waveSettings, value);
      },
    ),
  );
  const waveSource = demoWaveSetSource();
  if (waveSource.waveSource.kind !== 'generated') throw new Error('Expected generated source');
  const generated = waveSource.waveSource;
  let generator: Record<string, unknown> = { ...generated.generatorConfig };
  runtimeForm(
    wavePanel,
    '波谱生成器 · seed 731',
    runtimeObjectFields(
      () => ({ ...generator }),
      (value) => {
        const cooked = cookWaterAsset({
          ...waveSource,
          waveSource: { ...generated, generatorConfig: value },
        }).unwrap();
        if (cooked.kind !== 'water-wave-set') throw new Error('Expected WaveSet');
        assets.replace(waves, cooked).unwrap();
        generator = { ...value };
      },
    ),
  );
  const facts = document.createElement('pre');
  parent.append(facts);
  const remove = (
    entity: EntityHandle,
    component:
      | typeof WaterBodyInstance
      | typeof WaterZoneInstance
      | typeof WaterTerrainProvider
      | typeof Terrain
      | typeof WaterExclusionVolume
      | typeof MeshRenderer,
  ) => {
    if (world.hasComponent(entity, component)) world.removeComponent(entity, component).unwrap();
  };
  let active: R2LaboratoryMode | undefined;
  const clear = () => {
    for (const entry of queryEntries) {
      remove(entry.entity, WaterBodyInstance);
      remove(entry.zoneEntity, WaterZoneInstance);
    }
    remove(queryGround, Terrain);
    remove(queryGround, WaterTerrainProvider);
    remove(exclusion, WaterExclusionVolume);
    remove(infoBodyEntity, WaterBodyInstance);
    remove(infoZoneEntity, WaterZoneInstance);
    remove(infoGround, Terrain);
    remove(infoGround, WaterTerrainProvider);
    remove(waveEntity, WaterBodyInstance);
    remove(waveZoneEntity, WaterZoneInstance);
    remove(marker, MeshRenderer);
  };
  const setMode = (mode: R2LaboratoryMode | undefined) => {
    clear();
    active = mode;
    for (const [key, element] of panels) element.hidden = key !== mode;
    facts.hidden = mode === undefined;
    if (mode === 'query')
      for (const entry of queryEntries) {
        world
          .addComponent(entry.entity, {
            component: WaterBodyInstance,
            data: { body: entry.handle },
          })
          .unwrap();
        world
          .addComponent(entry.zoneEntity, {
            component: WaterZoneInstance,
            data: { zone: entry.zone },
          })
          .unwrap();
      }
    else if (mode === 'info') {
      world
        .addComponent(infoBodyEntity, { component: WaterBodyInstance, data: { body: infoBody } })
        .unwrap();
      world
        .addComponent(infoZoneEntity, { component: WaterZoneInstance, data: { zone: infoZone } })
        .unwrap();
    } else if (mode === 'waves') {
      world
        .addComponent(waveEntity, { component: WaterBodyInstance, data: { body: waveBody } })
        .unwrap();
      world
        .addComponent(waveZoneEntity, { component: WaterZoneInstance, data: { zone: waveZone } })
        .unwrap();
    }
    if (mode)
      world
        .addComponent(marker, { component: MeshRenderer, data: { materials: [brass] } })
        .unwrap();
  };
  let last = 0;
  const unsubscribe = app.renderer.subscribe((event) => {
    if (event.kind !== 'frame-submitted') return;
    void event.receipt.completed.then((result) => {
      if (!result.ok || active === undefined || performance.now() - last < 200) return;
      last = performance.now();
      let entity: EntityHandle,
        position: [number, number, number],
        flags =
          WaterQueryFlags.ComputeLocation |
          WaterQueryFlags.ComputeNormal |
          WaterQueryFlags.ComputeDepth |
          WaterQueryFlags.IncludeWaves;
      let extra: unknown;
      if (active === 'query') {
        const entry = queryEntries[querySettings.upper ? 1 : 0];
        if (!entry) return;
        entity = entry.entity;
        position = [
          entry.position[0] + querySettings.x,
          entry.position[1] + querySettings.y,
          querySettings.z,
        ];
        const fields = {
          location: WaterQueryFlags.ComputeLocation,
          normal: WaterQueryFlags.ComputeNormal,
          depth: WaterQueryFlags.ComputeDepth,
          immersion: WaterQueryFlags.ComputeImmersionDepth,
          velocity: WaterQueryFlags.ComputeVelocity,
          waves: WaterQueryFlags.IncludeWaves,
          simple: WaterQueryFlags.SimpleWaves,
          ignoreExclusion: WaterQueryFlags.IgnoreExclusionVolumes,
        };
        flags = Object.entries(fields).reduce(
          (value, [key, bit]) => (querySettings[key as keyof typeof fields] ? value | bit : value),
          0,
        );
        const reconcileQuerySources = () => {
          if (querySettings.terrain) {
            if (!world.hasComponent(queryGround, Terrain))
              world
                .addComponent(queryGround, { component: Terrain, data: { asset: queryTerrain } })
                .unwrap();
            if (!world.hasComponent(queryGround, WaterTerrainProvider))
              world
                .addComponent(queryGround, {
                  component: WaterTerrainProvider,
                  data: { terrain: queryTerrain },
                })
                .unwrap();
          } else remove(queryGround, WaterTerrainProvider);
          if (querySettings.exclusion && !world.hasComponent(exclusion, WaterExclusionVolume))
            world
              .addComponent(exclusion, {
                component: WaterExclusionVolume,
                data: {
                  mode: WaterExclusionMode.addListedBodiesToExclusion,
                  waterBodies: queryEntries.slice(0, 1).map((body) => body.entity),
                  centerM: [0, 0, 0],
                  halfExtentsM: [2, 2, 2],
                },
              })
              .unwrap();
          else if (!querySettings.exclusion) remove(exclusion, WaterExclusionVolume);
          for (const body of queryEntries) {
            const snapshot = water().snapshot(`scene-entity:${body.entity}`);
            if (!snapshot) continue;
            if (
              querySettings.baked &&
              !water().bakedQueryGrid(snapshot.guid, snapshot.sceneGeneration)
            ) {
              const samples = new Float32Array(5 * 5 * 4);
              for (let index = 0; index < 25; index++)
                samples.set([0.35, 3.4, 0.6, -0.2], index * 4);
              water()
                .publishBakedQueryGrid(snapshot.guid, snapshot.sceneGeneration, {
                  kind: 'live-capture',
                  enabled: true,
                  componentValid: true,
                  dataValid: true,
                  grid: {
                    originXZ: [body.position[0] - 2, -2],
                    originY: body.position[1],
                    spacingXZ: [1, 1],
                    width: 5,
                    height: 5,
                    samples,
                  },
                })
                .unwrap();
            } else if (
              !querySettings.baked &&
              water().bakedQueryGrid(snapshot.guid, snapshot.sceneGeneration)
            )
              water().clearBakedQueryGrid(snapshot.guid, snapshot.sceneGeneration).unwrap();
          }
        };
        reconcileQuerySources();
      } else if (active === 'info') {
        entity = infoBodyEntity;
        position = [infoSettings.probeXM, -1, infoSettings.probeZM];
        const terrain = infoTerrains[infoSettings.terrainVariant === 'b' ? 1 : 0];
        if (terrain === undefined) return;
        const reconcileInfoTerrain = () => {
          if (infoSettings.terrain) {
            if (!world.hasComponent(infoGround, Terrain))
              world
                .addComponent(infoGround, { component: Terrain, data: { asset: terrain } })
                .unwrap();
            else world.set(infoGround, Terrain, { asset: terrain }).unwrap();
            if (!world.hasComponent(infoGround, WaterTerrainProvider))
              world
                .addComponent(infoGround, { component: WaterTerrainProvider, data: { terrain } })
                .unwrap();
            else world.set(infoGround, WaterTerrainProvider, { terrain }).unwrap();
          } else remove(infoGround, WaterTerrainProvider);
        };
        reconcileInfoTerrain();
        const zone = assets.read(infoZone).unwrap(),
          zoneTransform = world.get(infoZoneEntity, Transform).unwrap(),
          uv = waterInfoWorldToUv(
            {
              centerXZ: [zoneTransform.pos[0] ?? 0, zoneTransform.pos[2] ?? 0],
              extentXZ: [
                zone.extentM.spanXM * (zoneTransform.scale[0] ?? 1),
                zone.extentM.spanZM * (zoneTransform.scale[2] ?? 1),
              ],
            },
            [position[0], position[2]],
          );
        extra = {
          uv,
          texel: [
            Math.floor(uv[0] * zone.waterInfo.resolution.widthPx),
            Math.floor(uv[1] * zone.waterInfo.resolution.heightPx),
          ],
          ground: water().zoneGroundSnapshot(i('zone/main')),
        };
      } else {
        entity = waveEntity;
        position = [origin[0] + waveSettings.xM, -waveSettings.depthM, origin[2] + waveSettings.zM];
        if (waveSettings.simple) flags |= WaterQueryFlags.SimpleWaves;
        extra = { lwcOriginM: origin, spectrum: assets.read(waves).unwrap() };
      }
      const snapshot = water().snapshot(`scene-entity:${entity}`);
      if (!snapshot) return;
      const query = water().queryBody(snapshot.guid, {
        positionM: position,
        timeSeconds: world.getResource(Time).elapsed,
        expectedBodyGeneration: snapshot.sceneGeneration,
        flags,
      });
      if (query.ok)
        world
          .set(marker, Transform, { pos: query.value.surfaceM ?? position, scale: [0.5, 0.5, 0.5] })
          .unwrap();
      facts.textContent = JSON.stringify(
        { mode: active, query, extra, body: snapshot, renderer: app.renderer.inspect().waterGraph },
        (_key, value) => (value instanceof Set ? [...value] : value),
        2,
      );
    });
  });
  app.pluginContext.effect(() => unsubscribe);
  return { setMode, panels, querySettings, infoSettings, waveSettings, origin };
}
