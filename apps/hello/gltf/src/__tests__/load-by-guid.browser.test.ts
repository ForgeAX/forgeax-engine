import { publishGltfFixture } from './source-fixture';
import { Materials } from '@forgeax/engine-render';
import type { AssetHandle } from '@forgeax/engine-types';
// The browser transports a complete native publication through JSON, loads its
// scene GUID and instantiates the same handles into a World.

import type { ImportSubAsset } from '@forgeax/engine-types';
import { World } from '@forgeax/engine-ecs';
import {
  type GltfDoc,
  type GltfMaterialIr,
  type GltfNodeIr,
  meshIrToMeshAsset,
  parseGltf,
  type GltfSceneIr,
} from '@forgeax/engine-gltf';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { parsePackV2 } from '@forgeax/engine-pack/runtime';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Camera, MeshFilter, MeshRenderer, SceneInstance } from '@forgeax/engine-render';
import { ChildOf, Children, Transform } from '@forgeax/engine-scene';
import { type MaterialAsset } from '@forgeax/engine-runtime';
import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine-shader';
import type { Result, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

import boxGltfUrl from '../../assets/box.gltf?url';
import metaJson from '../../assets/box.gltf.meta.json' with { type: 'json' };

function makeMockShaderRegistry(): ShaderRegistry {
  const mockDevice: ShaderRegistryDevice = {
    createShaderModule() {
      return {
        ok: true,
        value: undefined,
        unwrap: () => undefined,
        unwrapOr: (d: unknown) => d,
      } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
    },
  };
  const sr = new ShaderRegistry({
    device: mockDevice,
    manifestUrl: undefined,
  });
  sr.installMaterialArtifact('forgeax::default-unlit', {
    source: 'fn main() {}',
    paramSchema: [{ name: 'baseColor', type: 'color' }],
  });
  return sr;
}

function findGuid(kind: 'mesh' | 'material' | 'scene'): AssetGuid {
  const entries = metaJson.subAssets as readonly ImportSubAsset[];
  const entry = entries.find((s) => s.kind === kind);
  if (entry === undefined) throw new Error(`box.gltf.meta.json missing subAsset kind=${kind}`);
  const parsed = AssetGuid.parse(entry.guid);
  if (!parsed.ok) throw new Error(`box.gltf.meta.json sub-asset guid parse failed: ${kind}`);
  return parsed.value;
}

function materialIrToPod(mat: GltfMaterialIr): MaterialAsset {
  return Materials.unlit(mat.baseColorFactor);
}

function gltfDocToSceneAsset(doc: GltfDoc, meshGuid: string, materialGuid: string): SceneAsset {
  const sceneIr: GltfSceneIr | undefined = doc.scenes[doc.defaultSceneIndex];
  if (sceneIr === undefined) throw new Error('GltfDoc.scenes[default] missing');
  const entities: Record<string, { components: Record<string, Record<string, unknown>> }> = {};
  for (const rootIdx of sceneIr.nodes) {
    const ir: GltfNodeIr | undefined = doc.nodes[rootIdx];
    if (ir === undefined) continue;
    const components: Record<string, Record<string, unknown>> = {
      Transform: {
        pos: [
          ir.transform.translation[0],
          ir.transform.translation[1],
          ir.transform.translation[2],
        ],
        quat: [
          ir.transform.rotation[0],
          ir.transform.rotation[1],
          ir.transform.rotation[2],
          ir.transform.rotation[3],
        ],
        scale: [ir.transform.scale[0], ir.transform.scale[1], ir.transform.scale[2]],
      },
    };
    if (ir.meshIndex !== null) {
      components.MeshFilter = { assetHandle: meshGuid };
      components.MeshRenderer = { materials: [materialGuid] };
    }
    entities[`node-${Object.keys(entities).length}`] = { components };
  }
  // BoxTextured fork: gltf nodes[1] is the perspective camera. The IR
  // does not currently expose camera reference; mirror the same byte
  // ordering main.ts uses so the spine matches.
  const camNode: GltfNodeIr | undefined = doc.nodes[1];
  if (camNode !== undefined) {
    entities[`node-${Object.keys(entities).length}`] = {
      components: {
        Transform: {
          pos: [
            camNode.transform.translation[0],
            camNode.transform.translation[1],
            camNode.transform.translation[2],
          ],
          quat: [
            camNode.transform.rotation[0],
            camNode.transform.rotation[1],
            camNode.transform.rotation[2],
            camNode.transform.rotation[3],
          ],
          scale: [
            camNode.transform.scale[0],
            camNode.transform.scale[1],
            camNode.transform.scale[2],
          ],
        },
        Camera: {
          fov: 0.7853981633974483,
          aspect: 1.7777777777777777,
          near: 0.1,
          far: 100,
        },
      },
    };
  }
  return { kind: 'scene', entities };
}

function registerSceneVocabulary(world: World): void {
  for (const component of [
    Camera,
    ChildOf,
    Children,
    MeshFilter,
    MeshRenderer,
    SceneInstance,
    Transform,
  ]) {
    world.components.register(component).unwrap();
  }
}

describe('hello-gltf w27 - loadByGuid<SceneAsset> spine + AC-07 + AC-15', () => {
  it('accepts a multi-asset Pack v2 envelope with GUID refs and local keys', () => {
    const parsed = parsePackV2({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: '019e2b88-aece-7b6e-bbfe-45d6453d21f3',
          kind: 'mesh',
          payload: { kind: 'mesh' },
          refs: [],
          artifacts: {
            body: {
              path: 'artifacts/mesh.bin',
              mediaType: 'application/x-forgeax-mesh',
            },
          },
        },
        {
          guid: '019e2b88-aecf-7e78-9888-655f0ec62ebc',
          kind: 'material',
          payload: { kind: 'material' },
          refs: ['019e2b88-aece-7b6e-bbfe-45d6453d21f3'],
          artifacts: {
            body: {
              path: 'artifacts/material.bin',
              mediaType: 'application/octet-stream',
            },
          },
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.assets[1]?.refs).toEqual(['019e2b88-aece-7b6e-bbfe-45d6453d21f3']);
    expect(Object.keys(parsed.value.assets[0]?.artifacts ?? {})).toEqual(['body']);
  });

  it('(a) loadByGuid<SceneAsset>(sceneGuid) infers Result<SceneAsset, AssetError>', async () => {
    const reg = new AssetRegistry({ shaderRegistry: makeMockShaderRegistry() });
    const world = new World({ assets: reg });
    registerSceneVocabulary(world);
    const meshGuid = findGuid('mesh');
    const matGuid = findGuid('material');
    const sceneGuid = findGuid('scene');

    const gltfRes = await fetch(boxGltfUrl);
    const gltfJson = (await gltfRes.json()) as unknown;
    const externalLoader = (uri: string): Promise<ArrayBuffer> => {
      throw new Error(`unexpected externalLoader call for uri=${uri}`);
    };
    const docResult = await parseGltf(gltfJson, externalLoader, boxGltfUrl);
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) return;

    const meshIr = docResult.value.meshes[0];
    const matIr = docResult.value.materials[0];
    expect(meshIr).toBeDefined();
    expect(matIr).toBeDefined();
    if (meshIr === undefined || matIr === undefined) return;

    // feat-20260614 M8 (D-17): registerWithGuid deleted. catalog(guid, payload)
    // feeds loadByGuid; world.allocSharedRef mints the column handle the local
    // scene builder embeds in MeshRenderer.materials.
    const meshPod = meshIrToMeshAsset([meshIr]).unwrap();
    const matPod = materialIrToPod(matIr);
    const sceneAsset = gltfDocToSceneAsset(
      docResult.value,
      AssetGuid.format(meshGuid),
      AssetGuid.format(matGuid),
    );
    publishGltfFixture(reg, {
      mesh: meshPod,
      material: matPod,
      scene: sceneAsset,
      meshGuid: AssetGuid.format(meshGuid),
      materialGuid: AssetGuid.format(matGuid),
      sceneGuid: AssetGuid.format(sceneGuid),
    });
    const sceneRes: Result<
      AssetHandle<'scene'>,
      import('@forgeax/engine-assets-runtime').RuntimeAssetError
    > = await reg.load(sceneGuid, 'scene');
    expect(sceneRes.ok).toBe(true);
    if (!sceneRes.ok) return;
    expect(reg.read(sceneRes.value).unwrap().kind).toBe('scene');

    // Sanity: the mesh + material payloads resolve on the same fast-path.
    const meshRes: Result<
      AssetHandle<'mesh'>,
      import('@forgeax/engine-assets-runtime').RuntimeAssetError
    > = await reg.load(meshGuid, 'mesh');
    expect(meshRes.ok).toBe(true);
    if (meshRes.ok) {
      expect(reg.read(meshRes.value).unwrap().attributes.position).toEqual(
        meshPod.attributes.position,
      );
    }
  });

  it('(b)+(c) sceneInstances.instantiate spawns mesh + camera entities', async () => {
    const reg = new AssetRegistry({ shaderRegistry: makeMockShaderRegistry() });
    const meshGuid = findGuid('mesh');
    const matGuid = findGuid('material');
    const sceneGuid = findGuid('scene');

    const gltfRes = await fetch(boxGltfUrl);
    const gltfJson = (await gltfRes.json()) as unknown;
    const externalLoader = (uri: string): Promise<ArrayBuffer> => {
      throw new Error(`unexpected externalLoader call for uri=${uri}`);
    };
    const docResult = await parseGltf(gltfJson, externalLoader, boxGltfUrl);
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) return;

    const meshIr = docResult.value.meshes[0];
    const matIr = docResult.value.materials[0];
    if (meshIr === undefined || matIr === undefined) return;

    const world = new World({ assets: reg });
    registerSceneVocabulary(world);

    // D-17: catalog feeds loadByGuid; allocSharedRef mints the material handle.
    const sceneAsset = gltfDocToSceneAsset(
      docResult.value,
      AssetGuid.format(meshGuid),
      AssetGuid.format(matGuid),
    );
    publishGltfFixture(reg, {
      mesh: meshIrToMeshAsset([meshIr]).unwrap(),
      material: materialIrToPod(matIr),
      scene: sceneAsset,
      meshGuid: AssetGuid.format(meshGuid),
      materialGuid: AssetGuid.format(matGuid),
      sceneGuid: AssetGuid.format(sceneGuid),
    });
    const sceneRes = await reg.load(sceneGuid, 'scene');
    expect(sceneRes.ok).toBe(true);
    if (!sceneRes.ok) return;

    // loadByGuid returns the payload (D-17); mint a user-tier column handle.
    const sceneHandle = sceneRes.value;
    const instRes = reg.instantiate(sceneHandle, world);
    expect(instRes.ok).toBe(true);
    if (!instRes.ok) return;

    // AC-15 (c) Tier-B World shape: the BoxTextured fork emits exactly one
    // mesh entity (archetype carries MeshFilter) and exactly one camera
    // entity (archetype carries Camera). Walk world.inspect() archetypes
    // (the AI-user-facing inspection surface) so the assertion is robust
    // across query-engine internals.
    const snap = world.inspect();
    let meshArchetypeEntities = 0;
    let cameraArchetypeEntities = 0;
    for (const arch of snap.archetypes) {
      if (arch.componentNames.includes('MeshFilter')) {
        meshArchetypeEntities += arch.entityCount;
      }
      if (arch.componentNames.includes('Camera')) {
        cameraArchetypeEntities += arch.entityCount;
      }
    }
    expect(meshArchetypeEntities).toBe(1);
    expect(cameraArchetypeEntities).toBe(1);
  });

  it('(d) AC-15: @forgeax/engine-runtime barrel does not export a loadGltf symbol', async () => {
    const runtime = (await import('@forgeax/engine-runtime')) as Record<string, unknown>;
    const exportedKeys = Object.keys(runtime);
    const offending = exportedKeys.filter(
      (k) => k.startsWith('loadGltf') || k === 'loadGltfFromUrl' || k === 'loadGltfBinary',
    );
    expect(offending).toEqual([]);
  });
});
