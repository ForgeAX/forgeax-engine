import type { EntityHandle } from '@forgeax/engine/ecs';
import { packInterleavedVertexAttributes } from '@forgeax/engine/geometry';
import { Lines, Materials, PointShapeValue, Points } from '@forgeax/engine/render';
import type { MeshAsset } from '@forgeax/engine/types';
import { CheckList, defineFeature } from '../../lab/feature';
import { material, spawnCamera, spawnMesh } from '../../lab/stage';

function listMesh(
  topology: 'point-list' | 'line-list',
  points: readonly (readonly [number, number, number])[],
): MeshAsset | undefined {
  const count = points.length;
  const position = new Float32Array(points.flat());
  const normal = new Float32Array(count * 3);
  const tangent = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    normal[i * 3 + 2] = 1;
    tangent[i * 4] = 1;
    tangent[i * 4 + 3] = 1;
  }
  const attributes = { position, normal, uv: new Float32Array(count * 2), tangent };
  const packed = packInterleavedVertexAttributes(attributes, count);
  if (!packed.ok) return undefined;
  return {
    kind: 'mesh',
    vertices: packed.value.vertices,
    attributes,
    aabb: new Float32Array([-1.6, -1, 0, 1.6, 1, 0]),
    submeshes: [{ indexOffset: 0, indexCount: 0, vertexCount: count, topology, materialSlot: 0 }],
    materialSlots: [{ slotName: 'points-lines' }],
  };
}

export default defineFeature({
  title: 'Points and Lines',
  catalog: 'Points/Lines rendering',
  kind: 'visual',
  summary:
    'Points { sizePx, shape } and Lines { width, dash } expand ordinary point-list / line-list MeshAssets drawn with Materials.unlit into screen-space quads in the Standard main pass.',
  expect:
    'ON: five large yellow round dots above three thick magenta bars. OFF: the same vertices at 1 px - nearly invisible specks and hairlines.',
  setup({ app, world }) {
    const errors: string[] = [];
    app.onError((error) => {
      errors.push(
        JSON.stringify({
          code: error.code,
          detail: (error as { detail?: unknown }).detail ?? null,
        }),
      );
    });
    spawnCamera(world, {
      eye: [0, 0, 4],
      target: [0, 0, 0],
      data: { clearColor: [0.02, 0.02, 0.04, 1] },
    });
    const points = listMesh('point-list', [
      [-1.4, 0.6, 0],
      [-0.7, 0.8, 0],
      [0, 0.55, 0],
      [0.7, 0.8, 0],
      [1.4, 0.6, 0],
    ]);
    const lines = listMesh('line-list', [
      [-1.5, -0.2, 0],
      [1.5, -0.2, 0],
      [-1.5, -0.55, 0],
      [1.5, -0.55, 0],
      [-1.5, -0.9, 0],
      [1.5, -0.9, 0],
    ]);
    if (points === undefined || lines === undefined) return {};
    const style = (rgba: readonly [number, number, number, number]) =>
      material(world, Materials.unlit(rgba));
    const dots: EntityHandle = spawnMesh(
      world,
      world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', points),
      style([1, 0.9, 0.1, 1]),
      {},
      { component: Points, data: { sizePx: 40, shape: PointShapeValue.circle } },
    );
    const bars: EntityHandle = spawnMesh(
      world,
      world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', lines),
      style([1, 0.2, 0.9, 1]),
      {},
      { component: Lines, data: { width: 16 } },
    );
    return {
      toggle(on) {
        world.set(dots, Points, { sizePx: on ? 40 : 1 } as never);
        world.set(bars, Lines, { width: on ? 16 : 1 } as never);
      },
      checks() {
        const checks = new CheckList();
        checks.ok(
          'no app error across widths',
          errors.length === 0,
          errors.slice(0, 2).join(' | '),
        );
        return checks.items;
      },
    };
  },
});
