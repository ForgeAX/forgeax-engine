import type { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { GlyphText } from '@forgeax/engine-render/authoring';
import type { AssetHandle } from '@forgeax/engine-types';

// Font source identity; its Pack closure includes atlas and sampler.
export const FONT_GUID = '019eb276-4d96-7f2c-9ecf-5124a020eebb';
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
  fontHandle: AssetHandle<'font'>,
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
