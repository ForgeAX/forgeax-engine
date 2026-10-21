import {
  AssetError,
  type AssetHandle,
  type AssetReferenceOwner,
  err,
  type FontAsset,
  type GlyphMetric,
  materialGuidText,
  ok,
  type Result,
} from '@forgeax/engine-types';

function invalid(expected: string): Result<never, AssetError> {
  return err(
    new AssetError({
      code: 'asset-invalid-value',
      expected,
      hint: 'supply finite Font metrics and loaded atlas/sampler references from this asset owner',
    }),
  );
}

function validMetric(value: GlyphMetric): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    [value.advance, value.bearingX, value.bearingY].every(Number.isFinite) &&
    value.size !== null &&
    typeof value.size === 'object' &&
    value.region !== null &&
    typeof value.region === 'object' &&
    [
      value.size.w,
      value.size.h,
      value.region.x,
      value.region.y,
      value.region.w,
      value.region.h,
    ].every((item) => Number.isFinite(item) && item >= 0)
  );
}

/** Font edges join the same owner closure as Mesh and Material; no label is visited. */
export function linkRuntimeFont(
  font: FontAsset,
  owner: AssetReferenceOwner,
  source: (guid: string) => AssetHandle | undefined,
): Result<{ value: FontAsset; dependencies: readonly number[] }, AssetError> {
  const common = font.common;
  if (
    common === null ||
    typeof common !== 'object' ||
    ![
      common.lineHeight,
      common.base,
      common.distanceRange,
      common.pxRange,
      common.atlasWidth,
      common.atlasHeight,
    ].every(Number.isFinite) ||
    common.lineHeight < 0 ||
    common.distanceRange <= 0 ||
    common.pxRange <= 0 ||
    !Number.isInteger(common.atlasWidth) ||
    common.atlasWidth <= 0 ||
    !Number.isInteger(common.atlasHeight) ||
    common.atlasHeight <= 0
  )
    return invalid('finite Font common values and positive integer atlas dimensions');
  if (
    font.glyphs === null ||
    typeof font.glyphs !== 'object' ||
    Array.isArray(font.glyphs) ||
    Object.entries(font.glyphs).some(
      ([codepoint, value]) =>
        !/^\d+$/.test(codepoint) || Number(codepoint) > 0x10ffff || !validMetric(value),
    ) ||
    (font.notdef !== undefined && !validMetric(font.notdef))
  )
    return invalid('Unicode codepoint metrics with finite positions and non-negative dimensions');
  const reference = <K extends 'texture' | 'sampler'>(
    input: FontAsset['atlas'] | FontAsset['sampler'],
    kind: K,
  ): Result<AssetHandle<K>, AssetError> => {
    if (typeof input !== 'number' && !(input instanceof Uint8Array && input.length === 16))
      return invalid(`a loaded ${kind} reference or source GUID`);
    const handle = typeof input === 'number' ? input : source(materialGuidText(input));
    if (handle === undefined || !Number.isInteger(handle) || handle <= 0 || handle > 0xffff_ffff)
      return invalid(`a nonzero ${kind} reference in this asset owner`);
    const valid = owner.validate(handle, kind);
    return valid.ok ? ok(handle as AssetHandle<K>) : valid;
  };
  const atlas = reference(font.atlas, 'texture');
  if (!atlas.ok) return atlas;
  const sampler = reference(font.sampler, 'sampler');
  if (!sampler.ok) return sampler;
  return ok({
    value: { ...font, atlas: atlas.value, sampler: sampler.value },
    dependencies: [atlas.value, sampler.value],
  });
}
