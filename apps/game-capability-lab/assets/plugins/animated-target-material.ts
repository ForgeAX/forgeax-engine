import { RuntimeMaterialValue } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { MeshRenderer } from '@forgeax/engine-render';
import type { Handle, MaterialAsset } from '@forgeax/engine-runtime';
import animatedTargetShader from '../shaders/animated-target.wgsl';

export const ANIMATED_TARGET_SHADER_ID = 'game_default::animated_target';
export const ANIMATED_TARGET_SHADER_SOURCE = animatedTargetShader.wgsl;

export type AnimatedMaterialTarget = {
  readonly entity: EntityHandle;
  readonly baseMaterial: Handle<'MaterialAsset', 'shared'>;
  readonly material: Handle<'MaterialAsset', 'shared'>;
  readonly timeValue: EntityHandle;
  shaderTime: number;
};

export function createAnimatedMaterialTarget(
  world: World,
  source: { e: EntityHandle; mat: Handle<'MaterialAsset', 'shared'> },
): AnimatedMaterialTarget {
  const base = world.sharedRefs.resolve<'MaterialAsset', MaterialAsset>(source.mat).unwrap();
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: ANIMATED_TARGET_SHADER_ID }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } }],
    values: { baseColor: base.values?.baseColor ?? [1, 1, 1, 1], time: 0 },
  });
  world.set(source.e, MeshRenderer, { materials: [material] }).unwrap();
  const timeValue = world.spawn({ component: RuntimeMaterialValue, data: { asset: material, parameter: 'time', value: [0] } }).unwrap();
  return { entity: source.e, baseMaterial: source.mat, material, timeValue, shaderTime: 0 };
}

export function stepAnimatedMaterial(world: World, target: AnimatedMaterialTarget, elapsed: number): void {
  if (world.get(target.entity, MeshRenderer).unwrap().materials[0] !== target.material) {
    world.set(target.entity, MeshRenderer, { materials: [target.material] }).unwrap();
  }
  world.set(target.timeValue, RuntimeMaterialValue, { value: [elapsed] }).unwrap();
  target.shaderTime = elapsed;
}

export function resetAnimatedMaterial(world: World, target: AnimatedMaterialTarget): void {
  world.set(target.entity, MeshRenderer, { materials: [target.baseMaterial] }).unwrap();
  world.set(target.timeValue, RuntimeMaterialValue, { value: [0] }).unwrap();
  target.shaderTime = 0;
}

export function animatedShaderEnabled(target: AnimatedMaterialTarget | undefined): boolean {
  return target !== undefined;
}

export function animatedShaderTime(target: AnimatedMaterialTarget | undefined): number {
  return target?.shaderTime ?? 0;
}
