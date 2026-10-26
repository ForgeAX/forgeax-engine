import { mat4 } from '@forgeax/engine-math';
import type { ShadowCapsuleSet } from '@forgeax/engine-types';
import { GpuInputArena } from '../gpu-input-arena';
import { MaterialResource } from '../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { SkinFrames, SkinSceneInputs } from '../scene/skin-scene-inputs';

export function skinTaskFixture(jointCount = 1, shadowCapsules?: ShadowCapsuleSet) {
  const arena = new GpuInputArena(),
    scene = new RenderScene(),
    inverse = new Float32Array(jointCount * 16);
  const matrix = mat4.identity(mat4.create()),
    joints = Array.from({ length: jointCount }, (_, index) => index + 19);
  for (let index = 0; index < jointCount; index++) inverse.set(matrix, index * 16);
  const skin = new SkinSceneInputs(arena, () => ({
    kind: 'skeleton',
    jointCount,
    inverseBindMatrices: inverse,
    ...(shadowCapsules === undefined ? {} : { shadowCapsules }),
  }));
  const material = MaterialResource.from(defaultMaterialSnapshot());
  const row = (entityKey: number): RenderableSnapshot => ({
    worldId: 0,
    entityKey,
    transform: { world: matrix },
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    skinBinding: { skeleton: 7, joints },
  });
  skin.apply(
    scene.apply(
      [17, 23].map((entityKey) => ({
        kind: 'update',
        worldId: 0,
        entityKey,
        snapshot: row(entityKey),
      })),
    ),
  );
  matrix[12] = 3;
  for (const joint of joints) skin.joint(0, joint, matrix);
  const frames = new SkinFrames(skin);
  const frame = frames.prepareFrame(scene.slotsSnapshot());
  if (frame === undefined) throw new Error('Missing fixed Skin task fixture');
  const first = frame.slots.lookup(0, 17),
    second = frame.slots.lookup(0, 23);
  if (first === undefined || second === undefined)
    throw new Error('Missing actual Skin Scene slots');
  return {
    skin,
    frames,
    arena,
    scene,
    frame,
    first,
    second,
    matrix,
    dispose: () => {
      frames.resetHistory();
      skin.dispose();
      arena.dispose();
    },
  };
}
