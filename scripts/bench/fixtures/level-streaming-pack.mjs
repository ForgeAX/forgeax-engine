import { validateAssetPublication } from '../../../packages/assets-runtime/dist/index.mjs';
import { Disabled } from '../../../packages/ecs/dist/index.mjs';
import { componentSchema } from '../../../packages/ecs/dist/internal.mjs';
import {
  buildMeshCollision,
  createBoxGeometry,
  meshAssetContribution,
} from '../../../packages/geometry/dist/index.mjs';
import { textureContribution } from '../../../packages/image/dist/index.mjs';
import {
  prepareRuntimePackContent,
  RuntimePackProducer,
} from '../../../packages/import/dist/index.mjs';
import { AssetGuid, definePackageId } from '../../../packages/pack/dist/scriptable-pack.mjs';
import { Collider, ColliderShapeValue, RigidBody } from '../../../packages/physics/dist/index.mjs';
import {
  Instances,
  Layer,
  Materials,
  MeshFilter,
  MeshRenderer,
  materialContribution,
  SceneInstance,
  ShadowParticipation,
  Visibility,
} from '../../../packages/render/dist/index.mjs';
import {
  ChildOf,
  Children,
  Mobility,
  Name,
  sceneAssetContribution,
  Transform,
} from '../../../packages/scene/dist/index.mjs';

export const levelComponents = [
  Disabled,
  Transform,
  ChildOf,
  Children,
  Name,
  Mobility,
  MeshFilter,
  MeshRenderer,
  ShadowParticipation,
  Visibility,
  Instances,
  Layer,
  SceneInstance,
  Collider,
  RigidBody,
];
export const levelDecoders = [
  meshAssetContribution,
  textureContribution,
  materialContribution,
  sceneAssetContribution,
];
const packageId = 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111';
const id = definePackageId(packageId);
const guid = (key) => AssetGuid.derive(id, key);
const guidText = (key) => AssetGuid.format(guid(key));

function texture(workload, index) {
  const [width, height] = workload.textureExtent,
    data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    data[pixel * 4] = 40 + index * 20;
    data[pixel * 4 + 1] = 100 + index * 11;
    data[pixel * 4 + 2] = 190 - index * 7;
    data[pixel * 4 + 3] =
      ((Math.floor(pixel / width / 16) + Math.floor((pixel % width) / 16)) % 2) * 255;
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width, height } },
    format: 'rgba8unorm-srgb',
    colorSpace: 'srgb',
    mips: { kind: 'none' },
    data,
  };
}
function colliderShape(workload, index) {
  let end = 0;
  for (const [name, count] of Object.entries(workload.colliders)) {
    end += count;
    if (index < end) return name;
  }
}
function childScene(workload, group, size, withInstances) {
  return {
    kind: 'scene',
    entities: Object.fromEntries([
      ...Array.from({ length: size }, (_, local) => {
        const index = group * size + local,
          shape = colliderShape(workload, index);
        return [
          `n${local}`,
          {
            components: {
              Transform: { pos: [local % 8, 0, Math.floor(local / 8)] },
              Mobility: { kind: 0 },
              MeshFilter: { assetHandle: guidText(`mesh/${index % workload.meshAssets}`) },
              MeshRenderer: {
                materials: [guidText(`material/${index % workload.materialAssets}`)],
              },
              ShadowParticipation: { cast: true, receive: true },
              ...(local === 0 ? {} : { ChildOf: { parent: 'n0' } }),
              ...(local === size - 1 ? { Disabled: {} } : {}),
              ...(shape === undefined
                ? {}
                : {
                    Collider: {
                      shape: ColliderShapeValue[shape],
                      ...(shape === 'trimesh'
                        ? { mesh: guidText(`mesh/${index % workload.meshAssets}`) }
                        : {}),
                    },
                  }),
            },
          },
        ];
      }),
      ...(withInstances && group < workload.alternateInstancesCase.groups
        ? [
            [
              `instances-${group}`,
              {
                components: {
                  Transform: { pos: [0, 2, 0] },
                  ChildOf: { parent: 'n0' },
                  Mobility: { kind: 0 },
                  MeshFilter: { assetHandle: guidText(`mesh/${group % workload.meshAssets}`) },
                  MeshRenderer: {
                    materials: [guidText(`material/${group % workload.materialAssets}`)],
                  },
                  ShadowParticipation: { cast: true, receive: true },
                  Instances: {
                    transforms: instanceTransforms(
                      workload.alternateInstancesCase.instancesPerGroup,
                    ),
                  },
                },
              },
            ],
          ]
        : []),
    ]),
  };
}

function instanceTransforms(count) {
  const transforms = new Float32Array(count * 16);
  for (let index = 0; index < count; index++) {
    const base = index * 16;
    for (const diagonal of [0, 5, 10, 15]) transforms[base + diagonal] = 1;
    transforms[base + 12] = index % 8;
    transforms[base + 14] = Math.floor(index / 8);
  }
  return transforms;
}

/** Real producer route; construction/validation is outside consumer load timing. */
export async function createLevelStreamingPack(profile, { withInstances = false, baseUrl } = {}) {
  const workload = profile.streetBlock,
    outputs = {},
    size = workload.meshEntities / workload.nestedInstances;
  if (withInstances && workload.alternateInstancesCase.groups > workload.nestedInstances)
    throw new Error(
      'the Instances case requires one original nested group for each instance group',
    );
  const maskedMaterials =
    workload.maskedEntities / (workload.meshEntities / workload.materialAssets);
  if (
    !Number.isInteger(size) ||
    !Number.isInteger(maskedMaterials) ||
    workload.hierarchyDepth !== 4
  )
    throw new Error('the source fixture must preserve the frozen distribution and hierarchy');
  for (let i = 0; i < workload.textureAssets; i++) outputs[`texture/${i}`] = texture(workload, i);
  for (let i = 0; i < workload.meshAssets; i++) {
    const mesh = createBoxGeometry(
      0.8 + (i % 4) * 0.05,
      1 + (i % 3) * 0.1,
      0.8 + (i % 5) * 0.04,
    ).unwrap();
    outputs[`mesh/${i}`] = { ...mesh, collision: buildMeshCollision(mesh).unwrap() };
  }
  for (let i = 0; i < workload.materialAssets; i++)
    outputs[`material/${i}`] = Materials.standard({
      baseColor: [0.4, 0.5, 0.6, 1],
      roughness: 0.55 + i * 0.02,
      baseColorTexture: { texture: guid(`texture/${i % workload.textureAssets}`) },
      alphaCutoff: i < maskedMaterials ? 0.5 : 0,
    });
  for (let group = 0; group < workload.nestedInstances; group++)
    outputs[`scene/${group}`] = childScene(workload, group, size, withInstances);
  outputs['scene/root'] = {
    kind: 'scene',
    entities: Object.fromEntries(
      Array.from({ length: workload.nestedInstances }, (_, i) => [
        `cell${i}`,
        {
          components: { Transform: { pos: [(i % 8) * 12, 0, Math.floor(i / 8) * 12] } },
          instance: { source: guidText(`scene/${i}`) },
        },
      ]),
    ),
  };
  const content = (
    await prepareRuntimePackContent(packageId, outputs, {
      sceneComponents: levelComponents.map((component) => ({
        name: component.name,
        fields: componentSchema(component),
      })),
    })
  ).unwrap();
  const producer = new RuntimePackProducer({
    scopeId: 'level-cold-probe',
    ...(baseUrl === undefined ? {} : { baseUrl }),
    validate: (state, fetcher, dependencies) =>
      validateAssetPublication(state.rows, fetcher, undefined, {
        decoders: levelDecoders,
        dependencies,
      }),
  });
  const receipt = (await producer.admit(content)).unwrap();
  return {
    producer,
    rootGuid: guidText('scene/root'),
    guids: receipt.rows.map((row) => row.guid),
    facts: {
      workloadCase: withInstances ? 'street-block-plus-instances' : 'street-block',
      instanceGroups: withInstances ? workload.alternateInstancesCase.groups : 0,
      instancesPerGroup: withInstances ? workload.alternateInstancesCase.instancesPerGroup : 0,
      outputs: receipt.rows.length,
      binaryArtifacts: Object.keys(content.blobs ?? {}).length,
      textureBytes:
        workload.textureAssets * workload.textureExtent[0] * workload.textureExtent[1] * 4,
      production: 'ordinary RuntimePackProducer and domain output producers',
    },
  };
}
