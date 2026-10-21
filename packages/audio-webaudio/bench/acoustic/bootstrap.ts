import { type ExecutionBootstrapEntry } from '@forgeax/engine/app';
import { audioPlugin, AudioSource, AudioListener, AcousticRegion } from '@forgeax/engine/audio';
import { Update, type EntityHandle } from '@forgeax/engine/ecs';
import { defineSharedKernel } from '@forgeax/engine/ecs/shared';
import { GlobalTransform, Transform, worldDespawnScene } from '@forgeax/engine/scene';
import { AcousticCounter, run } from './kernel';
const entry: ExecutionBootstrapEntry = data => ({ features: [], plugins: [audioPlugin(), {
  name: 'saved-acoustic-rooms', inject: ['world','assets','audio','executionBootstrapHost'],
  async apply(ctx) {
    const world=ctx.world;
    const {guid,shared}=data as {guid:string;shared:boolean};
    if(world.components.resolve('Transform')!==Transform||world.components.resolve('GlobalTransform')!==GlobalTransform)
      throw new Error('public Worker Scene component module identity diverged');
    const assets=ctx.assets;if(!assets)throw new Error('asset provider absent');
    const handle=(await assets.load(guid, 'scene')).unwrap();
    const root=assets.instantiate(handle,world).unwrap();
    const source=[...world.query({read:[AudioSource]}).unwrap()][0]?.entity;
    const listener=[...world.query({with:[AudioListener]}).unwrap()][0]?.entity;
    if(source===undefined||listener===undefined)throw new Error('saved source/listener absent');
    const counters:EntityHandle[]=[];
    if(shared){for(let i=0;i<8192;i++)counters.push(world.spawn({component:AcousticCounter,data:{value:0}}).unwrap());
      const kernelUrl=import.meta.env.DEV?new URL('./kernel.ts',import.meta.url):new URL('/assets/acoustic-kernel.js',globalThis.location.href);
      world.addSystem(Update,defineSharedKernel(kernelUrl.href,{name:'acoustic-counter',queries:[{write:[AcousticCounter]}],minimumRows:1,run})).unwrap();}
    const port=ctx.executionBootstrapHost.port;
    const receive=(event:MessageEvent)=>{
      if(event.data.poison){world.addSystem(Update,{name:'acoustic-rebuild-falsifier',queries:[],fn:()=>{throw new Error('acoustic rebuild falsifier');}}).unwrap();return;}
      if(event.data.x!==undefined){world.set(source,Transform,{pos:[event.data.x,0,0]}).unwrap();world.set(listener,Transform,{pos:[event.data.x,0,0]}).unwrap();}
      if(event.data.paused!==undefined)world.set(source,AudioSource,{paused:event.data.paused}).unwrap();
      if(event.data.fromPosition!==undefined)world.set(source,AudioSource,{fromPosition:event.data.fromPosition}).unwrap();
      if(event.data.removeListener)world.removeComponent(listener,AudioListener).unwrap();
      if(event.data.removeRegions){const regions=Array.from(world.query({with:[AcousticRegion]}).unwrap(),row=>row.entity);for(const entity of regions)world.removeComponent(entity,AcousticRegion).unwrap();}
      if(event.data.stop)world.set(source,AudioSource,{playing:false}).unwrap();
    };
    port?.addEventListener('message',receive);port?.start();
    return()=>{
      // The session port survives World rebuild. Retire its old listener before
      // any World cleanup can fail; a poisoned World refuses entity mutation.
      port?.removeEventListener('message',receive);
      if(shared)world.removeSystem(Update,'acoustic-counter').unwrap();
      if(world.execution.health==='healthy'){
        for(const entity of counters)world.despawn(entity).unwrap();
        worldDespawnScene(world,root).unwrap();
      }
      assets.release(handle).unwrap();
    };
  },
}]});
export default entry;
