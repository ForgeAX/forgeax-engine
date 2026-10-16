// apps/hello/gltf-instancing - feat-20260518 M5 demo.
//
// Loads a Tier-B box mesh with EXT_mesh_gpu_instancing N=4 + per-node
// Name='InstancedBox'. Single SceneEntity carries MeshFilter + MeshRenderer
// + Instances + Name + Transform; the RenderSystem records one instanced
// drawcall (instanceCount === 4).
//
// 4-step recipe (mirrors apps/hello/gltf):
//   (1) configureRuntimeAssetCatalog(assets, runtimeBinding)
//   (2) loadByGuid<MeshAsset>(meshGuid)
//   (3) loadByGuid<MaterialAsset>(matGuid)
//   (4) loadByGuid<SceneAsset>(sceneGuid) + sceneInstances.instantiate

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { gltfDocToSceneAsset, type GltfMaterialIr, type GltfMeshIr, parseGltf } from '@forgeax/engine-gltf';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { type MaterialAsset, type MeshAsset, type SceneAsset } from '@forgeax/engine-types';
import { renderComponentsPlugin } from '@forgeax/engine-render';
import { scenePlugin } from '@forgeax/engine-scene';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import gltfUrl from '../assets/instanced-box.gltf?url';
import metaJson from '../assets/instanced-box.gltf.meta.json' with { type: 'json' };

type SubAssetEntry = { readonly guid: string; readonly kind: string; readonly sourceIndex: number };

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-gltf-instancing: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError)
    console.error('[gltf-instancing] no usable backend:', err);
  else console.error('[gltf-instancing] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const constructed = await constructRuntimeRendererHost(target, {}, {
    ...forgeaxBundlerAdapter(),
    importTransport: createRuntimeAssetImportTransport(runtimeBinding),
  });
  if (!constructed.ok) throw constructed.error;
  const { renderer, assets } = constructed.value;
  console.warn('[gltf-instancing] Standard pipeline active');

  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const world = new World();
  const worldContext = await createWorldContext(world, [
    renderComponentsPlugin(),
    scenePlugin(),
  ]);
  const worldAttachment1 = renderer.attach(world);
  if (!worldAttachment1.ok) throw worldAttachment1.error;
  const frameRequest = {
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  };

  const gltfRes = await fetch(gltfUrl);
  const gltfJson = (await gltfRes.json()) as unknown;
  const externalLoader = (uri: string): Promise<ArrayBuffer> => {
    throw new Error(`[gltf-instancing] unexpected externalLoader call for uri=${uri}`);
  };
  const docResult = await parseGltf(gltfJson, externalLoader, gltfUrl);
  if (!docResult.ok) {
    console.error('[gltf-instancing] parseGltf failed:', docResult.error);
    return;
  }

  const subAssets = metaJson.subAssets as readonly SubAssetEntry[];
  const meshGuid = parseSubAssetGuid(subAssets, 'mesh');
  const materialGuid = parseSubAssetGuid(subAssets, 'material');
  const sceneGuid = parseSubAssetGuid(subAssets, 'scene');
  if (meshGuid === null || materialGuid === null || sceneGuid === null) {
    console.error(
      '[gltf-instancing] meta sidecar is missing one of mesh / material / scene subAssets',
    );
    return;
  }

  const meshAsset = meshIrToPod(getOrThrow(docResult.value.meshes, 0, 'mesh[0]'));
  const materialAsset = materialIrToPod(getOrThrow(docResult.value.materials, 0, 'material[0]'));
  // catalog stores GUID->payload (so loadByGuid resolves); allocSharedRef
  // mints the user-tier column handle the bridge ctx needs.
  assets.catalog<MeshAsset>(meshGuid, meshAsset);
  assets.catalog<MaterialAsset>(materialGuid, materialAsset);
  const matHandle = world.allocSharedRef('MaterialAsset', materialAsset);
  // Bridge ctx: route the mesh slot to HANDLE_CUBE so the v1 engine's
  // pre-uploaded GPU buffers back the drawcall. The freshly catalogued
  // mesh stays in the registry for loadByGuid<MeshAsset> below
  // (charter P4 consistent abstraction; OOS-13 custom mesh GPU upload).
  const sceneAssetWithHandles = gltfDocToSceneAsset(docResult.value, {
    meshHandles: new Map([[0, HANDLE_CUBE]]),
    materialHandles: new Map([[0, matHandle]]),
  });
  assets.catalog<SceneAsset>(sceneGuid, sceneAssetWithHandles);

  const meshRes = await assets.loadByGuid<MeshAsset>(meshGuid);
  if (!meshRes.ok) {
    console.error('[gltf-instancing] loadByGuid<MeshAsset> failed:', meshRes.error);
    return;
  }

  const matRes = await assets.loadByGuid<MaterialAsset>(materialGuid);
  if (!matRes.ok) {
    console.error('[gltf-instancing] loadByGuid<MaterialAsset> failed:', matRes.error);
    return;
  }

  const sceneRes = await assets.loadByGuid<SceneAsset>(sceneGuid);
  if (!sceneRes.ok) {
    console.error('[gltf-instancing] loadByGuid<SceneAsset> failed:', sceneRes.error);
    return;
  }
  // loadByGuid returns the payload (D-17); mint a user-tier column handle.
  const sceneHandle = world.allocSharedRef('SceneAsset', sceneRes.value);
  const instRes = assets.instantiate<SceneAsset>(sceneHandle, world);
  if (!instRes.ok) {
    console.error(
      '[gltf-instancing] scene instantiate failed:',
      (instRes.error as { code: string }).code,
    );
    return;
  }

  const frame = (): void => {
    void worldContext;
    world.update().unwrap();
    const r = renderer.draw(frameRequest);
    if (!r.ok) console.error('[gltf-instancing] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function parseSubAssetGuid(
  subs: readonly SubAssetEntry[],
  kind: 'mesh' | 'material' | 'scene',
): AssetGuid | null {
  const entry = subs.find((s) => s.kind === kind);
  if (entry === undefined) return null;
  const parsed = AssetGuid.parse(entry.guid);
  if (!parsed.ok) {
    console.error(
      `[gltf-instancing] sub-asset guid parse failed for kind=${kind}:`,
      parsed.error,
    );
    return null;
  }
  return parsed.value;
}

function getOrThrow<T>(arr: readonly T[], idx: number, label: string): T {
  const v = arr[idx];
  if (v === undefined) throw new Error(`[gltf-instancing] missing ${label}`);
  return v;
}

function meshIrToPod(mesh: GltfMeshIr): MeshAsset {
  const vertexCount = mesh.positions.length / 3;
  const FLOATS_PER_VERTEX = 12;
  const interleaved = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
  for (let i = 0; i < vertexCount; i++) {
    const dst = i * FLOATS_PER_VERTEX;
    const p = i * 3;
    interleaved[dst + 0] = mesh.positions[p + 0] as number;
    interleaved[dst + 1] = mesh.positions[p + 1] as number;
    interleaved[dst + 2] = mesh.positions[p + 2] as number;
    if (mesh.normals !== undefined) {
      const n = i * 3;
      interleaved[dst + 3] = mesh.normals[n + 0] as number;
      interleaved[dst + 4] = mesh.normals[n + 1] as number;
      interleaved[dst + 5] = mesh.normals[n + 2] as number;
  } else {
      interleaved[dst + 3] = 0;
      interleaved[dst + 4] = 1;
      interleaved[dst + 5] = 0;
  }
    if (mesh.texcoord0 !== undefined) {
      const t = i * 2;
      interleaved[dst + 6] = mesh.texcoord0[t + 0] as number;
      interleaved[dst + 7] = mesh.texcoord0[t + 1] as number;
  } else {
      interleaved[dst + 6] = 0;
      interleaved[dst + 7] = 0;
  }
    if (mesh.tangents !== undefined) {
      const g = i * 4;
      interleaved[dst + 8] = mesh.tangents[g + 0] as number;
      interleaved[dst + 9] = mesh.tangents[g + 1] as number;
      interleaved[dst + 10] = mesh.tangents[g + 2] as number;
      interleaved[dst + 11] = mesh.tangents[g + 3] as number;
  } else {
      interleaved[dst + 8] = 1;
      interleaved[dst + 9] = 0;
      interleaved[dst + 10] = 0;
      interleaved[dst + 11] = 1;
  }
  }
  // f85ab046: GltfMeshIr.indices is optional per glTF spec §3.7.2.1.
  const submesh = {
    indexOffset: 0,
    indexCount: mesh.indices !== undefined ? mesh.indices.length : 0,
    vertexCount: interleaved.length,
    topology: 'triangle-list' as const,
    materialSlot: 0,
  };
  return {
    kind: 'mesh',
    vertices: interleaved,
    ...(mesh.indices !== undefined ? { indices: mesh.indices } : {}),
    attributes: {
      position: mesh.positions,
      normal: mesh.normals ?? new Float32Array(vertexCount * 3).fill(0),
      uv: mesh.texcoord0 ?? new Float32Array(vertexCount * 2).fill(0),
      tangent: mesh.tangents ?? new Float32Array(vertexCount * 4).fill(0),
    },
    submeshes: [submesh],
    materialSlots: [{ slotName: 'Default' }],
  };
}

function materialIrToPod(mat: GltfMaterialIr): MaterialAsset {
  return {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
    ],
    values: {
      baseColor: mat.baseColorFactor,
    },
  };
}
