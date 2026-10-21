import type { AssetHandle } from '@forgeax/engine-types';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, type World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { MeshFilter } from '@forgeax/engine-render';
import { GlyphText } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';

/** The legacy baked font remains the default compatibility/reference source. */
export const GAME_DEFAULT_FONT_GUID = '019eb276-4d96-7f2c-9ecf-5124a020eebb';
/** The same licensed TTF through the build-time font importer/plugin. */
export const GAME_DEFAULT_TTF_FONT_GUID = '57db8d79-bb62-4b2a-8400-67c9601870cd';
const WORLD_SCORE_FONT_SIZE = 0.024;
const WORLD_SCORE_TTF_FONT_SIZE = 0.030;
const WORLD_SCORE_LEGACY_COLOR = [1, 0.8, 0.2, 1] as const;
const WORLD_SCORE_TTF_COLOR = [0.42, 0.92, 1, 1] as const;
const WORLD_SCORE_LIFETIME = 0.9;
const WORLD_SCORE_RISE = 0.7;

export type WorldScoreFontSource = 'legacy-pack' | 'ttf-plugin';

export interface WorldScoreTextSnapshot {
  readonly available: boolean;
  readonly baked: boolean;
  readonly active: boolean;
  readonly text: string;
  readonly age: number;
  readonly position: readonly [number, number, number];
  readonly fontSource: WorldScoreFontSource;
  readonly fontGuid: string | null;
  readonly fontSize: number;
  readonly color: readonly [number, number, number, number];
  readonly toggles: number;
}

export interface WorldScoreTextHandle {
  readonly show: (text: string, position: readonly [number, number, number]) => void;
  readonly step: (delta: number, camera: EntityHandle) => void;
  readonly toggleFontSource: () => WorldScoreFontSource;
  readonly reset: () => void;
  readonly snapshot: () => WorldScoreTextSnapshot;
  readonly dispose: () => void;
}

/** The authored score label makes the imported font legible in the same hit event. */
export function worldScoreFontPresentation(source: WorldScoreFontSource): {
  readonly fontSize: number;
  readonly color: readonly [number, number, number, number];
} {
  return source === 'ttf-plugin'
    ? { fontSize: WORLD_SCORE_TTF_FONT_SIZE, color: WORLD_SCORE_TTF_COLOR }
    : { fontSize: WORLD_SCORE_FONT_SIZE, color: WORLD_SCORE_LEGACY_COLOR };
}

/**
 * Build one reusable world-space score label from the public FontAsset ->
 * GlyphText path. The label is deliberately pooled: hit feedback changes one
 * authoring component instead of spawning a new mesh every hit.
 */
export async function createWorldScoreText(
  world: World,
  assets: AssetRegistry | undefined,
): Promise<WorldScoreTextHandle | undefined> {
  if (assets === undefined) return undefined;

  const fontEntries: readonly [WorldScoreFontSource, string][] = [
    ['legacy-pack', GAME_DEFAULT_FONT_GUID],
    ['ttf-plugin', GAME_DEFAULT_TTF_FONT_GUID],
  ];
  const loadedFonts: Array<{
    readonly source: WorldScoreFontSource;
    readonly guid: string;
    readonly handle: AssetHandle<'font'>;
  }> = [];
  for (const [source, guidText] of fontEntries) {
    const fontGuid = AssetGuid.parse(guidText);
    if (!fontGuid.ok) continue;
    const loaded = await assets.load(fontGuid.value, 'font');
    if (!loaded.ok) {
      console.warn(`[game] ${source} world score font unavailable (${loaded.error.code}): ${loaded.error.hint}`);
      continue;
    }
    loadedFonts.push({ source, guid: guidText, handle: loaded.value });
  }
  if (loadedFonts.length === 0) return undefined;

  const defaultFont = loadedFonts.find((font) => font.source === 'legacy-pack') ?? loadedFonts[0]!;
  let activeFont = defaultFont;
  let presentation = worldScoreFontPresentation(activeFont.source);
  let toggles = 0;
  const entity = world.spawn(
    { component: Transform, data: { pos: [0, -100, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    // A non-empty seed gives the renderer a resident mesh before the first hit;
    // the label is parked off-world until `show` supplies the real score.
    { component: GlyphText, data: { fontHandle: activeFont.handle, text: '+0', fontSize: presentation.fontSize, color: presentation.color } },
  ).unwrap();

  let active = false;
  let text = '';
  let age = 0;
  let basePosition: [number, number, number] = [0, -100, 0];
  let disposed = false;

  const clear = (): void => {
    active = false;
    text = '';
    age = 0;
    world.set(entity, GlyphText, { text: '+0' });
    world.set(entity, Transform, { pos: [0, -100, 0] });
  };
  const reset = (): void => {
    clear();
    activeFont = defaultFont;
    toggles = 0;
    presentation = worldScoreFontPresentation(activeFont.source);
    world.set(entity, GlyphText, { fontHandle: activeFont.handle, fontSize: presentation.fontSize, color: presentation.color });
  };

  return {
    show: (nextText, position) => {
      if (disposed || nextText.length === 0) return;
      active = true;
      text = nextText;
      age = 0;
      basePosition = [position[0] ?? 0, position[1] ?? 0, position[2] ?? 0];
      world.set(entity, GlyphText, { text: nextText });
      world.set(entity, Transform, { pos: basePosition });
    },
    toggleFontSource: () => {
      if (loadedFonts.length < 2 || disposed) return activeFont.source;
      const nextIndex = (loadedFonts.indexOf(activeFont) + 1) % loadedFonts.length;
      activeFont = loadedFonts[nextIndex]!;
      toggles += 1;
      presentation = worldScoreFontPresentation(activeFont.source);
      world.set(entity, GlyphText, { fontHandle: activeFont.handle, fontSize: presentation.fontSize, color: presentation.color });
      return activeFont.source;
    },
    step: (delta, camera) => {
      if (disposed) return;
      const cameraTransform = world.get(camera, Transform);
      if (cameraTransform.ok) {
        world.set(entity, Transform, {
          quat: [
            cameraTransform.value.quat[0] ?? 0,
            cameraTransform.value.quat[1] ?? 0,
            cameraTransform.value.quat[2] ?? 0,
            cameraTransform.value.quat[3] ?? 1,
          ],
          ...(active ? { pos: [basePosition[0], basePosition[1] + age * WORLD_SCORE_RISE, basePosition[2]] } : {}),
        });
      }
      if (!active) return;
      age += Math.max(0, delta);
      if (age >= WORLD_SCORE_LIFETIME) clear();
    },
    reset,
    snapshot: () => {
      const transform = world.get(entity, Transform);
      const glyphText = world.get(entity, GlyphText);
      return {
        available: !disposed,
        baked: world.get(entity, MeshFilter).ok,
        active,
        text,
        age,
        position: transform.ok
          ? [transform.value.pos[0] ?? 0, transform.value.pos[1] ?? 0, transform.value.pos[2] ?? 0]
          : [0, 0, 0],
        fontSource: activeFont.source,
        fontGuid: activeFont.guid,
        fontSize: glyphText.ok ? glyphText.value.fontSize : presentation.fontSize,
        color: glyphText.ok
          ? [glyphText.value.color[0] ?? 0, glyphText.value.color[1] ?? 0, glyphText.value.color[2] ?? 0, glyphText.value.color[3] ?? 1]
          : presentation.color,
        toggles,
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      world.despawn(entity);
      for (const font of loadedFonts) assets.release(font.handle);
    },
  };
}
