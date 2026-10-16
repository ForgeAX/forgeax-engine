import { AssetGuid } from '@forgeax/engine-pack/guid';
import { copyPackData, packArrayStorage } from '@forgeax/engine-pack/runtime';
import { validateTerrain } from '@forgeax/engine-terrain';
import {
  type Asset,
  AssetError,
  type AssetRef,
  err,
  type MaterialAsset,
  materialChildForbiddenFields,
  ok,
  type Result,
} from '@forgeax/engine-types';
import { withMeshAabb } from './aabb.js';
import {
  inferAtlasExtent,
  validateMeshPayload,
  validateTilesetPayload,
} from './payload-validate.js';
import { validateMaterialPasses, validateSpriteSlices } from './registry/validate-material.js';

export function assertPrivateMeshStorage(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    packArrayStorage(value); // Uses intrinsic getters and rejects shared backing storage.
    return;
  }
  if (value instanceof ArrayBuffer) return;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    throw new TypeError('prepared Mesh requires plain data and private binary storage');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value'))
      throw new TypeError('prepared Mesh requires data properties');
    assertPrivateMeshStorage(descriptor.value, seen);
  }
}

/** Copy private domain data before exposing it to a mutable consumer. */
export function copyPreparedAsset(asset: Asset): Asset {
  if (asset.kind === 'mesh') {
    try {
      // Native Mesh buffers can be copied without structured-clone serialization.
      return copyPackData(asset) as Asset;
    } catch (cause) {
      // Loader output is wider than Pack input (ArrayBuffer, undefined, -0).
      // Preserve that domain contract without relaxing untrusted input capture.
      if (!(cause instanceof TypeError)) throw cause;
      // structuredClone preserves SharedArrayBuffer aliases, so it alone cannot isolate bytes.
      assertPrivateMeshStorage(asset);
    }
  }
  return structuredClone(asset);
}

/** Domain preparation has no Catalog, World or GPU side effects. */
export function prepareAssetPayload(asset: Asset): Result<Asset, AssetError> {
  let prepared = asset;
  if (asset.kind === 'terrain') {
    const valid = validateTerrain(asset);
    if (!valid.ok)
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: valid.error.expected,
          hint: valid.error.hint,
        }),
      );
  }
  if (asset.kind === 'material' && 'parentGuid' in asset && typeof asset.parentGuid === 'string') {
    const parentGuid = String(asset.parentGuid);
    const parent = AssetGuid.parse(parentGuid);
    if (!parent.ok)
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: 'a valid material parent GUID',
          hint: `parent GUID '${parentGuid}' is not a valid UUID format`,
        }),
      );
    const child = { ...asset, parent: parent.value };
    const forbidden = materialChildForbiddenFields(child as unknown as MaterialAsset);
    if (forbidden.length)
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: 'parent-bearing material to contain only parent and values',
          hint: 'remove root-owned colorSpace, passes, and parameters from the child payload',
          detail: { field: 'material-child-contract', got: forbidden },
        }),
      );
    prepared = {
      kind: 'material',
      parent: parent.value,
      ...(asset.values === undefined ? {} : { values: asset.values }),
    };
  }
  const meshError = validateMeshPayload(prepared);
  if (meshError) return err(meshError);
  if (prepared.kind === 'tileset') {
    const error = validateTilesetPayload(prepared, inferAtlasExtent(prepared));
    if (error) return err(error);
  }
  if (prepared.kind === 'material') {
    const error = validateMaterialPasses(prepared) ?? validateSpriteSlices(prepared);
    if (error) return err(error);
  }
  return ok(prepared.kind === 'mesh' ? withMeshAabb(prepared) : prepared);
}

/** Validate typed domain edges against the same fixed reference closure for both input forms. */
export function validateAssetReferences(
  asset: Asset,
  guid: string,
  refs: readonly AssetRef[],
  kind: (guid: string) => string | undefined,
): AssetError | undefined {
  const direct = new Set(refs.map((ref) => ref.guid.toLowerCase()));
  if (asset.kind === 'material' && asset.parent !== undefined) {
    const parent = AssetGuid.format(asset.parent).toLowerCase();
    if (!direct.has(parent) || kind(parent) !== 'material')
      return new AssetError({
        code: 'asset-parse-failed',
        expected: `parent GUID ${parent} to reference a MaterialAsset`,
        hint: `loading parent material ${parent} for child ${guid}: repair the material reference`,
      });
  }
  if (asset.kind !== 'mesh') return undefined;
  for (const [slotIndex, slot] of asset.materialSlots.entries()) {
    if (slot.defaultMaterial === undefined) continue;
    const defaultMaterialGuid = AssetGuid.format(slot.defaultMaterial).toLowerCase();
    const actualKind = direct.has(defaultMaterialGuid)
      ? (kind(defaultMaterialGuid) ?? 'missing')
      : 'missing-ref-edge';
    if (actualKind === 'material') continue;
    return new AssetError({
      code: 'asset-parse-failed',
      expected: `mesh ${guid} materialSlots[${slotIndex}] (${slot.slotName}) default ${defaultMaterialGuid} to reference a MaterialAsset`,
      hint: `recook mesh ${guid}; slot ${slotIndex} '${slot.slotName}' resolves to ${actualKind}, not 'material'`,
      detail: {
        meshAssetGuid: guid,
        slotIndex,
        slotName: slot.slotName,
        defaultMaterialGuid,
        actualKind,
      },
    });
  }
  for (const lod of asset.lods ?? []) {
    const target = AssetGuid.format(lod.mesh).toLowerCase();
    if (!direct.has(target) || kind(target) !== 'mesh')
      return new AssetError({
        code: 'asset-parse-failed',
        expected: 'each LOD to reference a MeshAsset in the declared closure',
        hint: `repair LOD ${target} of mesh ${guid}`,
      });
  }
  return undefined;
}
