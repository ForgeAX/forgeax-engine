// Shared Bevy `text2d` scene for the browser app and the Dawn smoke.
//
// Bevy's source demonstrates Text2d as ordinary world-space text attached to
// moving spatial entities: translation, rotation, scale, and a multi-line
// label. ForgeaX's public equivalent is GlyphText + Transform. The scene keeps
// that mapping explicit so the smoke cannot silently test a different scene.

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { GlyphText } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import type { FontAsset, Handle } from '@forgeax/engine-types';

export const SAMPLER_GUID = '019eb276-4d96-7313-b4f0-f5d55536acd2';
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
  readonly fonts: readonly Handle<'FontAsset', 'shared'>[];
  readonly baseLiveRefs: number;
}

export interface Text2dFontRecoveryError {
  readonly code: string;
  readonly expected?: string;
  readonly detail?: unknown;
}

export type Text2dFontRecoveryStage = 'idle' | 'baseline' | 'overflow' | 'recovered' | 'cleaned';

export interface Text2dFontRecoveryState {
  readonly stage: Text2dFontRecoveryStage;
  readonly prefixAttached: number;
  readonly targetAttached: boolean;
  readonly unrelatedPresent: boolean;
  readonly liveRefs: number;
  readonly baseLiveRefs: number;
  readonly baselineLiveRefs: number | null;
  readonly targetMeshHandle: number | null;
  readonly targetMaterialHandle: number | null;
  readonly errorCount: number;
  readonly lastError?: Text2dFontRecoveryError;
}

export interface Text2dFontRecoveryController {
  readonly read: () => Text2dFontRecoveryState;
  readonly baseline: () => Promise<Text2dFontRecoveryState>;
  readonly overflow: () => Promise<Text2dFontRecoveryState>;
  readonly recover: () => Promise<Text2dFontRecoveryState>;
  readonly cleanup: () => Promise<Text2dFontRecoveryState>;
}

export function registerSharedSampler(assets: AssetRegistry): void {
  const parsed = AssetGuid.parse(SAMPLER_GUID);
  if (!parsed.ok) throw new Error(`[bevy-text2d] SAMPLER_GUID parse failed: ${parsed.error.code}`);
  assets.catalog(parsed.value, {
    kind: 'sampler',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'nearest',
  });
}

export function buildText2dWorld(
  world: World,
  fontHandle: Handle<'FontAsset', 'shared'>,
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
  addText2dView(world);
  const baseLiveRefs = world.sharedRefs._liveCount();
  const fonts = Array.from({ length: 9 }, () =>
    world.allocSharedRef('FontAsset', {
      ...font,
      glyphs: { ...font.glyphs },
      common: { ...font.common },
    }),
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
      fonts[index] as Handle<'FontAsset', 'shared'>,
      `font-${index}`,
      pos,
      [0.35 + index * 0.07, 0.8, 1, 1],
    ),
  );
  const target = spawnRecoveryLabel(
    world,
    fonts[0] as Handle<'FontAsset', 'shared'>,
    'recovery',
    [0, -2.2, 0],
    [1, 0.8, 0.25, 1],
  );
  const unrelated = world
    .spawn({ component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } })
    .unwrap();
  return { prefix, target, unrelated, fonts, baseLiveRefs };
}

export function createText2dFontRecoveryController(
  world: World,
  scene: Text2dFontRecoveryScene,
  advanceFrame: () => Promise<void>,
  readErrors: () => readonly Text2dFontRecoveryError[],
): Text2dFontRecoveryController {
  let stage: Text2dFontRecoveryStage = 'idle';
  let baselineLiveRefs: number | null = null;

  const read = (): Text2dFontRecoveryState => {
    const errors = readErrors();
    const latest = errors[errors.length - 1];
    const targetFilter = world.get(scene.target, MeshFilter);
    const targetRenderer = world.get(scene.target, MeshRenderer);
    const targetMaterial = targetRenderer.ok
      ? Number(
          (
            (targetRenderer.value as unknown as { materials: readonly number[] }).materials[0] ?? 0
          ),
        )
      : 0;
    const lastError =
      latest === undefined
        ? undefined
        : {
            code: latest.code,
            ...(latest.expected === undefined ? {} : { expected: latest.expected }),
            ...(latest.detail === undefined ? {} : { detail: latest.detail }),
          };
    return {
      stage,
      prefixAttached: scene.prefix.filter(
        (entity) => world.get(entity, MeshFilter).ok && world.get(entity, MeshRenderer).ok,
      ).length,
      targetAttached: targetFilter.ok && targetRenderer.ok,
      unrelatedPresent: world.get(scene.unrelated, Transform).ok,
      liveRefs: world.sharedRefs._liveCount(),
      baseLiveRefs: scene.baseLiveRefs,
      baselineLiveRefs,
      targetMeshHandle: targetFilter.ok
        ? Number((targetFilter.value as unknown as { assetHandle: number }).assetHandle)
        : null,
      targetMaterialHandle: targetMaterial === 0 ? null : targetMaterial,
      errorCount: errors.length,
      ...(lastError === undefined ? {} : { lastError }),
    };
  };

  const baseline = async (): Promise<Text2dFontRecoveryState> => {
    if (stage === 'idle') {
      await advanceFrame();
      await advanceFrame();
      await advanceFrame();
      world.set(scene.unrelated, Transform, { pos: [0, 0, 0] }).unwrap();
      await advanceFrame();
      world.set(scene.target, GlyphText, { fontHandle: scene.fonts[1] as Handle<'FontAsset', 'shared'> }).unwrap();
      await advanceFrame();
      world.set(scene.target, GlyphText, { fontHandle: scene.fonts[0] as Handle<'FontAsset', 'shared'> }).unwrap();
      await advanceFrame();
      baselineLiveRefs = world.sharedRefs._liveCount();
      stage = 'baseline';
    }
    return read();
  };

  const overflow = async (): Promise<Text2dFontRecoveryState> => {
    if (stage === 'idle') await baseline();
    if (stage === 'baseline') {
      world
        .set(scene.target, GlyphText, {
          fontHandle: scene.fonts[8] as Handle<'FontAsset', 'shared'>,
        })
        .unwrap();
      await advanceFrame();
      stage = 'overflow';
    }
    return read();
  };

  const recover = async (): Promise<Text2dFontRecoveryState> => {
    if (stage === 'idle') await baseline();
    if (stage === 'baseline') await overflow();
    if (stage === 'overflow') {
      world
        .set(scene.target, GlyphText, {
          fontHandle: scene.fonts[1] as Handle<'FontAsset', 'shared'>,
        })
        .unwrap();
      await advanceFrame();
      await advanceFrame();
      stage = 'recovered';
    }
    return read();
  };

  const cleanup = async (): Promise<Text2dFontRecoveryState> => {
    if (stage === 'idle') await baseline();
    if (stage === 'baseline') await overflow();
    if (stage === 'overflow') await recover();
    if (stage === 'recovered') {
      for (const entity of [...scene.prefix, scene.target]) world.despawn(entity).unwrap();
      await advanceFrame();
      for (const fontHandle of scene.fonts) world.sharedRefs.release(fontHandle);
      await advanceFrame();
      stage = 'cleaned';
    } else if (stage === 'cleaned') {
      await advanceFrame();
    }
    return read();
  };

  return { read, baseline, overflow, recover, cleanup };
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
  fontHandle: Handle<'FontAsset', 'shared'>,
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
