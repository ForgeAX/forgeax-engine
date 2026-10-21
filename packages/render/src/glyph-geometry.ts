import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { buildGlyphMeshAsset, layoutGlyphText } from '@forgeax/engine-graphics-extras';
import { type FontAsset, type MeshAsset, TextError } from '@forgeax/engine-types';
import { GlyphText } from './components/glyph-text';

/** On-demand CPU query geometry from current Font metrics, shared with draw layout. */
export function glyphTextGeometry(world: World, entity: EntityHandle): MeshAsset | undefined {
  const glyph = world.get(entity, GlyphText);
  if (!glyph.ok || glyph.value.fontHandle === 0 || glyph.value.text.length === 0) return undefined;
  if (!Number.isFinite(glyph.value.fontSize) || glyph.value.fontSize <= 0)
    throw new TextError({
      code: 'glyph-layout-failed',
      expected: 'a positive finite fontSize',
      hint: 'repair the GlyphText size before querying',
    });
  const font = runtimeAssets(world.assets).resolveAsset<FontAsset>(glyph.value.fontHandle);
  if (!font.ok || font.value.kind !== 'font') return undefined;
  return buildGlyphMeshAsset(layoutGlyphText(font.value, glyph.value.text, glyph.value.fontSize));
}
