import type { AssetHandle } from '@forgeax/engine-types';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { MeshRenderer } from '@forgeax/engine-render';
import animatedTargetShader from '../shaders/animated-target.wgsl';

export const ANIMATED_TARGET_SHADER_ID = 'game_default::animated_target';
export const ANIMATED_TARGET_SHADER_SOURCE = animatedTargetShader.wgsl;

export type AnimatedMaterialTarget = {
  readonly entity: EntityHandle;
  readonly baseMaterial: AssetHandle<'material'>;
  readonly material: AssetHandle<'material'>;
  readonly assets: AssetRegistry;
  dispose(): void;
};

export function createAnimatedMaterialTarget(
  world: World,
  assets: AssetRegistry,
  source: { e: EntityHandle; mat: AssetHandle<'material'> },
): AnimatedMaterialTarget {
  const base = assets.read(source.mat).unwrap();
  const material = assets.create({
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: ANIMATED_TARGET_SHADER_ID }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } }],
    values: { baseColor: base.values?.baseColor ?? [1, 1, 1, 1], time: 0 },
  }).unwrap();
  world.set(source.e, MeshRenderer, { materials: [material] }).unwrap();
  return { entity: source.e, baseMaterial: source.mat, material, assets,
    dispose: () => { assets.release(material).unwrap(); } };

}

export function stepAnimatedMaterial(world: World, target: AnimatedMaterialTarget, elapsed: number): void {
  if (world.get(target.entity, MeshRenderer).unwrap().materials[0] !== target.material) {
    world.set(target.entity, MeshRenderer, { materials: [target.material] }).unwrap();
  }
  target.assets.update(target.material, { values: { time: elapsed } }).unwrap();
}

export function resetAnimatedMaterial(world: World, target: AnimatedMaterialTarget): void {
  world.set(target.entity, MeshRenderer, { materials: [target.baseMaterial] }).unwrap();
  target.assets.update(target.material, { values: { time: 0 } }).unwrap();
}

export function animatedShaderEnabled(target: AnimatedMaterialTarget | undefined): boolean {
  return target !== undefined;
}

export function animatedShaderTime(target: AnimatedMaterialTarget | undefined): number {
  if (target === undefined) return 0;
  const time = target.assets.read(target.material).unwrap().values?.time;
  return typeof time === 'number' ? time : 0;
}
