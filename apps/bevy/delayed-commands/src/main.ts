// apps/bevy/delayed-commands - demonstrate forgeax's CommandBuffer (deferred entity mutation).
//
// Spawns a row of cubes. A system uses Commands to despawn the oldest cube and spawn a new
// one each second, cycling through colors. The `fn(_world, _queryResults, commands)` third
// parameter is the CommandBuffer — the forgeax equivalent of Bevy's `Commands`.

import { createApp } from '@forgeax/engine-app/browser';
import { Time, Update } from '@forgeax/engine-ecs';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import { PointLight } from '@forgeax/engine-render';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-delayed-commands: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  console.error('[bevy-delayed-commands] bootstrap error:', err);
});

const COLORS: readonly [number, number, number, number][] = [
  [1, 0.3, 0.3, 1],
  [0.3, 1, 0.3, 1],
  [0.3, 0.3, 1, 1],
  [1, 1, 0.3, 1],
  [1, 0.3, 1, 1],
];

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-delayed-commands] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('App asset service is unavailable');
  const world = app.world;

  const boxGeom = createBoxGeometry(0.5, 0.5, 0.5, 1, 1, 1);
  if (!boxGeom.ok) { console.error('box geom failed'); return; }
  const boxHandle = assets.create(boxGeom.value).unwrap();

  const matHandles = COLORS.map((color) =>
    assets.create(Materials.standard({ baseColor: color })).unwrap(),
  );

  // Spawn initial row of 5 cubes
  const entities: EntityHandle[] = [];
  let colorIndex = 0;
  for (let i = 0; i < 5; i++) {
    const e = world.spawn(
      { component: Transform, data: { pos: [i - 2, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: MeshFilter, data: { assetHandle: boxHandle } },
      { component: MeshRenderer, data: { materials: [matHandles[colorIndex]!] } },
    ).unwrap();
    entities.push(e);
    colorIndex = (colorIndex + 1) % COLORS.length;
  }

  // Light + Camera
  world.spawn(
    { component: Transform, data: { pos: [4, 8, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: [1, 1, 1], intensity: 400, range: 40 } },
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 6], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );

  // System: every second, despawn oldest + spawn new via Commands
  let accumulator = 0;
  app.world.addSystem(Update, {
    name: 'delayed-commands',
    queries: [],
    fn: (_world, _queryResults, commands) => {
      const dt = _world.getResource(Time)?.delta ?? 0;
      accumulator += dt;
      if (accumulator < 1.0) return;
      accumulator -= 1.0;

      const old = entities.shift();
      if (old !== undefined) commands.despawn(old);

      const newEntity = commands.spawn(
        { component: Transform, data: { pos: [2, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { component: MeshFilter, data: { assetHandle: boxHandle } },
        { component: MeshRenderer, data: { materials: [matHandles[colorIndex]!] } },
      );
      entities.push(newEntity);
      colorIndex = (colorIndex + 1) % COLORS.length;
    },
  });

  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-delayed-commands] app.start() failed:', started.error);
  }
}
