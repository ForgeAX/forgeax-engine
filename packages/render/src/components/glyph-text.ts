// @forgeax/engine-runtime - GlyphText component (feat-20260531-world-space-msdf-text-rendering M4 / w14).
//
// `GlyphText` is the authoring source component for world-space MSDF text
// (requirements AC-06 / §domain model). It carries ONLY authoring data; the
// glyph quad baking + MeshFilter / MeshRenderer attachment is the job of the
// `glyphTextLayoutSystem` (plan-strategy D-2: GlyphText is pure authoring
// data, baking is a system responsibility). There is NO `TextLayoutAsset`
// intermediate (OOS-5) -- layout output lives directly in a baked MeshAsset.
//
// Naming: single-semantic component drops the `Component` suffix
// (AGENTS.md §Component naming rule #1 -- Transform / Camera / GlyphText).
//
// Schema vocab:
//   - `fontHandle: 'shared<FontAsset>'` -> `Handle<'FontAsset', 'shared'>`
//     (u32-stored; AssetRegistry owns the FontAsset lifecycle). AI users
//     obtain the handle via `assets.loadByGuid<FontAsset>(guid)`.
//   - `text: 'string'` -> native JS string (UniqueRefStore-backed, same
//     dispatch as `Name.value`).
//   - `fontSize: 'f32'` -> layout scale applied to the FontAsset metrics.
//   - `color: 'array<f32, 4>'` -> linear-space rgba tint (feat-20260709 M3:
//     collapsed from four `colorR/G/B/A` scalar columns into one inline
//     stride-4 SoA column, mirroring the DirectionalLight direction/color
//     idiom). Explicit layer-2 default [1,1,1,1] (opaque white).
//
// charter mapping: P1 (single import surface from `@forgeax/engine-render`,
// co-located with `glyphTextLayoutSystem` that consumes it) + P3
// (machine-readable schema literal) + P5 (consistent abstraction: same
// `'shared<T>'` idiom as MeshFilter.assetHandle / MeshRenderer.materials).

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Glyph text authoring component (world-space MSDF text).
 *
 * Spawn an entity with a `GlyphText` and the `glyphTextLayoutSystem`
 * (auto-wired by `createRenderer` / `createApp`) lays out the glyph quads,
 * bakes a `MeshAsset`, and attaches `MeshFilter` + `MeshRenderer` on the
 * next frame (Commands-deferred). Mutating `text` / `fontSize` / `color`
 * re-bakes the mesh in place (plan-strategy D-1 updateMesh; registry size
 * unchanged, AC-08).
 *
 * @example Spawn a world-space label:
 *   import { GlyphText } from '@forgeax/engine-render/authoring';
 *   const font = (await assets.loadByGuid(fontGuid)).unwrap();
 *   world.spawn({
 *     component: GlyphText,
 *     data: { fontHandle: font, text: 'Hello', fontSize: 32,
 *             color: [1, 1, 1, 1] },
 *   });
 */
export const GlyphText = defineComponent('GlyphText', {
  // The layout/render owner re-resolves the font asset on the target world;
  // authoring text and style remain portable simulation state.
  fontHandle: {
    type: 'shared<FontAsset>',
    default: 0 as never,
    simulationTransient: true,
  },
  text: { type: 'string', default: '' },
  fontSize: { type: 'f32', default: 16 },
  // color carries an explicit layer-2 default [1,1,1,1] (opaque white); the
  // array layer-3 fallback is all-zero, so the default MUST be explicit (D-5).
  color: { type: 'array<f32, 4>', default: new Float32Array([1, 1, 1, 1]) },
});
