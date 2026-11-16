import type { App } from '@forgeax/engine/app';
import type { EntityHandle } from '@forgeax/engine/ecs';
import { createMeshBuilder } from '@forgeax/engine/geometry';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { waterSceneZoneGround } from '@forgeax/engine/runtime';
import {
  Transform,
  WaterBodyInstance,
  WaterTerrainProvider,
  WaterZoneInstance,
} from '@forgeax/engine/scene';
import { Terrain } from '@forgeax/engine/terrain';
import { waterBodyGeometryGuid } from './body-geometry/src/identity';
import { waterTerrainProviderGuid } from './terrain-provider/src/identity';
import { presentationGuid } from './presentation-identity';

/** R1's geometry and TerrainProvider share this one Scene/World and panel. */
export async function mountR1Terrain(app: App, parent: HTMLElement) {
  const assets = app.assets;
  if (!assets) throw new Error('R1 requires the App asset registry');
  const { world } = app;
  const terrains = await Promise.all(
    ['a', 'b'].map(async (revision) =>
      (
        await assets.load(
          waterTerrainProviderGuid(`terrain/planned-${revision}/terrain`),
          'terrain',
        )
      ).unwrap(),
    ),
  );
  const firstTerrain = terrains[0];
  if (firstTerrain === undefined) throw new Error('Missing authored Terrain');
  const zoneGuid = waterTerrainProviderGuid('zone/main');
  const zone = (await assets.load(zoneGuid, 'water-zone')).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, -1.1, -68] } },
      { component: WaterZoneInstance, data: { zone } },
    )
    .unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: { pos: [-32, -1.1, -100] } },
      { component: Terrain, data: { asset: firstTerrain, lod0Diameter: 0.4 } },
      { component: WaterTerrainProvider, data: { terrain: firstTerrain } },
    )
    .unwrap();
  const skirtMaterial = (await assets.load(presentationGuid('material/limestone'), 'material')).unwrap();
  const presentationEntities: EntityHandle[] = [];
  const mountSkirt = () => {
    for (const entity of presentationEntities) world.despawn(entity).unwrap();
    presentationEntities.length = 0;
    const terrain = assets.read(world.get(entity, Terrain).unwrap().asset).unwrap();
    const positions: number[] = [], uv: number[] = [], indices: number[] = [];
    const perimeter: [number, number][] = [];
    for (let x = 0; x < terrain.columns; x++) perimeter.push([x, 0]);
    for (let z = 1; z < terrain.rows; z++) perimeter.push([terrain.columns - 1, z]);
    for (let x = terrain.columns - 2; x >= 0; x--) perimeter.push([x, terrain.rows - 1]);
    for (let z = terrain.rows - 2; z > 0; z--) perimeter.push([0, z]);
    for (let i = 0; i < perimeter.length; i++) {
      const a = perimeter[i], b = perimeter[(i + 1) % perimeter.length];
      if (!a || !b) continue;
      const ax = a[0] * terrain.spacing, az = a[1] * terrain.spacing;
      const bx = b[0] * terrain.spacing, bz = b[1] * terrain.spacing;
      const ah = terrain.heights[a[1] * terrain.columns + a[0]] ?? 0;
      const bh = terrain.heights[b[1] * terrain.columns + b[0]] ?? 0;
      const first = positions.length / 3, length = Math.hypot(bx - ax, bz - az);
      // A thin overlapping edge prevents a crack without altering the Terrain.
      positions.push(ax, -1.2, az, bx, -1.2, bz, bx, bh - 0.015, bz, ax, ah - 0.015, az);
      uv.push(0, 0, length / 3, 0, length / 3, (bh + 1.2) / 3, 0, (ah + 1.2) / 3);
      indices.push(first, first + 2, first + 1, first, first + 3, first + 2);
    }
    const mesh = assets.create(createMeshBuilder({
      attributes: { position: new Float32Array(positions), uv: new Float32Array(uv) },
      indices,
    }).build().unwrap()).unwrap();
    presentationEntities.push(world.spawn(
      { component: Transform, data: { pos: [-32, -1.1, -100] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [skirtMaterial] } },
    ).unwrap());
    assets.release(mesh).unwrap();
  };
  mountSkirt();
  const river = (await assets.load(waterTerrainProviderGuid('body/river'), 'water-body')).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, -1.1, -68] } },
      { component: WaterBodyInstance, data: { body: river } },
    )
    .unwrap();
  // The mounted Body/Zone owns Water raster and its per-draw frame resources.
  // Raw MeshRenderer copies cannot satisfy that material's Water binding ABI.
  // The R1 geometry exhibit instead shades the identical cooked shape with its
  // Standard surface material, independently of the Zone's live products.
  const geometryMaterial = (
    await assets.load(waterBodyGeometryGuid('material/river'), 'material')
  ).unwrap();
  const cookedBody = assets.read(river).unwrap();
  const surfaceEntities = [];
  for (const meshGuid of cookedBody.riverSegmentMeshGuids ?? []) {
    const mesh = (await assets.load(meshGuid, 'mesh')).unwrap();
    surfaceEntities.push(
      world
        .spawn(
          { component: Transform, data: { pos: [0, -1.1, -68] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [geometryMaterial] } },
        )
        .unwrap(),
    );
  }
  const section = document.createElement('section'),
    title = document.createElement('h2');
  title.textContent = 'R1 · 地形供给器';
  section.append(title);
  const select = document.createElement('select');
  select.id = 'r1-terrain-revision';
  for (const [value, label] of [
    ['0', '地形 A · 浅河床'],
    ['1', '地形 B · 深河床'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  const label = document.createElement('label'),
    enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.id = 'r1-terrain-provider-enabled';
  enabled.checked = true;
  label.append(enabled, '将可见地形绑定到 WaterZone');
  const pre = document.createElement('pre');
  const update = () => {
    const terrain = terrains[Number(select.value)];
    if (terrain === undefined) throw new Error('Unknown authored Terrain revision');
    world.set(entity, Terrain, { asset: terrain }).unwrap();
    mountSkirt();
    if (enabled.checked) {
      if (world.hasComponent(entity, WaterTerrainProvider))
        world.set(entity, WaterTerrainProvider, { terrain }).unwrap();
      else
        world.addComponent(entity, { component: WaterTerrainProvider, data: { terrain } }).unwrap();
    } else if (world.hasComponent(entity, WaterTerrainProvider))
      world.removeComponent(entity, WaterTerrainProvider).unwrap();
  };
  select.addEventListener('change', update);
  enabled.addEventListener('change', update);
  const facts = document.createElement('details'),
    summary = document.createElement('summary');
  summary.textContent = '供给器准入与版本';
  facts.append(summary, pre);
  section.append(select, label, facts);
  parent.append(section);
  let frames = 0;
  const unsubscribe = app.renderer.subscribe((event) => {
    if (event.kind === 'frame-submitted')
      void event.receipt.completed.then((result) => {
        if (
          result.ok &&
          event.receipt.presentation === 'ready' &&
          ++frames % 15 === 0 &&
          facts.open
        ) {
          const snapshot = waterSceneZoneGround(world, zoneGuid).unwrap();
          pre.textContent = JSON.stringify(
            snapshot && {
              generation: snapshot.generation,
              dirty: snapshot.dirty,
              providers: snapshot.providers.map(
                ({ entity, terrainGuid, terrainVersion, boundsXZ }) => ({
                  entity,
                  terrainGuid,
                  terrainVersion,
                  boundsXZ,
                }),
              ),
            },
            null,
            2,
          );
        }
      });
  });
  app.pluginContext.effect(() => unsubscribe);
  return { entity, terrains, zoneGuid, surfaceEntities, presentationEntities };
}
