import {
  deriveFbxSourceKeys,
  fbxImporter,
  initFbxWasm,
  sourceKeyForFbxOutput,
} from '@forgeax/engine/fbx';
import { ImporterRegistry, runImport } from '@forgeax/engine/import';
import { TRIANGLE_FBX_BYTES } from '../../features/asset-formats/fixtures/fbx-source';
import { errorCode, guid } from '../../features/asset-formats/fixtures/memory-pack';
import { defineFeature } from '../../lab/feature';

export const FBX_SUB_ASSETS = [
  { guid: guid(0x301), sourceIndex: 0, sourceKey: 'fbx:mesh:Tri', kind: 'mesh' },
  { guid: guid(0x302), sourceIndex: 0, sourceKey: 'fbx:material:Shiny', kind: 'material' },
  { guid: guid(0x303), sourceIndex: 1, sourceKey: 'fbx:material:Matte', kind: 'material' },
  { guid: guid(0x304), sourceIndex: 0, sourceKey: 'fbx:scene', kind: 'scene' },
] as const;

export interface ImportedPackAsset {
  readonly guid: string;
  readonly kind: string;
  readonly refs: readonly (string | { readonly guid?: string })[];
  readonly payload: Record<string, unknown>;
}

export async function importTriangleFbx(): Promise<
  | { readonly ok: true; readonly assets: readonly ImportedPackAsset[] }
  | { readonly ok: false; readonly code: string }
> {
  await initFbxWasm();
  const registry = new ImporterRegistry();
  registry.register(fbxImporter);
  const result = await runImport(
    { importer: 'fbx', source: 'lab.fbx', subAssets: FBX_SUB_ASSETS },
    registry,
    {
      readSource: async () => ({ ok: true, value: TRIANGLE_FBX_BYTES }),
    } as never,
  );
  if (!result.ok) return { ok: false, code: errorCode(result.error) };
  const pack = (
    result.value as { readonly pack?: { readonly assets: readonly ImportedPackAsset[] } }
  ).pack;
  return { ok: true, assets: pack?.assets ?? [] };
}

const refGuid = (ref: string | { readonly guid?: string }): string | undefined =>
  typeof ref === 'string' ? ref : ref.guid;

export default defineFeature({
  title: 'FBX importer',
  catalog: 'FBX importer',
  kind: 'headless',
  summary:
    'fbxImporter registered in the import runner turns the in-code triangle FBX into mesh, material and scene assets whose GUIDs come from sourceKey-addressed subAssets.',
  expect:
    'The Pack holds 1 mesh, 2 materials and 1 scene at the declared GUIDs, the mesh references the Shiny material, the scene references the mesh, and source keys follow fbx:<kind>:<name>.',
  async run(checks) {
    checks.equal(
      'sourceKey convention',
      sourceKeyForFbxOutput({ kind: 'mesh', name: 'Body' } as never),
      'fbx:mesh:Body',
    );
    checks.ok('deriveFbxSourceKeys is exported', typeof deriveFbxSourceKeys === 'function');
    const imported = await importTriangleFbx();
    checks.ok('runImport ok', imported.ok, imported.ok ? undefined : imported.code);
    if (!imported.ok) return;
    const byGuid = new Map(imported.assets.map((asset) => [asset.guid, asset]));
    checks.equal(
      'declared GUIDs and kinds',
      FBX_SUB_ASSETS.map((sub) => byGuid.get(sub.guid)?.kind),
      FBX_SUB_ASSETS.map((sub) => sub.kind),
    );
    const mesh = byGuid.get(guid(0x301));
    checks.ok(
      'mesh references the Shiny material',
      (mesh?.refs ?? []).map(refGuid).includes(guid(0x302)),
      JSON.stringify(mesh?.refs),
    );
    const scene = byGuid.get(guid(0x304));
    checks.ok(
      'scene references the mesh',
      (scene?.refs ?? []).map(refGuid).includes(guid(0x301)),
      JSON.stringify(scene?.refs),
    );
  },
});
