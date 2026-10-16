import { gltfImporter, sourceKeyForGltfOutput } from '@forgeax/engine/gltf';
import { imageImporter } from '@forgeax/engine/image/image-importer';
import { ImporterRegistry, type ImportRunnerFs, runImport } from '@forgeax/engine/import';
import type { ImportContext } from '@forgeax/engine/types';
import { cubeGltf } from '../../features/asset-formats/fixtures/gltf-source';
import { errorCode, guid } from '../../features/asset-formats/fixtures/memory-pack';
import { defineFeature } from '../../lab/feature';
import type { ImportedPackAsset } from './fbx-importer';
import { CHECKER_PNG } from './support/image-import';

const SOURCE = 'box.gltf';

export const GLTF_SUB_ASSETS = (
  [
    ['mesh', 'Box', 0x401],
    ['material', 'Red', 0x402],
    ['texture', 'Checker', 0x403],
    ['sampler', undefined, 0x404],
    ['scene', 'Lab', 0x405],
  ] as const
).map(([kind, name, id]) => ({
  guid: guid(id),
  sourceIndex: 0,
  kind,
  sourceKey: sourceKeyForGltfOutput(name === undefined ? { kind } : { kind, name }) ?? kind,
}));

export function gltfFs(bytes: Uint8Array): ImportRunnerFs {
  return {
    readSource: async (path) =>
      path === SOURCE
        ? { ok: true, value: bytes }
        : { ok: false, error: new Error(`unexpected ${path}`) },
    decodeImage: imageImporter.capabilities?.decodeImage as ImportContext['decodeImage'],
  } as ImportRunnerFs;
}

export async function importGltf(
  json: Record<string, unknown>,
  subAssets: readonly {
    readonly guid: string;
    readonly sourceIndex: number;
    readonly kind: string;
    readonly sourceKey?: string;
  }[],
): Promise<
  | { readonly ok: true; readonly assets: readonly ImportedPackAsset[] }
  | { readonly ok: false; readonly code: string }
> {
  const registry = new ImporterRegistry();
  registry.register(gltfImporter);
  const result = await runImport(
    { importer: 'gltf', source: SOURCE, subAssets } as never,
    registry,
    gltfFs(new TextEncoder().encode(JSON.stringify(json))),
  );
  if (!result.ok) return { ok: false, code: errorCode(result.error) };
  const pack = (
    result.value as { readonly pack?: { readonly assets: readonly ImportedPackAsset[] } }
  ).pack;
  return { ok: true, assets: pack?.assets ?? [] };
}

const refGuids = (asset: ImportedPackAsset | undefined): readonly (string | undefined)[] =>
  (asset?.refs ?? []).map((ref) => (typeof ref === 'string' ? ref : ref.guid));

export default defineFeature({
  title: 'glTF importer',
  catalog: 'glTF importer',
  kind: 'headless',
  summary:
    'gltfImporter in the import runner turns an in-code textured cube .gltf into mesh, material, texture, sampler and scene Pack rows at the GUIDs declared by sourceKey-addressed subAssets.',
  expect:
    'Every declared GUID is produced with its kind; the mesh references the material, the material references the texture and sampler, the scene references the mesh, and the baseColor texture is sRGB 16x16.',
  async run(checks) {
    checks.equal(
      'sourceKey convention',
      sourceKeyForGltfOutput({ kind: 'mesh', name: 'Box' }),
      'mesh:Box',
    );
    const imported = await importGltf(cubeGltf({ png: CHECKER_PNG }).json, GLTF_SUB_ASSETS);
    checks.ok('runImport ok', imported.ok, imported.ok ? undefined : imported.code);
    if (!imported.ok) return;
    const byGuid = new Map(imported.assets.map((asset) => [asset.guid, asset]));
    checks.equal(
      'declared GUIDs and kinds',
      GLTF_SUB_ASSETS.map((sub) => byGuid.get(sub.guid)?.kind),
      GLTF_SUB_ASSETS.map((sub) => sub.kind),
    );
    checks.ok(
      'mesh -> material',
      refGuids(byGuid.get(guid(0x401))).includes(guid(0x402)),
      JSON.stringify(refGuids(byGuid.get(guid(0x401)))),
    );
    checks.equal('material -> texture + sampler', refGuids(byGuid.get(guid(0x402))), [
      guid(0x403),
      guid(0x404),
    ]);
    checks.ok(
      'scene -> mesh',
      refGuids(byGuid.get(guid(0x405))).includes(guid(0x401)),
      JSON.stringify(refGuids(byGuid.get(guid(0x405)))),
    );
    const texture = byGuid.get(guid(0x403))?.payload as
      | { readonly format?: string; readonly shape?: { readonly extent?: unknown } }
      | undefined;
    checks.equal('baseColor texture is sRGB', texture?.format, 'rgba8unorm-srgb');
    checks.equal('texture extent', texture?.shape?.extent, { width: 16, height: 16 });
  },
});
