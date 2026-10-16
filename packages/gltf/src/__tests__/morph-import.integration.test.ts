import { readFile } from 'node:fs/promises';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { ImporterRegistry, type RunImportMeta, runImport } from '@forgeax/engine-import';
import type { AnimationClip, MeshAsset, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { gltfImporter } from '../gltf-importer.js';

const MESH_GUID = '11111111-1111-4111-8111-111111111111';
const MATERIAL_GUID = '22222222-2222-4222-8222-222222222222';
const SCENE_GUID = '33333333-3333-4333-8333-333333333333';
const ANIMATION_GUID = '44444444-4444-4444-8444-444444444444';

const sourceUrl = new URL(
  '../../../../apps/hello/format-tier1/fixtures/animated-morph-cube.gltf',
  import.meta.url,
);

function meta(): RunImportMeta {
  return {
    importer: 'gltf',
    source: 'apps/hello/format-tier1/fixtures/animated-morph-cube.gltf',
    subAssets: [
      { guid: MESH_GUID, sourceIndex: 0, sourceKey: 'gltf:mesh:Cube', kind: 'mesh' },
      {
        guid: MATERIAL_GUID,
        sourceIndex: 0,
        sourceKey: 'gltf:material:Material',
        kind: 'material',
      },
      { guid: SCENE_GUID, sourceIndex: 0, sourceKey: 'gltf:scene:default', kind: 'scene' },
      {
        guid: ANIMATION_GUID,
        sourceIndex: 0,
        sourceKey: 'gltf:animation:Square',
        kind: 'animation-clip',
      },
    ],
  };
}

async function importFixture() {
  const bytes = new Uint8Array(await readFile(sourceUrl));
  const registry = new ImporterRegistry();
  registry.register(gltfImporter);
  const fs = { readSource: async () => ({ ok: true as const, value: bytes }) };
  const result = await runImport(meta(), registry, fs);
  if (!result.ok) throw new Error(`glTF import failed: ${JSON.stringify(result.error)}`);
  if ('skipped' in result.value) throw new Error('expected glTF DDC pack');
  return result.value.pack;
}

describe('real glTF morph import through Pack and AssetRegistry', () => {
  it('preserves two targets and two animation keyframes through loadByGuid', async () => {
    const pack = await importFixture();
    const meshEntry = pack.assets.find((asset) => asset.guid === MESH_GUID);
    const sceneEntry = pack.assets.find((asset) => asset.guid === SCENE_GUID);
    const animationEntry = pack.assets.find((asset) => asset.guid === ANIMATION_GUID);
    expect(meshEntry?.kind).toBe('mesh');
    expect(sceneEntry?.kind).toBe('scene');
    expect(animationEntry?.kind).toBe('animation-clip');

    const meshPayload = meshEntry?.payload as {
      readonly vertices: number[];
      readonly morphTargets?: readonly { readonly position?: number[] }[];
      readonly morphWeights?: number[];
    };
    expect(meshPayload.morphTargets).toHaveLength(2);
    expect(meshPayload.morphTargets?.every((target) => target.position?.length === 24 * 3)).toBe(
      true,
    );
    expect(meshPayload.morphTargets?.[0]?.position?.some((value) => value !== 0)).toBe(true);
    expect(meshPayload.morphTargets?.[1]?.position?.some((value) => value !== 0)).toBe(true);
    expect(meshPayload.morphWeights).toEqual([0, 0]);

    const animationPayload = animationEntry?.payload as {
      readonly channels: readonly {
        readonly property: string;
        readonly sampler: { readonly input: readonly number[]; readonly output: readonly number[] };
      }[];
    };
    expect(animationPayload.channels).toHaveLength(1);
    expect(animationPayload.channels[0]?.property).toBe('weights');
    expect(animationPayload.channels[0]?.sampler.input).toEqual([0, 1]);
    expect(animationPayload.channels[0]?.sampler.output).toEqual([0, 0.75, 0.25, 0]);

    const runtime = new AssetRegistry({} as never);
    const parsedMesh = runtime.parseAssetPayload('mesh', meshEntry?.payload ?? {});
    const parsedAnimation = runtime.parseAssetPayload(
      'animation-clip',
      animationEntry?.payload ?? {},
    );
    expect(parsedMesh).toMatchObject({ kind: 'mesh', morphWeights: new Float32Array([0, 0]) });
    expect(parsedAnimation).toMatchObject({ kind: 'animation-clip' });
    expect(runtime.catalog(MESH_GUID, parsedMesh as never).ok).toBe(true);
    expect(runtime.catalog(SCENE_GUID, sceneEntry?.payload as never).ok).toBe(true);
    expect(runtime.catalog(ANIMATION_GUID, parsedAnimation as never).ok).toBe(true);

    const loadedMesh = await runtime.loadByGuid<MeshAsset>(runtime.parseGuid(MESH_GUID));
    const loadedScene = await runtime.loadByGuid<SceneAsset>(runtime.parseGuid(SCENE_GUID));
    const loadedAnimation = await runtime.loadByGuid<AnimationClip>(
      runtime.parseGuid(ANIMATION_GUID),
    );
    expect(loadedMesh.ok).toBe(true);
    expect(loadedScene.ok).toBe(true);
    expect(loadedAnimation.ok).toBe(true);
    if (!loadedMesh.ok || !loadedScene.ok || !loadedAnimation.ok) return;
    expect(Array.from(loadedMesh.value.morphWeights ?? [])).toEqual([0, 0]);
    const sceneEntity = Object.values(loadedScene.value.entities)[0];
    expect(sceneEntity?.components.MorphWeights?.weights).toEqual([0, 0]);
    expect(loadedAnimation.value.channels[0]?.property).toBe('weights');
    const channel = loadedAnimation.value.channels[0];
    if (channel?.property !== 'weights') throw new Error('fixture requires a morph channel');
    expect(Array.from(channel.sampler.output)).toEqual([0, 0.75, 0.25, 0]);
  });
});
