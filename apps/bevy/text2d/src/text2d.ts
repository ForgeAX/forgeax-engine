import type { AssetHandle } from '@forgeax/engine-types';
// Shared Bevy `text2d` scene for the browser app and the Dawn smoke.
//
// Bevy's source demonstrates Text2d as ordinary world-space text attached to
// moving spatial entities: translation, rotation, scale, and a multi-line
// label. ForgeAX's public equivalent is GlyphText + Transform. The scene keeps
// that mapping explicit so the smoke cannot silently test a different scene.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { GlyphText } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import type { FontAsset } from '@forgeax/engine-types';

export const TEXT2D_FONT_SIZE = 0.018;

export const Text2dMotion = defineComponent('BevyText2dMotion', {
  phase: { type: 'f32', default: 0 },
});

export interface Text2dScene {
  readonly translation: EntityHandle;
  readonly rotation: EntityHandle;
  readonly scale: EntityHandle;
  readonly multiline: EntityHandle;
}

export interface Text2dFontRecoveryScene {
  readonly prefix: readonly EntityHandle[];
  readonly target: EntityHandle;
  readonly unrelated: EntityHandle;
  readonly fonts: readonly AssetHandle<'font'>[];
}

export interface Text2dFontRecoveryError {
  readonly code: string;
  readonly expected?: string;
  readonly detail?: unknown;
}

export type Text2dFontRecoveryStage = 'idle' | 'baseline' | 'edited' | 'recovered' | 'cleaned';

export interface Text2dFontRecoveryState {
  readonly stage: Text2dFontRecoveryStage;
  readonly labels: number;
  readonly generatedComponents: number;
  readonly unrelatedPresent: boolean;
  readonly liveFonts: number;
  readonly targetFontHandle: number | null;
  readonly targetGlyphs: number;
  readonly errorCount: number;
}

export interface Text2dFontRecoveryController {
  readonly read: () => Text2dFontRecoveryState;
  readonly baseline: () => Promise<Text2dFontRecoveryState>;
  readonly edit: () => Promise<Text2dFontRecoveryState>;
  readonly recover: () => Promise<Text2dFontRecoveryState>;
  readonly cleanup: () => Promise<Text2dFontRecoveryState>;
}

export function buildText2dWorld(
  world: World,
  fontHandle: AssetHandle<'font'>,
): Text2dScene {
  const spawn = (
    text: string,
    pos: readonly [number, number, number],
    color: readonly [number, number, number, number],
  ): EntityHandle => world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: GlyphText, data: { fontHandle, text, fontSize: TEXT2D_FONT_SIZE, color } },
    { component: Text2dMotion, data: {} },
  ).unwrap();

  const scene = {
    translation: spawn('translation', [-4.4, 1.3, 0], [0.45, 0.9, 1, 1]),
    rotation: spawn('rotation', [-1.8, 0.15, 0], [1, 0.7, 0.3, 1]),
    scale: spawn('scale', [2.1, 1.3, 0], [0.55, 1, 0.55, 1]),
    multiline: spawn('multi\nline', [-1.0, -1.45, 0], [0.6, 0.85, 1, 1]),
  } satisfies Text2dScene;

  addText2dView(world);
  return scene;
}

export function buildText2dFontRecoveryWorld(
  world: World,
  font: FontAsset,
): Text2dFontRecoveryScene {
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

  addText2dView(world);
  const fonts = Array.from({ length: 9 }, () =>
    sceneAssets.create({
      ...font,
      glyphs: { ...font.glyphs },
      common: { ...font.common },
    }).unwrap(),
  );
  const prefixPositions: readonly (readonly [number, number, number])[] = [
    [-4.5, 2.4, 0],
    [-3.3, 2.4, 0],
    [-2.1, 2.4, 0],
    [-0.9, 2.4, 0],
    [0.3, 2.4, 0],
    [1.5, 2.4, 0],
    [2.7, 2.4, 0],
    [3.9, 2.4, 0],
  ];
  const prefix = prefixPositions.map((pos, index) =>
    spawnRecoveryLabel(
      world,
      fonts[index] as AssetHandle<'font'>,
      `font-${index}`,
      pos,
      [0.35 + index * 0.07, 0.8, 1, 1],
    ),
  );
  const target = spawnRecoveryLabel(
    world,
    fonts[8] as AssetHandle<'font'>,
    'recovery',
    [0, -2.2, 0],
    [1, 0.8, 0.25, 1],
  );
  const unrelated = world
    .spawn({ component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } })
    .unwrap();
  return { prefix, target, unrelated, fonts };
}

export function createText2dFontRecoveryController(
  world: World,
  scene: Text2dFontRecoveryScene,
  advanceFrame: () => Promise<void>,
  readErrors: () => readonly Text2dFontRecoveryError[],
): Text2dFontRecoveryController {
  const assets = world.assets;
  if (!(assets instanceof AssetRegistry)) throw new Error('Font recovery requires its asset owner');
  const targetFont = scene.fonts[8];
  if (targetFont === undefined) throw new Error('Missing ninth font');
  const originalGlyphs = assets.read(targetFont).unwrap().glyphs;
  let stage: Text2dFontRecoveryStage = 'idle';
  const entities = [...scene.prefix, scene.target];
  const read = (): Text2dFontRecoveryState => {
    const target = world.get(scene.target, GlyphText);
    const font = assets.read(targetFont);
    return {
      stage,
      labels: entities.filter((entity) => world.hasComponent(entity, GlyphText)).length,
      generatedComponents: entities.filter((entity) =>
        world.hasComponent(entity, MeshFilter) || world.hasComponent(entity, MeshRenderer)).length,
      unrelatedPresent: world.hasComponent(scene.unrelated, Transform),
      liveFonts: scene.fonts.filter((handle) => assets.validate(handle, 'font').ok).length,
      targetFontHandle: target.ok ? Number(target.value.fontHandle) : null,
      targetGlyphs: font.ok ? Object.keys(font.value.glyphs).length : 0,
      errorCount: readErrors().length,
    };
  };
  const advance = async () => { for (let frame = 0; frame < 15; frame++) await advanceFrame(); };
  const baseline = async () => {
    if (stage === 'idle') { await advance(); stage = 'baseline'; }
    return read();
  };
  const edit = async () => {
    if (stage === 'idle') await baseline();
    if (stage === 'baseline') {
      assets.update(targetFont, { glyphs: {} }).unwrap();
      await advance();
      stage = 'edited';
    }
    return read();
  };
  const recover = async () => {
    if (stage === 'idle') await baseline();
    if (stage === 'baseline') await edit();
    if (stage === 'edited') {
      assets.update(targetFont, { glyphs: originalGlyphs }).unwrap();
      await advance();
      stage = 'recovered';
    }
    return read();
  };
  const cleanup = async () => {
    if (stage === 'idle') await baseline();
    if (stage === 'baseline') await edit();
    if (stage === 'edited') await recover();
    if (stage === 'recovered') {
      for (const entity of entities) world.despawn(entity).unwrap();
      for (const font of scene.fonts) assets.release(font).unwrap();
      await advance();
      stage = 'cleaned';
    }
    return read();
  };
  return { read, baseline, edit, recover, cleanup };
}

export function stepText2d(world: World, scene: Text2dScene, dt: number): void {
  const handles = [scene.translation, scene.rotation, scene.scale];
  for (const handle of handles) {
    const motion = world.get(handle, Text2dMotion);
    if (!motion.ok) continue;
    world.set(handle, Text2dMotion, { phase: motion.value.phase + dt });
  }

  const translationPhase = world.get(scene.translation, Text2dMotion);
  if (translationPhase.ok) {
    const phase = translationPhase.value.phase;
    world.set(scene.translation, Transform, {
      pos: [-4.4 + Math.sin(phase * 1.2) * 0.35, 1.3 + Math.cos(phase * 1.2) * 0.18, 0],
    });
  }

  const rotationPhase = world.get(scene.rotation, Text2dMotion);
  if (rotationPhase.ok) {
    world.set(scene.rotation, Transform, {
      quat: quat.fromAxisAngle(quat.create(), [0, 0, 1], Math.sin(rotationPhase.value.phase * 1.4) * 0.65),
    });
  }

  const scalePhase = world.get(scene.scale, Text2dMotion);
  if (scalePhase.ok) {
    const scale = 1 + Math.sin(scalePhase.value.phase * 1.6) * 0.22;
    world.set(scene.scale, Transform, { scale: [scale, scale, 1] });
  }
}

function addText2dView(world: World): void {
  world.spawn(
    { component: DirectionalLight, data: { direction: [-0.3, -0.5, -1], color: [1, 1, 1], intensity: 1.2, castShadow: false } },
  ).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 10], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -5, right: 5, bottom: -3, top: 3, near: 0.1, far: 100 }) },
  ).unwrap();
}

function spawnRecoveryLabel(
  world: World,
  fontHandle: AssetHandle<'font'>,
  text: string,
  pos: readonly [number, number, number],
  color: readonly [number, number, number, number],
): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: GlyphText, data: { fontHandle, text, fontSize: TEXT2D_FONT_SIZE, color } },
    )
    .unwrap();
}
