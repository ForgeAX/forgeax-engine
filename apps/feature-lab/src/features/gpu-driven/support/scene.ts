import type { App } from '@forgeax/engine/app';
import type { EntityHandle, World } from '@forgeax/engine/ecs';
import { MESH, spawnCamera, spawnMesh, spawnSun, standard } from '../../../lab/stage';

/**
 * A 5x4 grid of opaque Standard cubes in front of the camera plus `hidden` cubes
 * placed behind it, so frustum culling has something to reject.
 */
export function spawnGrid(
  world: World,
  hidden = 0,
): { readonly visible: EntityHandle[]; readonly hiddenCubes: EntityHandle[] } {
  spawnCamera(world, { eye: [0, 2.5, 7], target: [0, 0.5, 0] });
  spawnSun(world);
  const visible: EntityHandle[] = [];
  const colors: [number, number, number, number][] = [
    [0.95, 0.2, 0.15, 1],
    [0.2, 0.8, 0.3, 1],
    [0.2, 0.4, 0.95, 1],
    [0.95, 0.8, 0.2, 1],
  ];
  for (let row = 0; row < 4; row++) {
    const mat = standard(world, { baseColor: colors[row] ?? [1, 1, 1, 1], roughness: 0.6 });
    for (let col = 0; col < 5; col++) {
      visible.push(
        spawnMesh(world, MESH.cube, mat, {
          pos: [(col - 2) * 1.3, 0.4, (row - 2) * 1.3],
          scale: [0.8, 0.8, 0.8],
        }),
      );
    }
  }
  const hiddenMat = standard(world, { baseColor: [1, 0, 1, 1] });
  const hiddenCubes: EntityHandle[] = [];
  for (let i = 0; i < hidden; i++)
    hiddenCubes.push(
      spawnMesh(world, MESH.cube, hiddenMat, { pos: [(i - hidden / 2) * 1.5, 0.5, 20] }),
    );
  return { visible, hiddenCubes };
}

type Inspection = ReturnType<App['renderer']['inspect']>;

export function inspect(app: App): {
  readonly caps: Inspection['capabilities'];
  readonly gpu: Inspection['renderScene']['gpu'];
  readonly driven: Inspection['renderScene']['gpuDriven'];
  readonly frustum: Inspection['frustumStats'];
  readonly passes: Inspection['perFramePassNames'];
} {
  const inspection = app.renderer.inspect();
  return {
    caps: inspection.capabilities,
    gpu: inspection.renderScene.gpu,
    driven: inspection.renderScene.gpuDriven,
    frustum: inspection.frustumStats,
    passes: inspection.perFramePassNames,
  };
}

export function mainChannel(app: App) {
  return app.renderer
    .inspect()
    .renderScene.gpuDriven.channels.find((channel) => channel.viewPass === 'main');
}
