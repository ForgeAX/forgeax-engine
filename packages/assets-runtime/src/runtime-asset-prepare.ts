import { prepareRuntimeTexture } from '@forgeax/engine-image';
import {
  type Asset,
  AssetError,
  type AssetHandle,
  type AssetReferenceOwner,
  err,
  isMaterialTextureParameterType,
  type MaterialAsset,
  type MaterialError,
  type MaterialValue,
  materialGuidText,
  ok,
  type Result,
  resolveMaterialAsset,
  selectMaterialStaticContract,
} from '@forgeax/engine-types';
import { copyAssetData } from './internal/asset-data';
import { prepareAssetPayload } from './prepare-payload';

/** Source inheritance is resolved once, before content enters the runtime owner. */
export function prepareRuntimeAsset(
  input: Asset,
  source: (guid: string) => Asset | undefined,
): Result<Asset, AssetError | MaterialError> {
  const prepared = prepareAssetPayload(input);
  if (prepared.ok && prepared.value.kind === 'mesh') {
    const canonical = prepareMeshData(prepared.value, '<runtime-mesh>');
    if (!canonical.ok)
      return err(
        new AssetError({
          code: 'asset-invalid-value',
          expected: canonical.error.expected,
          hint: 'supply complete finite mesh channels and matching interleaved vertices',
        }),
      );
  }
  if (prepared.ok && prepared.value.kind === 'texture')
    return prepareRuntimeTexture(prepared.value);

  if (!prepared.ok || prepared.value.kind !== 'material') return prepared;
  const root = prepared.value;
  const table: Record<string, MaterialAsset> = { root };
  let current = root;
  while (current.parent !== undefined) {
    const key = materialGuidText(current.parent);
    if (Object.hasOwn(table, key)) break; // The material owner reports the concrete cycle.
    const parent = source(key);
    if (parent?.kind !== 'material') break; // Preserve the material owner's missing-parent error.
    table[key] = parent;
    current = parent;
  }
  const resolved = resolveMaterialAsset('root', table);
  if (!resolved.ok) return resolved;
  const selected = selectMaterialStaticContract(resolved.value.asset);
  const { parent: _parent, staticSwitches: _selectedDefaults, ...selectedContent } = selected;
  // The selected parameter contract contains derived default switches. Retain
  // only authored selections; defaults must not become new Cook requirements.
  const asset = {
    ...selectedContent,
    ...(resolved.value.asset.staticSwitches === undefined
      ? {}
      : { staticSwitches: resolved.value.asset.staticSwitches }),
  };
  return ok(
    copyAssetData({
      ...asset,
      values: {
        ...Object.fromEntries(
          (asset.parameters ?? []).flatMap((parameter) =>
            parameter.default === undefined ? [] : [[parameter.name, parameter.default]],
          ),
        ),
        ...asset.values,
      },
    }),
  );
}

/** Resolve authored texture references once; runtime material values contain owner identities. */
export function linkRuntimeMaterial(
  material: MaterialAsset,
  owner: AssetReferenceOwner,
  source: (guid: string) => AssetHandle | undefined,
  textureFields: ReadonlySet<string>,
): Result<
  { value: MaterialAsset; dependencies: readonly number[]; textures: ReadonlySet<string> },
  AssetError
> {
  const dependencies = new Set<number>();
  const fields = new Set(textureFields);
  for (const parameter of material.parameters ?? [])
    if (isMaterialTextureParameterType(parameter.type)) fields.add(parameter.name);
  const reference = <K extends 'texture' | 'video' | 'sampler'>(
    input: unknown,
    kinds: readonly K[],
  ): Result<AssetHandle<K>, AssetError> => {
    const kind = kinds.join(' or ');
    if (
      typeof input !== 'number' &&
      typeof input !== 'string' &&
      !(input instanceof Uint8Array && input.length === 16)
    )
      return err(
        new AssetError({
          code: 'asset-reference-invalid',
          expected: `a ${kind} reference or source GUID`,
          hint: 'pass a runtime reference returned by this asset owner',
        }),
      );
    const handle = typeof input === 'number' ? input : source(materialGuidText(input));
    if (handle === undefined || !Number.isInteger(handle) || handle < 0 || handle > 0xffff_ffff)
      return err(
        new AssetError({
          code: 'asset-reference-invalid',
          expected: `a loaded ${kind} in this asset owner`,
          hint: 'load the dependency or pass its runtime reference before committing the material',
        }),
      );
    const valid = owner.validate(handle, kinds[0]);
    if (!valid.ok && !kinds.slice(1).some((kind) => owner.validate(handle, kind).ok)) return valid;
    if (handle !== 0) dependencies.add(handle);
    return ok(handle as AssetHandle<K>);
  };
  const values: Record<string, MaterialValue | null> = { ...material.values };
  for (const [name, value] of Object.entries(values)) {
    if (value === null) continue;
    if (typeof value === 'object' && !Array.isArray(value) && 'source' in value) {
      fields.add(name);
      const token = value.source;
      if (
        'texture' in value ||
        token === null ||
        typeof token !== 'object' ||
        token.kind !== 'render-texture-source' ||
        typeof token.owner !== 'string' ||
        token.owner.length === 0 ||
        !Number.isSafeInteger(token.id) ||
        token.id <= 0 ||
        !['target', 'canvas', 'external'].includes(token.source) ||
        Object.keys(token).some((key) => !['kind', 'owner', 'id', 'source'].includes(key))
      )
        return err(
          new AssetError({
            code: 'asset-reference-invalid',
            expected: `a native texture source token for material parameter ${name}`,
            hint: 'pass { source } using a RenderTarget, CanvasTexture or imported texture source',
          }),
        );
      const sampler =
        value.sampler === undefined ? undefined : reference(value.sampler, ['sampler']);
      if (sampler !== undefined && !sampler.ok) return sampler;
      // Source lifetime and generation belong to its native owner. It is never
      // an asset handle, and copying its POD token does not clone a native object.
      values[name] = {
        ...value,
        source: token,
        ...(sampler === undefined ? {} : { sampler: sampler.value }),
      };
    } else if (typeof value === 'object' && !Array.isArray(value) && 'texture' in value) {
      fields.add(name);
      const texture = reference(value.texture, ['texture', 'video']);
      if (!texture.ok) return texture;
      const sampler =
        value.sampler === undefined ? undefined : reference(value.sampler, ['sampler']);
      if (sampler !== undefined && !sampler.ok) return sampler;
      values[name] = {
        ...value,
        texture: texture.value,
        ...(sampler === undefined ? {} : { sampler: sampler.value }),
      };
    } else if (fields.has(name) || typeof value === 'string') {
      fields.add(name);
      if (typeof value !== 'number' && typeof value !== 'string')
        return err(
          new AssetError({
            code: 'asset-invalid-value',
            expected: `a texture reference for material parameter ${name}`,
            hint: 'supply a runtime texture reference or a texture binding descriptor',
          }),
        );
      const texture = reference(value, ['texture', 'video']);
      if (!texture.ok) return texture;
      values[name] = texture.value;
    }
  }
  return ok({ value: { ...material, values }, dependencies: [...dependencies], textures: fields });
}

import { prepareMeshData } from '@forgeax/engine-geometry';
