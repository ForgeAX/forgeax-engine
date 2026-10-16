import type { EntityHandle } from '@forgeax/engine/ecs';
import { packInterleavedVertexAttributes } from '@forgeax/engine/geometry';
import { quat } from '@forgeax/engine/math';
import { ChildOf, GlobalTransform, Name, Transform } from '@forgeax/engine/scene';
import { Skin } from '@forgeax/engine/skinning';
import type { MeshAsset, SkeletonAsset, VertexAttributeMap } from '@forgeax/engine/types';
import { CheckList, defineFeature } from '../../lab/feature';
import { material, spawnMesh, spawnStage } from '../../lab/stage';

const ROWS = 9;

function ribbon(): MeshAsset | undefined {
  const count = ROWS * 2;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const tangent = new Float32Array(count * 4);
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const y = (Math.floor(i / 2) / (ROWS - 1)) * 2;
    const upper = Math.max(0, Math.min(1, y - 0.75));
    position.set([i % 2 === 0 ? -0.3 : 0.3, y, 0], i * 3);
    normal.set([0, 0, 1], i * 3);
    uv.set([i % 2, y / 2], i * 2);
    tangent.set([1, 0, 0, 1], i * 4);
    skinIndex.set([0, 1, 0, 0], i * 4);
    skinWeight.set([1 - upper, upper, 0, 0], i * 4);
  }
  const indices: number[] = [];
  for (let row = 0; row < ROWS - 1; row++) {
    const a = row * 2;
    indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const attributes: VertexAttributeMap = { position, normal, uv, tangent, skinIndex, skinWeight };
  const packed = packInterleavedVertexAttributes(attributes, count);
  if (!packed.ok) return undefined;
  return {
    kind: 'mesh',
    vertices: packed.value.vertices,
    indices: new Uint16Array(indices),
    attributes,
    aabb: new Float32Array([-0.3, 0, 0, 0.3, 2, 0]),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: count,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
  };
}

const bend = (on: boolean): Float32Array =>
  quat.fromAxisAngle(quat.create(), [0, 0, 1], on ? 1.2 : 0) as Float32Array;

export default defineFeature({
  title: 'GPU skin palette',
  catalog: 'GPU skin palette',
  kind: 'visual',
  summary:
    'Render derives each joint matrix as GlobalTransform.world x inverseBindMatrix and the forgeax::pbr-skin shader blends up to four weighted joints per vertex.',
  expect:
    'ON: three cyan ribbons bend smoothly sideways at mid-height because the upper joint is rotated 1.2 rad about Z. OFF: the joint is at identity and the ribbons stand straight.',
  setup({ world, hud }) {
    spawnStage(world, { eye: [0, 1.2, 5], target: [0, 1, 0] });
    const asset = ribbon();
    if (asset === undefined) {
      hud.status('ribbon mesh failed to pack');
      return {};
    }
    const mesh = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', asset);
    const skinMaterial = material(world, {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::pbr-skin' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: { baseColor: [0.15, 0.8, 1, 1], metallic: 0, roughness: 0.35 },
    });
    const skeleton: SkeletonAsset = {
      kind: 'skeleton',
      jointCount: 2,
      inverseBindMatrices: new Float32Array([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1,
        0, 1,
      ]),
    };
    const skeletonHandle = world.allocSharedRef('SkeletonAsset', skeleton);
    const uppers: EntityHandle[] = [];
    for (let i = 0; i < 3; i++) {
      const root = world
        .spawn(
          { component: Name, data: { value: `root-${i}` } },
          { component: Transform, data: { pos: [(i - 1) * 1.4, 0, 0] } },
        )
        .unwrap() as EntityHandle;
      const upper = world
        .spawn(
          { component: Name, data: { value: `upper-${i}` } },
          { component: Transform, data: { pos: [0, 1, 0], quat: bend(true) } },
          { component: ChildOf, data: { parent: root } },
        )
        .unwrap() as EntityHandle;
      spawnMesh(
        world,
        mesh,
        skinMaterial,
        {},
        { component: Skin, data: { skeleton: skeletonHandle, joints: [root, upper] } },
      );
      uppers.push(upper);
    }
    const setErrors: string[] = [];
    let jointX = Number.NaN;
    return {
      toggle(on) {
        for (const upper of uppers) {
          const result = world.set(upper, Transform, { quat: bend(on) } as never);
          if (!result.ok) setErrors.push(String(result.error.code));
        }
      },
      checks() {
        const checks = new CheckList();
        checks.ok('joint Transform writes succeed', setErrors.length === 0, setErrors.join(','));
        const upper = uppers[0];
        if (upper !== undefined) {
          const global = world.get(upper, GlobalTransform);
          jointX = global.ok ? (global.value.world[4] as number) : Number.NaN;
        }
        checks.ok(
          'bent joint GlobalTransform rotated (world[4] = -sin 1.2)',
          Math.abs(jointX + Math.sin(1.2)) < 1e-3,
          `world[4]=${jointX}`,
        );
        return checks.items;
      },
    };
  },
});
