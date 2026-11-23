import { checkMaterialProgramSetDigest, validateCookedMaterialRecord } from '@forgeax/engine-pack';
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
import { projectNativeMaterial } from './scriptable-pack-output-producers.js';

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
type MaterialDraftRegistry = Pick<NativeCookerRegistry, 'get' | 'runDraft'>;

// Material cooks are independent: start them together so a parallel cooker
// fills its workers, then admit each draft in asset order.
function startMaterialDrafts(
  materialAssets: readonly ImportedAsset[],
  table: Readonly<Record<string, MaterialAsset>>,
  declarations: ReadonlyMap<string, { readonly sourceKey?: string }>,
  meta: RunImportMeta,
  registry: MaterialDraftRegistry,
): Map<string, ReturnType<MaterialDraftRegistry['runDraft']>> {
  const drafts = new Map<string, ReturnType<MaterialDraftRegistry['runDraft']>>();
  for (const asset of materialAssets) {
    const source = table[asset.guid];
    const sourceKey = declarations.get(asset.guid)?.sourceKey;
    if (source === undefined || 'cooked' in source || sourceKey === undefined) continue;
    drafts.set(
      asset.guid,
      registry.runDraft('material', {
        guid: asset.guid,
        source,
        table,
        sourcePath: meta.source,
        sourceKey,
        refs: asset.refs.map((ref) => ref.guid),
      }),
    );
  }
  return drafts;
}

function checkExistingCook(guid: string, cooked: unknown): void {
  const checked = validateCookedMaterialRecord(cooked);
  if (!checked.ok || !checkMaterialProgramSetDigest(checked.value).ok)
    failure(guid, 'invalid existing material cook record');
  if (checked.value.guid.toLowerCase() !== guid.toLowerCase())
    failure(guid, 'existing material cook record belongs to another GUID');
}

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
  const drafts = startMaterialDrafts(materialAssets, table, declarations, meta, registry);
  for (const asset of product.assets) {
    if (asset.kind !== 'material') {
      assets.push(asset);
      continue;
    }
    const source = table[asset.guid];
    if (source === undefined) return failure(asset.guid, 'missing material source');
    if ('cooked' in source) {
      checkExistingCook(asset.guid, source.cooked);
      assets.push(asset);
      continue;
    }
    const sourceKey = declarations.get(asset.guid)?.sourceKey;
    if (sourceKey === undefined)
      return failure(asset.guid, 'declare the material sourceKey in Meta before cooking');
    const draft = await drafts.get(asset.guid);
    if (draft === undefined) return failure(asset.guid, 'material cook was not started');
    if (!draft.ok) return failure(asset.guid, JSON.stringify(draft.error));
    const projected = await projectNativeMaterial(asset.guid, sourceKey, draft.value, asset.refs);
    if (!projected.ok) return failure(asset.guid, JSON.stringify(projected.error));
    const cooked = (projected.value.payload as { cooked?: unknown }).cooked;
    const record = validateCookedMaterialRecord(cooked);
    if (!record.ok || record.value.guid.toLowerCase() !== asset.guid.toLowerCase())
      return failure(asset.guid, 'material cooker did not publish a valid record for this GUID');
    const artifacts = { ...asset.artifacts };
    for (const [path, artifact] of Object.entries(draft.value.artifacts)) {
      if (path in artifacts)
        return failure(asset.guid, `material cooker collided with importer artifact ${path}`);
      artifacts[path] = artifact;
    }
    assets.push({
      ...asset,
      payload: projected.value.payload as MaterialAsset,
      refs: projected.value.refs,
      artifacts,
    });
    for (const path of draft.value.sourceDependencies ?? []) dependencies.add(path);
    fingerprints.push(`${asset.guid}=${draft.value.inputFingerprint}`);
  }
  return {
    product: { ...product, assets, sourceDependencies: [...dependencies] },
    fingerprints: fingerprints.sort(),
  };
}
