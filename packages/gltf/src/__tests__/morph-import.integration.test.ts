import { readFile } from 'node:fs/promises';
import { AnimationTargetId, animationClipContribution } from '@forgeax/engine-animation';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { ImporterRegistry, type RunImportMeta, runImport } from '@forgeax/engine-import';
import { MeshFilter, MeshRenderer, materialContribution } from '@forgeax/engine-render';
import {
  ChildOf,
  MorphWeights,
  Name,
  sceneAssetContribution,
  Transform,
} from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import {
  importedMesh,
  importedSource,
} from '../../../import/src/__tests__/fixtures/runtime-import';
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
  it('preserves two targets and two animation keyframes through source loading', async () => {
    const pack = await importFixture();
    const meshEntry = pack.assets.find((asset) => asset.guid === MESH_GUID);
    const sceneEntry = pack.assets.find((asset) => asset.guid === SCENE_GUID);
    const animationEntry = pack.assets.find((asset) => asset.guid === ANIMATION_GUID);
    expect(meshEntry?.kind).toBe('mesh');
    expect(sceneEntry?.kind).toBe('scene');
    expect(animationEntry?.kind).toBe('animation-clip');

    if (!meshEntry) throw new Error('missing mesh');
    expect(meshEntry.payload).toEqual({ kind: 'mesh' });
    const meshPayload = importedMesh(meshEntry);
    expect(meshPayload.morphTargets).toHaveLength(2);
    expect(meshPayload.morphTargets?.every((target) => target.position?.length === 24 * 3)).toBe(
      true,
    );
    expect(meshPayload.morphTargets?.[0]?.position?.some((value) => value !== 0)).toBe(true);
    expect(meshPayload.morphTargets?.[1]?.position?.some((value) => value !== 0)).toBe(true);
    expect(Array.from(meshPayload.morphWeights ?? [])).toEqual([0, 0]);

    const animationPayload = animationEntry?.payload as {
      readonly channels: readonly {
        readonly property: string;
        readonly sampler: { readonly input: unknown; readonly output: unknown };
      }[];
    };
    expect(animationPayload.channels).toHaveLength(1);
    expect(animationPayload.channels[0]?.property).toBe('weights');
    // Keyframes live in the samples artifact; the payload keeps element windows.
    expect(animationPayload.channels[0]?.sampler.input).toEqual({ offset: 0, count: 2 });
    expect(animationPayload.channels[0]?.sampler.output).toEqual({ offset: 2, count: 4 });
    expect(animationEntry?.artifacts).toHaveProperty('animation-clip/samples.bin');

    const runtime = new AssetRegistry({ scopeId: 'import-fixture' });
    const world = new World({ assets: runtime });
    for (const token of [
      Transform,
      Name,
      ChildOf,
      MeshFilter,
      MeshRenderer,
      MorphWeights,
      AnimationTargetId,
    ])
      world.components.register(token).unwrap();
    runtime.installDecoder(sceneAssetContribution.kind, sceneAssetContribution.decoder);
    runtime.installDecoder(animationClipContribution.kind, animationClipContribution.decoder);
    runtime.installDecoder(materialContribution.kind, materialContribution.decoder);
    importedSource(pack, runtime);
    const loadedMesh = runtime.read((await runtime.load(MESH_GUID, 'mesh')).unwrap()).unwrap();
    const loadedScene = runtime.read((await runtime.load(SCENE_GUID, 'scene')).unwrap()).unwrap();
    const loadedAnimation = runtime
      .read((await runtime.load(ANIMATION_GUID, 'animation-clip')).unwrap())
      .unwrap();
    expect(Array.from(loadedMesh.morphWeights ?? [])).toEqual([0, 0]);
    const sceneEntity = Object.values(loadedScene.entities)[0];
    expect(sceneEntity?.components.MorphWeights?.weights).toEqual([0, 0]);
    expect(loadedAnimation.channels[0]?.property).toBe('weights');
    const channel = loadedAnimation.channels[0];
    if (channel?.property !== 'weights') throw new Error('fixture requires a morph channel');
    expect(Array.from(channel.sampler.output)).toEqual([0, 0.75, 0.25, 0]);
    runtime.dispose();
  });
});
