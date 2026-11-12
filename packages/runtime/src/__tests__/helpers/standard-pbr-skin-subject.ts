import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import type { Materials } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { MaterialPass, MeshAsset } from '@forgeax/engine-types';

/** Apply the same published Skin program selection used by lighting-channels.fixture.ts. */
export function standardPbrSkinMaterial(
  authored: ReturnType<typeof Materials.standard>,
): ReturnType<typeof Materials.standard> {
  const passes = authored.passes;
  if (passes === undefined) throw new Error('Standard skin fixture has no authored passes');
  const mapPass = (pass: MaterialPass): MaterialPass =>
    pass.program.module === 'forgeax_material::standard'
      ? {
          ...pass,
          program: { ...pass.program, module: 'forgeax::pbr-skin' },
        }
      : pass;
  const [firstPass, ...remainingPasses] = passes;
  if (firstPass === undefined) throw new Error('Standard skin fixture has no first pass');
  return {
    ...authored,
    passes: [mapPass(firstPass), ...remainingPasses.map(mapPass)],
  };
}

/** Add the same four-lane JOINTS_0/WEIGHTS_0 ABI used by the lighting channel fixture. */
export function standardPbrSkinMesh(source: MeshAsset): MeshAsset {
  const count = source.submeshes?.[0]?.vertexCount;
  if (count === undefined || count <= 0)
    throw new Error('Standard skin fixture mesh has no vertices');
  const weights = new Float32Array(count * 4);
  for (let vertex = 0; vertex < count; vertex += 1) weights[vertex * 4] = 1;
  const attributes = {
    ...source.attributes,
    skinIndex: new Uint16Array(count * 4),
    skinWeight: weights,
  };
  const packed = packInterleavedVertexAttributes(attributes, count);
  if (!packed.ok) throw packed.error;
  return { ...source, attributes, vertices: packed.value.vertices };
}

/** Attach the real one-joint Skin contract; the supplied joint pose is world-space. */
export function attachStandardPbrSkin(
  world: World,
  assets: AssetRegistry,
  receiver: EntityHandle,
  jointWorldPosition: readonly [number, number, number],
) {
  const joint = world
    .spawn({ component: Transform, data: { pos: [...jointWorldPosition] } })
    .unwrap();
  const inverseBindMatrices = new Float32Array(16);
  inverseBindMatrices[0] = 1;
  inverseBindMatrices[5] = 1;
  inverseBindMatrices[10] = 1;
  inverseBindMatrices[15] = 1;
  const skeleton = assets
    .create({
      kind: 'skeleton',
      jointCount: 1,
      inverseBindMatrices,
      bounds: new Float32Array([-1, -1, -1, 1, 1, 1]),
    })
    .unwrap();
  world
    .addComponent(receiver, {
      component: Skin,
      data: { skeleton, joints: new Uint32Array([joint as unknown as number]) },
    })
    .unwrap();
  return { joint, skeleton };
}
