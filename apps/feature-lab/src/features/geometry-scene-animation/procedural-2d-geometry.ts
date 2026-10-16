import type { EntityHandle } from '@forgeax/engine/ecs';
import { create2dGeometry, create2dRingGeometry, type Shape2d } from '@forgeax/engine/geometry';
import { MeshFilter } from '@forgeax/engine/render';
import type { MeshAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnMesh, unlit } from '../../lab/stage';

const SHAPES: readonly Shape2d[] = [
  { kind: 'circle', radius: 0.45, resolution: 40 },
  { kind: 'circular-sector', radius: 0.5, angle: Math.PI * 1.4 },
  { kind: 'ellipse', halfWidth: 0.5, halfHeight: 0.28 },
  { kind: 'annulus', innerRadius: 0.22, outerRadius: 0.48 },
  { kind: 'capsule', radius: 0.22, halfLength: 0.25 },
  { kind: 'rhombus', halfWidth: 0.35, halfHeight: 0.5 },
  { kind: 'regular-polygon', radius: 0.48, sides: 6 },
  {
    kind: 'triangle',
    vertices: [
      [-0.45, -0.4],
      [0.45, -0.4],
      [0, 0.5],
    ],
  },
];

const COLORS: readonly (readonly [number, number, number, number])[] = [
  [1, 0.25, 0.25, 1],
  [1, 0.6, 0.1, 1],
  [1, 1, 0.2, 1],
  [0.3, 1, 0.3, 1],
  [0.2, 1, 1, 1],
  [0.3, 0.5, 1, 1],
  [0.7, 0.3, 1, 1],
  [1, 0.3, 0.8, 1],
];

export default defineFeature({
  title: '2D procedural geometry',
  catalog: '2D Procedural Geometry',
  kind: 'visual',
  summary:
    'create2dGeometry turns a closed Shape2d union (circle, sector, ellipse, annulus, capsule, rhombus, polygon, triangle...) into a flat XY MeshAsset; create2dRingGeometry outlines one.',
  expect:
    'ON: two rows of eight flat unlit shapes plus a hexagon ring outline. OFF: every shape becomes the same flat square quad.',
  setup({ world }) {
    spawnCamera(world, { eye: [0, 0, 6], target: [0, 0, 0] });
    const entities: { entity: EntityHandle; mesh: ReturnType<typeof world.allocSharedRef> }[] = [];
    const add = (
      name: string,
      result: ReturnType<typeof create2dGeometry>,
      index: number,
      pos: readonly [number, number, number],
    ) => {
      if (!result.ok) {
        console.warn(`[feature-lab] ${name} failed: ${result.error.code}`);
        return;
      }
      const mesh = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', result.value);
      entities.push({
        entity: spawnMesh(
          world,
          mesh,
          unlit(world, COLORS[index % COLORS.length] ?? [1, 1, 1, 1]),
          { pos },
        ),
        mesh,
      });
    };
    SHAPES.forEach((shape, index) => {
      add(shape.kind, create2dGeometry(shape), index, [
        ((index % 4) - 1.5) * 1.3,
        index < 4 ? 0.7 : -0.5,
        0,
      ]);
    });
    add(
      'ring',
      create2dRingGeometry({ kind: 'regular-polygon', radius: 0.45, sides: 6 }, 0.06),
      4,
      [0, -1.6, 0],
    );
    return {
      toggle(on) {
        for (const { entity, mesh } of entities)
          world.set(entity, MeshFilter, { assetHandle: on ? mesh : MESH.quad } as never);
      },
    };
  },
});
