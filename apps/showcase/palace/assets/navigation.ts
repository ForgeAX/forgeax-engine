import type {} from '@forgeax/engine/app';
import { Time, Update } from '@forgeax/engine/ecs';
import { FRAME_START_SCAN_SYSTEM_NAME, INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { quat } from '@forgeax/engine/math';
import type { Plugin } from '@forgeax/engine/plugin';
import { Camera } from '@forgeax/engine/render';
import { Name, Transform } from '@forgeax/engine/scene';

/** Ordinary game camera: input is consumed from the App-owned frame snapshot. */
export default {
  name:'palace', inject:['world','gameHost','palaceScene'],
  apply(ctx){
    ctx.gameHost?.setPointerLockAllowed?.(false);
    ctx.world.addSystem(Update,{
      name:'palace-navigation',after:[FRAME_START_SCAN_SYSTEM_NAME],queries:[],
      fn:()=>{
        const input=ctx.world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        const dt=ctx.world.getResource(Time).delta;
        const forward=Number(input.keyboard.downCode('KeyW'))-Number(input.keyboard.downCode('KeyS'));
        const right=Number(input.keyboard.downCode('KeyD'))-Number(input.keyboard.downCode('KeyA'));
        const up=Number(input.keyboard.downCode('KeyE'))-Number(input.keyboard.downCode('KeyQ'));
        const speed=input.keyboard.downCode('ShiftLeft')?70:18;
        for(const row of ctx.world.query({with:[Camera,Transform,Name]}).unwrap()){
          if(ctx.world.get(row.entity,Name).unwrap().value!=='Reference Camera')continue;
          const transform=ctx.world.get(row.entity,Transform).unwrap();
          const [x,y,z,w]=transform.quat;
          const pos=[transform.pos[0]+(-2*(x*z+w*y)*forward+(1-2*(y*y+z*z))*right)*speed*dt,
            transform.pos[1]+up*speed*dt,
            transform.pos[2]+(-(1-2*(x*x+y*y))*forward+2*(x*z-w*y)*right)*speed*dt];
          const orientation=quat.clone(transform.quat);
          if(input.mouse.pointerLocked || input.mouse.button(2)){
            quat.rotateAxis(orientation,orientation,[0,1,0],-input.mouse.movementDelta.x*.002);
            quat.rotateAxis(orientation,orientation,[1,0,0],-input.mouse.movementDelta.y*.002);
          }
          if(forward||right||up||input.mouse.pointerLocked||input.mouse.button(2))ctx.world.set(row.entity,Transform,{pos,quat:orientation}).unwrap();
        }
      }
    }).unwrap();
    const unregister=ctx.gameHost?.gameProjection?.registerRead({
      id:'palace.camera',title:'Palace camera',description:'Authored camera pose and current input state.',
      read:()=>{
        for(const row of ctx.world.query({with:[Camera,Transform,Name]}).unwrap()){
          if(ctx.world.get(row.entity,Name).unwrap().value!=='Reference Camera')continue;
          const t=ctx.world.get(row.entity,Transform).unwrap();
          const input=ctx.world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
          return {position:Array.from(t.pos),orientation:Array.from(t.quat),pointerLocked:input.mouse.pointerLocked,dragging:input.mouse.button(2),forward:input.keyboard.downCode('KeyW')};
        }
        throw Error('Authored camera is missing');
      }
    });
    ctx.effect(()=>()=>{unregister?.();ctx.world.removeSystem(Update,'palace-navigation');ctx.gameHost?.setPointerLockAllowed?.(false);}, 'palace/navigation');
  }
} satisfies Plugin;
