import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { validateMaterialTemplatePublication } from '@forgeax/engine-pack/material-cook';
import { type MaterialAsset, ok } from '@forgeax/engine-types';
import { runtimeAssetReference } from '../../internal';
import { runtimeAssets } from '../../internal/runtime-assets';
import type { MaterialReady } from '../../material/loader';
import { prepareRuntimeAssetPublication, publishRuntimeAssets } from './runtime-publication';

/** Use the same source artifact and verified Catalog route as a Scriptable Pack. */
export async function prepareRuntimeMaterialTemplate(guid: string, source: MaterialAsset) {
  return prepareRuntimeMaterialTemplates([{ guid, source }]);
}

export async function prepareRuntimeMaterialTemplates(
  inputs: readonly { guid: string; source: MaterialAsset }[],
) {
  const { createMaterialPackCooker } = await import(
    '../../../../shader-compiler/src/material/pack-cooker'
  );
  const cooker = createMaterialPackCooker();
  const blobs: Record<string, Uint8Array> = {};
  const entries = await Promise.all(
    inputs.map(async ({ guid, source }) => {
      const draft = await cooker.cook({ guid, source, publication: 'templates' });
      const { template: input } = draft.payload as { template: unknown };
      const template = validateMaterialTemplatePublication(input).unwrap();
      const { path, digest } = template.sourceArtifact;
      const artifact = draft.artifacts[path];
      if (artifact === undefined) throw new Error('Material source template artifact unavailable');
      blobs[path] = artifact.bytes;
      return {
        guid,
        asset: draft.payload as MaterialAsset,
        refs: draft.refs,
        artifacts: {
          [path]: {
            path,
            mediaType: artifact.mediaType,
            contentEncoding: 'identity' as const,
            byteLength: artifact.bytes.byteLength,
            integrity: { algorithm: 'sha256' as const, digest },
          },
        },
      };
    }),
  );
  return prepareRuntimeAssetPublication(entries, blobs);
}

/** Admit the same cooked record through the ordinary source, decoder and runtime owner. */
export async function loadMaterialFixture(
  owner: AssetRegistry,
  record: MaterialReady['record'],
  dependencies: Parameters<typeof publishRuntimeAssets>[1] = [],
) {
  const previous = runtimeAssetReference(owner, record.guid);
  publishRuntimeAssets(owner, [
    ...dependencies,
    {
      guid: record.guid,
      refs: [
        ...record.refs.parent,
        ...record.refs.textures,
        ...record.refs.samplers,
        ...record.refs.modules,
      ].filter((reference) => AssetGuid.parse(reference).ok),
      asset: {
        kind: 'material',
        ...record.resolved,
        passes: record.resolved.passes as import('@forgeax/engine-types').MaterialPassList,
        // The publication fixture owns JSON encoding; retain byte views for its digest.
        cooked: record,
      } as MaterialAsset,
    },
  ]);
  if (previous !== undefined) {
    const reloaded = await owner.reload(previous, { conflict: 'overwrite' });
    if (!reloaded.ok) return reloaded;
  }
  const loaded = await owner.load(record.guid, 'material');
  if (!loaded.ok) return loaded;
  const payload = runtimeAssets(owner).borrow<MaterialAsset>(loaded.value).unwrap();
  return ok({
    handle: loaded.value,
    payload,
    projection: owner.getMaterialProjectionForPayload(payload),
  });
}
