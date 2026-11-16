import type { App } from '@forgeax/engine/app';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { AssetGuid } from '@forgeax/engine/pack/source';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { presentationGuid } from '../../presentation-identity';
import { WATER_MESH_DEMO_PACKAGE } from './identity';
import { lakeShoreDistance, RIVER_PATH, watershedHeight } from './watershed';
/** Authored shore structures rest on the same Terrain height authority. */
export async function mountWatershedScenery(app: App) {
  const { world, assets } = app;
  if (!assets) throw new Error('Watershed assets unavailable');
  const box = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const localGuid = (key: string) =>
    AssetGuid.format(AssetGuid.derive(WATER_MESH_DEMO_PACKAGE, key));
  const rocks = await Promise.all(
    [0, 1, 2].map(async (variant) =>
      (await assets.load(localGuid(`mesh/scenery-rock-${variant}`), 'mesh')).unwrap(),
    ),
  );
  const frond = (await assets.load(presentationGuid('mesh/frond'), 'mesh')).unwrap();
  const post = (await assets.load(presentationGuid('mesh/post'), 'mesh')).unwrap();
  const materials = await Promise.all([
    assets.load(presentationGuid('material/wood'), 'material'),
    ...[0, 1].map((variant) =>
      assets.load(localGuid(`material/scenery-rock-${variant}`), 'material'),
    ),
    ...[0, 1, 2].map((variant) =>
      assets.load(localGuid(`material/scenery-leaf-${variant}`), 'material'),
    ),
  ]).then((results) => results.map((result) => result.unwrap()));
  const spawn = (mesh: typeof box, index: number, pos: number[], scale: number[], angle = 0) => {
    const material = materials[index];
    if (material === undefined) throw new Error('Missing scene material');
    return world
      .spawn(
        {
          component: Transform,
          data: { pos, scale, quat: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)] },
        },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  };
  let seed = 731;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };
  const riverClearance = (x: number, z: number) => {
    for (let index = 0; index < RIVER_PATH.length - 1; index++) {
      const a = RIVER_PATH[index],
        b = RIVER_PATH[index + 1];
      if (!a || !b) continue;
      const dx = b[0] - a[0],
        dz = b[2] - a[2];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / (dx * dx + dz * dz)));
      if (Math.hypot(x - a[0] - t * dx, z - a[2] - t * dz) < (a[3] + (b[3] - a[3]) * t) / 2 + 5)
        return false;
    }
    return true;
  };
  const scatter = (count: number, spacing: number, plant: boolean) => {
    const accepted: { x: number; z: number; h: number }[] = [];
    for (let cluster = 0; cluster < 90 && accepted.length < count; cluster++) {
      const cx = -310 + random() * 540,
        cz = -255 + random() * 445;
      const members = 2 + Math.floor(random() * 5),
        spread = 12 + random() * 28;
      for (let member = 0; member < members && accepted.length < count; member++) {
        const angle = random() * Math.PI * 2,
          distance = Math.sqrt(random()) * spread;
        const x = cx + Math.cos(angle) * distance,
          z = cz + Math.sin(angle) * distance;
        const h = watershedHeight(x, z);
        if (
          h < (plant ? 3 : 0.4) ||
          h > 42 ||
          lakeShoreDistance(x, z) < 1.22 ||
          !riverClearance(x, z) ||
          accepted.some((p) => Math.hypot(x - p.x, z - p.z) < spacing)
        )
          continue;
        accepted.push({ x, z, h });
      }
    }
    return accepted;
  };
  for (const { x, z, h } of scatter(46, 4, false)) {
    const size = 1.2 + random() ** 1.8 * 5.5,
      angle = random() * Math.PI * 2;
    const rock = rocks[Math.floor(random() * rocks.length)];
    if (rock === undefined) throw new Error('Missing authored rock');
    spawn(
      rock,
      1 + Math.floor(random() * 2),
      [x, h + size * 0.22, z],
      [size, size * (0.62 + random() * 0.4), size * (0.7 + random() * 0.55)],
      angle,
    );
  }
  for (const { x, z, h } of scatter(30, 8, true)) {
    const height = 5.5 + random() * 9,
      angle = random() * Math.PI * 2;
    const trunk = 1.05 + random() * 1.2,
      canopy = 2.1 + height * 0.14;
    spawn(post, 0, [x, h + height / 2, z], [trunk, height, trunk], angle);
    const leafCount = 5 + Math.floor(random() * 3),
      tint = 3 + Math.floor(random() * 3);
    for (let leaf = 0; leaf < leafCount; leaf++) {
      const leafSize = canopy * (0.8 + random() * 0.35);
      spawn(
        frond,
        tint,
        [x, h + height - random() * 0.45, z],
        [leafSize, leafSize * (0.72 + random() * 0.3), leafSize],
        (leaf / leafCount) * Math.PI * 2 + angle + (random() - 0.5) * 0.25,
      );
    }
  }
  // An 18 m timber crossing follows the descending river at the valley station.
  for (let i = 0; i < 28; i++) {
    const z = -1 + i * 0.65;
    spawn(box, 0, [-59, 20.1, z - 176], [4, 0.22, 0.61]);
    if (i % 7 === 0) for (const x of [-60.8, -57.2]) spawn(post, 0, [x, 18.8, z - 176], [1, 4, 1]);
  }
  for (const x of [-61, -57]) {
    spawn(box, 0, [x, 21.2, -168], [0.12, 0.15, 19]);
    for (let i = 0; i < 8; i++) spawn(post, 0, [x, 20.7, -177 + i * 2.6], [0.35, 1.4, 0.35]);
  }
  // Small lake jetty gives human scale without an exhibition platform.
  for (let i = 0; i < 22; i++) spawn(box, 0, [-171, 30.7, -99 + i * 0.6], [3, 0.18, 0.56]);
  for (let i = 0; i < 6; i++)
    for (const x of [-172.2, -169.8]) spawn(post, 0, [x, 29.2, -99 + i * 2.6], [1, 4, 1]);
}
