import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { MeshRenderer } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { spawnMesh, spawnStage, standard } from '../../lab/stage';

const SHAPES = ['cube', 'triangle', 'quad', 'sphere', 'nine-slice-quad', 'cylinder'] as const;
const COLORS = [
  [0.9, 0.2, 0.2, 1],
  [0.95, 0.6, 0.15, 1],
  [0.95, 0.85, 0.2, 1],
  [0.2, 0.8, 0.3, 1],
  [0.2, 0.4, 0.95, 1],
  [0.7, 0.3, 0.9, 1],
] as const;

export default defineFeature({
  title: 'Code-created primitive assets',
  catalog: 'Builtin mesh handles',
  kind: 'visual',
  summary:
    'Six geometry factories create ordinary runtime mesh assets; the host owns their identity, contents and lifetime.',
  expect:
    'ON: six saturated shapes. OFF: the same shapes turn white. Each mesh resolves through its owner and rejects a foreign owner.',
  setup({ app, world }) {
    spawnStage(world);
    const assets = app.assets;
    if (assets === undefined) throw new Error('App asset service is unavailable');
    const sharedBefore = world.sharedRefs._liveCount();
    const meshes = SHAPES.map((shape) =>
      assets.create(createPrimitiveMesh(shape).unwrap()).unwrap(),
    );
    const tinted = COLORS.map((baseColor) =>
      standard(world, { baseColor, roughness: 0.5, renderState: { cullMode: 'none' } }),
    );
    const white = standard(world, {
      baseColor: [1, 1, 1, 1],
      roughness: 0.5,
      renderState: { cullMode: 'none' },
    });
    const entities = meshes.map((mesh, index) => {
      const material = tinted[index];
      if (material === undefined) throw new Error('Primitive material is unavailable');
      return {
        material,
        entity: spawnMesh(world, mesh, material, {
          pos: [-2.5 + index, 0.6, 0],
          scale: [0.8, 0.8, 0.8],
        }),
      };
    });
    return {
      toggle(on) {
        entities.forEach(({ entity, material }) => {
          world.set(entity, MeshRenderer, { materials: [on ? material : white] }).unwrap();
        });
      },
      checks() {
        const foreign = new AssetRegistry();
        const checks = meshes.flatMap((mesh, index) => [
          { name: `${SHAPES[index]} resolves through its owner`, ok: assets.read(mesh).ok },
          { name: `${SHAPES[index]} rejects a foreign owner`, ok: !foreign.read(mesh).ok },
        ]);
        foreign.dispose();
        return [
          ...checks,
          {
            name: 'assets occupy no ECS shared-value slot',
            ok: world.sharedRefs._liveCount() === sharedBefore,
          },
        ];
      },
    };
  },
});
