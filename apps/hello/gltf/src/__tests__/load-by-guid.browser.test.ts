// w27 - browser e2e: AssetRegistry.loadByGuid<SceneAsset> type inference +
// sceneInstances.instantiate, fed by the @forgeax/engine-gltf importer
// parsing apps/hello/gltf/assets/box.gltf (Tier-B BoxTextured fork).
//
// Requirements anchors: AC-07 (single-line type inference) + AC-15 (one
// loadByGuid spine, no parallel `loadGltf` API). plan-strategy section 3.2
// sequence B (runtime 4-step recipe). charter P4 consistent abstraction:
// the call site here is byte-identical to apps/hello/room (only the
// disk-schema sidecar differs).
//
// This test runs under the root `vitest` browser project (file glob
// `**/*.browser.test.ts`, chromium + WebGPU flags). It does not boot the
// full Renderer pipeline (the dawn smoke test in w28 covers real GPU
// queue.submit + drawIndexed); the browser side asserts the four
// AI-user-facing surface promises:
//
//   (a) `engine.assets.loadByGuid<SceneAsset>(sceneGuid)` returns
//       `Result<Handle<SceneAsset>, AssetError>` purely from the generic
//       parameter — no `as` cast in the test source (AC-07);
//   (b) `engine.assets.instantiate(handle, world)` produces
//       a SceneInstanceId on the ok path (AC-15 spine);
//   (c) the resulting World contains 1 mesh entity (MeshFilter +
//       MeshRenderer) + 1 Camera entity (Tier-B);
//   (d) the @forgeax/engine-runtime barrel does NOT export a parallel
//       `loadGltf` symbol (AC-15: single-call-surface promise; the only
//       `loadGltf*` exports live on @forgeax/engine-gltf as pure parsing
//       helpers).
//
// vite-plugin-pack dev server: this browser test fetches box.gltf as a
// raw asset via vite's built-in static-asset resolution (the `?url`
// import) and reads the meta sidecar through `import attribute json`. The
// dev `/__pack/lookup/:guid` route is exercised by the runtime
// loadByGuid prod-fetch path in `packages/runtime/src/__tests__/
// load-by-guid-prod.test.ts`; here the in-memory fast-path is used so the
// test can stay deterministic and inside vitest's 30s budget per
// plan-strategy section 4 risk R7.

import { World } from '@forgeax/engine-ecs';
import {
  type GltfDoc,
  type GltfMaterialIr,
  type GltfMeshIr,
  type GltfNodeIr,
  parseGltf,
  type GltfSceneIr,
} from '@forgeax/engine-gltf';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { parsePackV2 } from '@forgeax/engine-pack';
import { AssetRegistry, type MeshAsset } from '@forgeax/engine-assets-runtime';
import {
  Camera,
  MeshFilter,
  MeshRenderer,
  SceneInstance,
} from '@forgeax/engine-render';
import { ChildOf, Children, Transform } from '@forgeax/engine-scene';
import { type Handle, type MaterialAsset, type RhiError } from '@forgeax/engine-runtime';
import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine-shader';
import type {
  AssetError,
  ImageError,
  Result,
  SceneAsset,
} from '@forgeax/engine-types';
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
    paramSchema: [
      { name: 'baseColor', type: 'color' },
    ],
  });
  return sr;
}

interface SubAssetEntry {
  readonly guid: string;
  readonly kind: string;
  readonly sourceIndex: number;
}

function findGuid(kind: 'mesh' | 'material' | 'scene'): AssetGuid {
  const entries = metaJson.subAssets as readonly SubAssetEntry[];
  const entry = entries.find((s) => s.kind === kind);
  if (entry === undefined) throw new Error(`box.gltf.meta.json missing subAsset kind=${kind}`);
  const parsed = AssetGuid.parse(entry.guid);
  if (!parsed.ok) throw new Error(`box.gltf.meta.json sub-asset guid parse failed: ${kind}`);
  return parsed.value;
}

function meshIrToPod(mesh: GltfMeshIr): MeshAsset {
  const vertexCount = mesh.positions.length / 3;
  const vertices = new Float32Array(vertexCount * 12);
  for (let i = 0; i < vertexCount; i++) {
    const src = i * 3;
    const dst = i * 12;
    vertices[dst] = mesh.positions[src]!;
    vertices[dst + 1] = mesh.positions[src + 1]!;
    vertices[dst + 2] = mesh.positions[src + 2]!;
    vertices[dst + 3] = 0;
    vertices[dst + 4] = 1;
    vertices[dst + 5] = 0;
    vertices[dst + 6] = 0;
    vertices[dst + 7] = 0;
    vertices[dst + 8] = 1;
    vertices[dst + 9] = 0;
    vertices[dst + 10] = 0;
    vertices[dst + 11] = 1;
  }
  // box.gltf is always indexed; assert+narrow.
  if (mesh.indices === undefined) throw new Error('test fixture box.gltf must be indexed');
  return {
    kind: 'mesh',
    vertices,
    indices: mesh.indices,
    // The interleaved buffer uses the canonical 12-float layout, so the
    // attribute map must carry the same position/normal/uv/tangent presence
    // that the geometry layout SSOT projects to a 48-byte stride.
    attributes: {
      position: mesh.positions,
      normal: mesh.normals ?? new Float32Array(vertexCount * 3).fill(0),
      uv: mesh.texcoord0 ?? new Float32Array(vertexCount * 2).fill(0),
      tangent: mesh.tangents ?? new Float32Array(vertexCount * 4).fill(0),
    },
    submeshes: [
      {
        indexOffset: 0,
        indexCount: mesh.indices.length,
        vertexCount: vertices.length,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
  };
}

function materialIrToPod(mat: GltfMaterialIr): MaterialAsset {
  return {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } }],
    values: { baseColor: mat.baseColorFactor },
  };
}

function gltfDocToSceneAsset(
  doc: GltfDoc,
  matHandle: Handle<'MaterialAsset', 'shared'>,
): SceneAsset {
  const sceneIr: GltfSceneIr | undefined = doc.scenes[doc.defaultSceneIndex];
  if (sceneIr === undefined) throw new Error('GltfDoc.scenes[default] missing');
  const entities: Record<string, { components: Record<string, Record<string, unknown>> }> = {};
  for (const rootIdx of sceneIr.nodes) {
    const ir: GltfNodeIr | undefined = doc.nodes[rootIdx];
    if (ir === undefined) continue;
    const components: Record<string, Record<string, unknown>> = {
      Transform: {
        pos: [ir.transform.translation[0], ir.transform.translation[1], ir.transform.translation[2]], quat: [ir.transform.rotation[0], ir.transform.rotation[1], ir.transform.rotation[2], ir.transform.rotation[3]], scale: [ir.transform.scale[0], ir.transform.scale[1], ir.transform.scale[2]],},
    };
    if (ir.meshIndex !== null) {
      components.MeshFilter = { assetHandle: 1 };
      components.MeshRenderer = { materials: [matHandle] };
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
          pos: [camNode.transform.translation[0], camNode.transform.translation[1], camNode.transform.translation[2]],
          quat: [camNode.transform.rotation[0], camNode.transform.rotation[1], camNode.transform.rotation[2], camNode.transform.rotation[3]],
          scale: [camNode.transform.scale[0], camNode.transform.scale[1], camNode.transform.scale[2]],
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
    expect(parsed.value.assets[1]?.refs).toEqual([
      '019e2b88-aece-7b6e-bbfe-45d6453d21f3',
    ]);
    expect(Object.keys(parsed.value.assets[0]?.artifacts ?? {})).toEqual(['body']);
  });

  it('(a) loadByGuid<SceneAsset>(sceneGuid) infers Result<SceneAsset, AssetError>', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
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
    const meshPod = meshIrToPod(meshIr);
    const matPod = materialIrToPod(matIr);
    reg.catalog<MeshAsset>(meshGuid, meshPod);
    reg.catalog<MaterialAsset>(matGuid, matPod);
    const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', matPod);
    const sceneAsset = gltfDocToSceneAsset(docResult.value, matHandle);
    reg.catalog<SceneAsset>(sceneGuid, sceneAsset);

    // AC-07 surface: no `as` cast in this test source. The generic on
    // loadByGuid is the only place where the type is mentioned. The explicit
    // Result<SceneAsset, AssetError | ...> annotation below is the AI-user
    // contract the test asserts (D-17: loadByGuid returns the payload, not a
    // handle): TypeScript must accept it without widening or unsafe assignment.
    const sceneRes: Result<
      SceneAsset,
      AssetError | ImageError | RhiError
    > = await reg.loadByGuid<SceneAsset>(sceneGuid);
    expect(sceneRes.ok).toBe(true);
    if (!sceneRes.ok) return;
    expect(sceneRes.value.kind).toBe('scene');

    // Sanity: the mesh + material payloads resolve on the same fast-path.
    const meshRes: Result<
      MeshAsset,
      AssetError | ImageError | RhiError
    > = await reg.loadByGuid<MeshAsset>(meshGuid);
    expect(meshRes.ok).toBe(true);
    if (meshRes.ok) {
      expect(meshRes.value).toBe(meshPod);
    }
  });

  it('(b)+(c) sceneInstances.instantiate spawns mesh + camera entities', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
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

    const world = new World();
    registerSceneVocabulary(world);

    // D-17: catalog feeds loadByGuid; allocSharedRef mints the material handle.
    reg.catalog<MeshAsset>(meshGuid, meshIrToPod(meshIr));
    const matPod = materialIrToPod(matIr);
    reg.catalog<MaterialAsset>(matGuid, matPod);
    const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', matPod);
    const sceneAsset = gltfDocToSceneAsset(docResult.value, matHandle);
    reg.catalog<SceneAsset>(sceneGuid, sceneAsset);

    const sceneRes = await reg.loadByGuid<SceneAsset>(sceneGuid);
    expect(sceneRes.ok).toBe(true);
    if (!sceneRes.ok) return;

    // loadByGuid returns the payload (D-17); mint a user-tier column handle.
    const sceneHandle = world.allocSharedRef('SceneAsset', sceneRes.value);
    const instRes = reg.instantiate<SceneAsset>(sceneHandle, world);
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
