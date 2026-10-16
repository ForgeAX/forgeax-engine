/**
 * Type-only helper mirroring the `forgeax::sprite` shader's paramSchema
 * (sprite.material.json). Field set is 1:1 with paramSchema entries; field
 * order matches schema order so the std140 UBO layout (slot 0..3 = colorTint
 * / region / pivotAndSize / slicesAndMode) reads top-to-bottom.
 *
 * feat-20260625-refactor-sprite-as-transparent-mesh M3 / w11 (D-4, D-6,
 * F-3): paramSchema is now UBO-aligned (the 4 vec4 fields match the WGSL
 * Material struct field names 1:1 so the generic std140 UBO writer
 * `applyParamSnapshotToUbo` walks `derive(paramSchema).uboLayout.entries`
 * and writes each field at its declared offset, no sprite-specific path).
 *
 * AI-user discoverability: annotate a sprite material's `values`
 * literal as `SpriteParamValues` to get autocomplete on `slicesAndMode`,
 * `pivotAndSize`, etc. Without the annotation the literal binds to
 * `MaterialAsset.values: Record<string, unknown>` and field
 * autocomplete is unavailable.
 *
 * Required fields:
 * - `baseColorTexture`: AssetGuid string of a registered TextureAsset
 *   (renamed from the pre-w11 `texture` field for cross-material name
 *   consistency, D-4).
 *
 * Optional UBO fields (omit for identity defaults):
 * - `colorTint`: vec4 `[r, g, b, a]` — texture sample multiplier
 *   (rgb * colorTint.rgb, alpha * colorTint.a). Default `[1, 1, 1, 1]`.
 * - `region`: vec4 `[uMin, vMin, uW, vH]` — atlas sub-region. Default
 *   `[0, 0, 1, 1]`. Host pre-folds flipX / flipY into this vec4 (D-8):
 *   `flipX -> region.x += region.z; region.z = -region.z` (analog for Y).
 *   When composing with {@link SpriteRegionOverride}, the override
 *   replaces this asset-side region.
 * - `pivotAndSize`: vec4 `[pivotX, pivotY, sizeX, sizeY]` — `.xy` is the
 *   pivot (0..1 normalised); `.zw` is the DEAD SLOT post-w11 (D-6 unit-
 *   quad: world scale flows entirely through GlobalTransform.world, no longer
 *   double-applied via the UBO). Default `[0.5, 0.5, 1, 1]`.
 * - `slicesAndMode`: vec4 `[left, top, right, bottom-signed]` — 9-slice
 *   border widths in UV (0..1) on the source texture region. Sum of
 *   opposite borders must be < 1 (left+right < region width, top+bottom
 *   < region height); register-time validation surfaces structured
 *   `AssetError`. The `.w` carries the sliceMode sentinel: positive (or 0)
 *   = stretch (middle band stretches with the entity's scale, default);
 *   NEGATIVE = tile (middle band tiles via sampler `addressMode='repeat'`).
 *   Default `[0, 0, 0, 0]` (no 9-slice). Authoring tip: callers who want
 *   to keep the legacy `slices` + `sliceMode` split can compute
 *   `slicesAndMode = [l, t, r, mode===1 ? -b : b]` at the call site.
 *
 * Composes with {@link SpriteRegionOverride}: when both are present, the
 * `slicesAndMode` are interpreted relative to the per-entity `region`
 * override (AC-14), not the material's `values.region`.
 *
 * Sibling type, not a sibling asset kind: `MaterialAsset` is the only
 * material asset shape; using `SpriteParamValues` as an annotation does
 * not branch the closed `AssetUnion` (plan-strategy section D-1).
 */
export type SpriteParamValues = {
  baseColorTexture: string;
  colorTint?: readonly [number, number, number, number];
  region?: readonly [number, number, number, number];
  pivotAndSize?: readonly [number, number, number, number];
  slicesAndMode?: readonly [number, number, number, number];
};
