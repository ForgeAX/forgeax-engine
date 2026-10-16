import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import type {
  ImportedAsset,
  ImportProduct,
  MaterialAsset,
  MaterialValue,
} from '@forgeax/engine-types';
import {
  ImportError,
  isMaterialTextureParameterType,
  MATERIAL_TEXTURE_SLOTS,
} from '@forgeax/engine-types';
import type { RunImportMeta } from './import-runner.js';
import { materialAssetOutputProducer } from './scriptable-pack-output-producers.js';

function failure(guid: string, reason: string): never {
  throw new ImportError({
    code: 'import-internal-error',
    expected: `the material cooker to publish a complete imported material ${guid}`,
    hint: 'repair the material source or registered cooker and rebuild the source package',
    detail: { reason },
  });
}

/** Importer values use refs indices; the shared material cooker consumes GUIDs. */
function materialSource(asset: ImportedAsset<unknown>): MaterialAsset {
  if (asset.payload === null || typeof asset.payload !== 'object')
    return failure(asset.guid, 'material payload is not an object');
  const source = asset.payload as MaterialAsset;
  if (source.kind !== 'material')
    return failure(asset.guid, 'material payload kind disagrees with its output');
  const reference = (value: unknown): string => {
    const guid =
      typeof value === 'number'
        ? Number.isInteger(value) && value >= 0
          ? asset.refs[value]?.guid
          : undefined
        : value instanceof Uint8Array && value.byteLength === 16
          ? AssetGuid.format(value as import('@forgeax/engine-types').AssetGuid)
          : value;
    if (typeof guid !== 'string' || !AssetGuid.parse(guid).ok)
      return failure(asset.guid, 'material reference does not resolve through its own refs');
    return guid;
  };
  const textures = new Set(
    source.parameters === undefined
      ? MATERIAL_TEXTURE_SLOTS
      : source.parameters.filter((p) => isMaterialTextureParameterType(p.type)).map((p) => p.name),
  );
  const value = (input: unknown, textureField: boolean): MaterialValue | null => {
    if (
      input !== null &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      'texture' in input
    ) {
      const binding = input as { texture: unknown; sampler?: unknown };
      return {
        ...binding,
        texture: reference(binding.texture),
        ...(binding.sampler === undefined ? {} : { sampler: reference(binding.sampler) }),
      } as MaterialValue;
    }
    if (textureField && input !== null && input !== undefined) return reference(input);
    return input as MaterialValue | null;
  };
  const parent =
    source.parent === undefined ? undefined : AssetGuid.parse(reference(source.parent));
  if (parent !== undefined && !parent.ok)
    return failure(asset.guid, 'invalid material parent GUID');
  return {
    ...source,
    kind: 'material',
    ...(parent === undefined ? {} : { parent: parent.value }),
    ...(source.values === undefined
      ? {}
      : {
          values: Object.fromEntries(
            Object.entries(source.values).map(([name, input]) => [
              name,
              value(input, textures.has(name)),
            ]),
          ),
        }),
    ...(source.parameters === undefined
      ? {}
      : {
          parameters: source.parameters.map((parameter) => {
            if (parameter.default === undefined || !isMaterialTextureParameterType(parameter.type))
              return parameter;
            return { ...parameter, default: value(parameter.default, true) };
          }) as NonNullable<MaterialAsset['parameters']>,
        }),
  } as MaterialAsset;
}

/** The source-package owner applies the same injected cooker used for authored Packs. */
export async function cookImportedMaterials(
  product: ImportProduct,
  meta: RunImportMeta,
  registry: Pick<NativeCookerRegistry, 'get' | 'runDraft'> | undefined,
): Promise<{ product: ImportProduct; fingerprints: readonly string[] }> {
  if (registry?.get('material') === undefined) return { product, fingerprints: [] };
  const materialAssets = product.assets.filter((asset) => asset.kind === 'material');
  const table = Object.fromEntries(
    materialAssets.map((asset) => [asset.guid, materialSource(asset)]),
  );
  const declarations = new Map(meta.subAssets.map((asset) => [asset.guid, asset]));
  const assets: ImportedAsset[] = [];
  const dependencies = new Set(product.sourceDependencies);
  const fingerprints: string[] = [];
  for (const asset of product.assets) {
    if (asset.kind !== 'material') {
      assets.push(asset);
      continue;
    }
    const source = table[asset.guid];
    if (source === undefined) return failure(asset.guid, 'missing material source');
    if ('cooked' in source) {
      const checked = validateCookedMaterialRecord(source.cooked);
      if (!checked.ok) return failure(asset.guid, 'invalid existing material cook record');
      if (checked.value.guid.toLowerCase() !== asset.guid.toLowerCase())
        return failure(asset.guid, 'existing material cook record belongs to another GUID');
      assets.push(asset);
      continue;
    }
    const sourceKey = declarations.get(asset.guid)?.sourceKey;
    if (sourceKey === undefined)
      return failure(asset.guid, 'declare the material sourceKey in Meta before cooking');
    const draft = await registry.runDraft('material', {
      guid: asset.guid,
      source,
      table,
      sourcePath: meta.source,
      sourceKey,
      refs: asset.refs.map((ref) => ref.guid),
    });
    if (!draft.ok) return failure(asset.guid, JSON.stringify(draft.error));
    if (draft.value.guid.toLowerCase() !== asset.guid.toLowerCase())
      return failure(asset.guid, 'material cooker changed its declared GUID');
    if (
      draft.value.payload === null ||
      typeof draft.value.payload !== 'object' ||
      !('kind' in draft.value.payload) ||
      draft.value.payload.kind !== 'material'
    )
      return failure(asset.guid, 'material cooker did not return a MaterialAsset');
    const record = validateCookedMaterialRecord(
      (draft.value.payload as { cooked?: unknown }).cooked,
    );
    if (!record.ok || record.value.guid.toLowerCase() !== asset.guid.toLowerCase())
      return failure(asset.guid, 'material cooker did not publish a valid record for this GUID');
    const projected = await materialAssetOutputProducer.produce({
      guid: asset.guid,
      sourceKey,
      asset: draft.value.payload as MaterialAsset,
    });
    if (!projected.ok) return failure(asset.guid, JSON.stringify(projected.error));
    const refs = [...projected.value.refs];
    const seen = new Set(refs.map((ref) => ref.guid.toLowerCase()));
    for (const ref of [...asset.refs, ...draft.value.refs.map((guid) => ({ guid }))]) {
      if (!AssetGuid.parse(ref.guid).ok)
        return failure(asset.guid, 'material cooker returned an invalid reference');
      if (!seen.has(ref.guid.toLowerCase())) {
        refs.push(ref);
        seen.add(ref.guid.toLowerCase());
      }
    }
    const artifacts = { ...asset.artifacts };
    for (const [path, artifact] of Object.entries(draft.value.artifacts)) {
      if (path in artifacts)
        return failure(asset.guid, `material cooker collided with importer artifact ${path}`);
      artifacts[path] = artifact;
    }
    assets.push({ ...asset, payload: projected.value.payload as MaterialAsset, refs, artifacts });
    for (const path of draft.value.sourceDependencies ?? []) dependencies.add(path);
    fingerprints.push(`${asset.guid}=${draft.value.inputFingerprint}`);
  }
  return {
    product: { ...product, assets, sourceDependencies: [...dependencies] },
    fingerprints: fingerprints.sort(),
  };
}
