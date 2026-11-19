import { defineSystem } from "@forgeax/engine-ecs";
import { ANTIALIAS_FXAA, ANTIALIAS_MSAA, ANTIALIAS_NONE, BLOOM_DISABLED, BLOOM_ENABLED, Camera } from '@forgeax/engine-render';
import { Update, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { applyClearColor, type ClearColorMode } from '../clear-color';
import type { AntialiasMode, GameSettingsState } from '../settings';
import type { DepthOfFieldHandle } from '../depth-of-field';

export type RenderSettingsSystemContext = {
  readonly world: World;
  readonly camera: EntityHandle;
  readonly settings: GameSettingsState;
  readonly depthOfField: DepthOfFieldHandle;
};

/** Projects the World-owned settings resource into render components. */
export function installRenderSettingsSystems(ctx: RenderSettingsSystemContext): void {
  let appliedDepthOfField = ctx.settings.depthOfField;
  const systemToken1 = defineSystem({
    name: 'game-depth-of-field-settings',
    queries: [],
    fn: () => {
      if (ctx.settings.depthOfField === appliedDepthOfField) return;
      appliedDepthOfField = ctx.settings.depthOfField;
      ctx.depthOfField.setEnabled(appliedDepthOfField);
    },
  });
ctx.world.addSystem(Update, systemToken1).unwrap();

  let appliedAntialias: AntialiasMode = ctx.settings.antialias;
  const antialiasValue = (mode: AntialiasMode): number => mode === 'none' ? ANTIALIAS_NONE : mode === 'msaa' ? ANTIALIAS_MSAA : ANTIALIAS_FXAA;
  const systemToken2 = defineSystem({
    name: 'game-antialias-settings',
    queries: [],
    fn: () => {
      if (ctx.settings.antialias === appliedAntialias) return;
      appliedAntialias = ctx.settings.antialias;
      ctx.world.set(ctx.camera, Camera, { antialias: antialiasValue(appliedAntialias) });
    },
  });
ctx.world.addSystem(Update, systemToken2).unwrap();

  let appliedBloom = ctx.settings.bloom;
  const systemToken3 = defineSystem({
    name: 'game-bloom-settings',
    queries: [],
    fn: () => {
      if (ctx.settings.bloom === appliedBloom) return;
      appliedBloom = ctx.settings.bloom;
      ctx.world.set(ctx.camera, Camera, { bloom: appliedBloom ? BLOOM_ENABLED : BLOOM_DISABLED });
    },
  });
ctx.world.addSystem(Update, systemToken3).unwrap();

  let appliedClearColor: ClearColorMode = ctx.settings.clearColor;
  const systemToken4 = defineSystem({
    name: 'game-clear-color-settings',
    queries: [],
    fn: () => {
      if (ctx.settings.clearColor === appliedClearColor) return;
      appliedClearColor = ctx.settings.clearColor;
      applyClearColor(ctx.world, ctx.camera, appliedClearColor);
    },
  });
ctx.world.addSystem(Update, systemToken4).unwrap();
}
