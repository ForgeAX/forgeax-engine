import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { type MaterialAsset, ok } from '@forgeax/engine-types';
import { runtimeAssetReference } from '../../internal';
import { runtimeAssets } from '../../internal/runtime-assets';
import type { MaterialReady } from '../../material/loader';
import { publishRuntimeAssets } from './runtime-publication';

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
