import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World, type EntityHandle } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { Camera, CameraView } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { loadVfxGpuEffect, ParticleEffectPlayer } from '@forgeax/engine-vfx';
import { fieldGuid } from './field-guids.ts';

export const FIELD_DT = 1 / 60;
export const FIELD_WIDTH = 512;
export const FIELD_HEIGHT = 512;
export const fieldCamera = {
  read(_world: World) {
    return {
      position: new Float32Array([0, 0, 4]), right: new Float32Array([1, 0, 0]), up: new Float32Array([0, 1, 0]),
      viewProjection: mat4.multiply(mat4.create(), mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.1, 100), mat4.lookAt(mat4.create(), [0, 0, 4], [0, 0, 0], [0, 1, 0])),
    };
  },
};
export async function populateFieldScene(world: World, assets: AssetRegistry, key: string): Promise<{player: EntityHandle; camera: EntityHandle}> {
  const effect = await loadVfxGpuEffect(assets, fieldGuid(`effect/${key}`));
  if (!effect.ok) throw effect.error;
  // Effect loading owns its ordinary eager Texture/Material GUID closure.
  const camera = world.spawn({ component: Transform, data: { pos: [0, 0, 4] } }, { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 } }).unwrap();
  if(key==='shared') {
    world.addComponent(camera,{component:CameraView,data:{viewport:[0,0,.5,1],order:0,updateInterval:1}}).unwrap();
    world.spawn({component:Transform,data:{pos:[0,0,4]}},{component:Camera,data:{fov:Math.PI/3,aspect:.5,near:.1,far:100}},{component:CameraView,data:{viewport:[.5,0,.5,1],order:1,updateInterval:3}}).unwrap();
  }
  const player = world.spawn({ component: Transform, data: key === 'local' ? {pos:[.125,-.25,0],quat:[0,0,Math.SQRT1_2,Math.SQRT1_2],scale:[2,1,.5]} : {} }, { component: ParticleEffectPlayer, data: { effect: world.allocSharedRef('ParticleEffectAsset', effect.value), playing: true, seed: 21, timeScale: 1 } }).unwrap();
  return { player, camera };
}
