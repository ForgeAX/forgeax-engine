// Shared scene + sampler registration for the world-space MSDF text demo.
// Imported by both apps/hello/text/src/main.ts (vite dev / build) and
// apps/hello/text/scripts/smoke-dawn.mjs (dawn-node smoke) so the rendered
// output is identical across both code paths (lesson:
// smoke-script-duplicate-scene-must-stay-in-sync-with-main).
//
// The font asset itself ships pre-baked under forgeax-engine-assets/dejavu-fonts/
// (tweak-20260610-hello-text-real-msdf-bake D-3 strategy B): an MSDF atlas PNG
// (importer:'image') + a font.pack.json (internal-text-package) whose payload
// already contains atlasGuid / samplerGuid / glyphs / common — exactly what
// the runtime fontLoader expects. The demo only has to:
//   1. catalog<SamplerAsset>(SAMPLER_GUID, ...) so the font.pack.json
//      `samplerGuid` field resolves to a real Handle at fontLoader time.
//   2. await loadByGuid<FontAsset>(FONT_GUID), which fetches the .pack.json,
//      resolves atlas + sampler refs, and yields a Handle<FontAsset>.
//   3. spawn GlyphText entities; the auto-wired glyphTextLayoutSystem will
//      bake meshes + attach MeshFilter + MeshRenderer per frame.

import type { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { GlyphText } from '@forgeax/engine-render/authoring';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { Handle, SamplerAsset } from '@forgeax/engine-types';

// GUIDs minted UUIDv7 in M1 (forgeax-engine-assets/dejavu-fonts/.guids.txt).
// FONT_GUID + ATLAS_GUID live inside the baked sidecars; SAMPLER_GUID is the
// runtime-side identifier that demo + smoke must register before loadByGuid.
export const FONT_GUID = '019eb276-4d96-7f2c-9ecf-5124a020eebb';
export const SAMPLER_GUID = '019eb276-4d96-7313-b4f0-f5d55536acd2';

/** Pack-index URL served by the vite dev plugin and by the build's dist/. */

/**
 * Catalog the SamplerAsset that font.pack.json's `samplerGuid` field
 * references. Idempotent: re-cataloguing the same GUID overwrites with the
 * identical payload.
 */
export function registerSharedSampler(
  assets: AssetRegistry,
): void {
  const guidParsed = AssetGuid.parse(SAMPLER_GUID);
  if (!guidParsed.ok) {
    throw new Error(`[text] SAMPLER_GUID parse failed: ${guidParsed.error.code}`);
  }
  assets.catalog<SamplerAsset>(guidParsed.value, {
    kind: 'sampler',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'nearest',
  });
}

/**
 * The four world-space text scenes (data-driven so demo + smoke share one SSOT).
 * Each row maps to a requirements AC:
 *   (a) HUD label                  -- name-plate / damage-number style
 *   (b) multi-line text ('\n')     -- AC-21
 *   (c) HDR-bright text (rgb > 1)  -- AC-12 (feeds Bloom extraction)
 *   (d) depth-occluded text        -- AC-11 (sits behind the occluder cube)
 */
export const TEXT_SCENES: ReadonlyArray<{
  readonly pos: readonly [number, number, number];
  readonly text: string;
  readonly color: readonly [number, number, number, number];
}> = [
  { pos: [-3, 2.5, 0], text: 'PLAYER 1', color: [1, 1, 1, 1] },
  { pos: [-3, 0, 0], text: 'HP\nMANA', color: [0.6, 0.9, 1, 1] },
  { pos: [1, 2.5, 0], text: 'BLOOM', color: [3, 2.4, 1.2, 1] },
  { pos: [1.6, -1.0, 0], text: 'HIDDEN', color: [1, 0.8, 0.2, 1] },
];

/** Spawn the four world-space text scenes. Shared by demo + smoke. */
export function spawnTextScenes(
  world: World,
  fontHandle: Handle<'FontAsset', 'shared'>,
): void {
  for (const s of TEXT_SCENES) {
    world
      .spawn(
        { component: Transform, data: { pos: s.pos, quat: [0, 0, 0, 1] } },
        {
          component: GlyphText,
          data: {
            fontHandle,
            text: s.text,
            fontSize: 0.025,
            color: s.color,
          },
        },
      )
      .unwrap();
  }
}
