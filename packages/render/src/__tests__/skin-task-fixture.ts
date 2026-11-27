import { mat4 } from '@forgeax/engine-math';
import type { ShadowCapsuleSet } from '@forgeax/engine-types';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuInputArena } from '../gpu-input-arena';
import type { GpuScene } from '../gpu-scene';
import { MaterialResource } from '../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { SkinFrames, SkinSceneInputs } from '../scene/skin-scene-inputs';

export function skinTaskFixture(
  jointCount = 1,
  shadowCapsules?: ShadowCapsuleSet,
  affinePoint = false,
) {
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
  const meshWorld = mat4.identity(mat4.create());
  if (affinePoint) meshWorld[12] = 2;
  const row = (entityKey: number): RenderableSnapshot => ({
    entityKey,
    transform: { world: meshWorld },
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    skinBinding: { skeleton: 7, joints, ...(affinePoint ? { affinePoint } : {}) },
  });
  skin.apply(
    scene.apply(
      [17, 23].map((entityKey) => ({
        kind: 'update',
        entityKey,
        snapshot: row(entityKey),
      })),
    ),
  );
  matrix[12] = 3;
  for (const joint of joints) skin.joint(joint, matrix);
  const frames = new SkinFrames(skin);
  const frame = frames.prepareFrame(scene.slotsSnapshot());
  if (frame === undefined) throw new Error('Missing fixed Skin task fixture');
  const first = frame.slots.lookup(17),
    second = frame.slots.lookup(23);
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

/** Two live selector candidates keep cull, Skin and finalize bindings in the observed View. */
export function skinInputBindingPlan(source: RenderScene, scene: GpuScene) {
  const topology = new BatchTopology();
  const delta = source.apply(
    [...source.slotsSnapshot()].map(({ entityKey, snapshot }) => ({
      kind: 'update' as const,
      entityKey,
      snapshot: {
        ...snapshot,
        assetHandle: 3,
        gpuDrivenDraws: [
          {
            kind: 'indexed' as const,
            first: 0,
            count: 3,
            baseVertex: 0,
            materialSlot: 0,
            topology: 'triangle-list' as const,
            pipelineClass: 'skin',
            materialResourceClass: 'plain',
            geometry: {
              receipt: {
                identity: 'skin-input-bindings',
                vertexInputs: [],
                topology: 'triangle-list' as const,
                indexed: true,
              },
              draw: {
                kind: 'indexed' as const,
                first: 0,
                count: 3,
                baseVertex: 0,
                topology: 'triangle-list' as const,
              },
              deformation: 'skin' as const,
            },
          },
        ],
      },
    })),
  );
  scene.sync(delta).unwrap();
  topology.apply(delta);
  return topology.query(topology.sourcePlan(), undefined).active;
}
