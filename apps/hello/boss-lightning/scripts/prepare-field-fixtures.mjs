import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fieldGuid } from '../src/field-guids.ts';
const root=resolve(import.meta.dirname,'../assets');
const transform=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const transformed=[0,2,0,0,-1,0,0,0,0,0,.5,0,.125,-.25,0,1];
const vector=(key,strength=1,sampling='trilinear')=>({kind:'vector',texture:fieldGuid(key),sampling,transform,strength,attenuation:0});
const spawn=`fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function,VfxParticle>) {
  let id = ctx.particleId;
  (*particle).position = vec3f(f32(id % 16u)/20.0-0.375, f32((id/16u)%16u)/20.0-0.375, 0.1);
  (*particle).velocity = vec3f(0.0);
  (*particle).lifetime = 100.0;
  (*particle).sprite_size = vec2f(0.015);
  (*particle).color = vec4f(0.1,0.7,1.0,1.0);
}`;
for(const boundary of [false,true])for(const on of [false,true])writeFileSync(resolve(root,`fields-${boundary?'boundary-':''}${on?'on':'off'}.vfx.wgsl`),`#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext,vfx_integrate}
${on?'#import forgeax_vfx::data::force_fields':''}
${boundary?spawn.replace('  (*particle).velocity',`  if(id == 0u){(*particle).position=vec3f(0.0);}
  if(id == 1u){(*particle).position=vec3f(1.0,0.0,0.0);}
  if(id == 2u){(*particle).position=vec3f(1.25,0.0,0.0);}
  if(id == 3u){(*particle).position=vec3f(0.75,0.75,0.0);}
  (*particle).velocity`):spawn}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function,VfxParticle>) {
  ${on?'vfx_apply_force_fields(ctx,particle);':''}
  vfx_integrate(ctx,particle);
}`);
const affineSpawn=spawn.replace('  (*particle).velocity', `  if(id == 0u){(*particle).position=vec3f(0.125,-0.25,0.0);}
  if(id == 1u){(*particle).position=vec3f(0.125,-2.15,0.0);}
  if(id == 2u){(*particle).position=vec3f(0.125,1.85,0.0);}
  if(id == 3u){(*particle).position=vec3f(1.075,-0.25,0.0);}
  if(id == 4u){(*particle).position=vec3f(-0.925,-0.25,0.0);}
  (*particle).velocity`);
writeFileSync(resolve(root,'fields-affine-spatial-on.vfx.wgsl'), `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext,vfx_integrate}
#import forgeax_vfx::data::force_fields
${affineSpawn}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function,VfxParticle>) {
  vfx_apply_force_fields(ctx,particle);
  vfx_integrate(ctx,particle);
}`);
const assets=[];
const effect=(key,fields,capacity=256,space='world',emitterCount)=>{
 const count=emitterCount??(capacity>=10000?Math.max(4,Math.ceil(capacity/65536)):1);
 const capacities=Array.from({length:count},(_,i)=>capacity===1000000?Math.min(65536,capacity-i*65536):Math.floor(capacity/count)+(i<capacity%count?1:0));
 assets.push({guid:fieldGuid(`effect/${key}`),kind:'particle-effect',execution:'cooked',refs:[...new Set([fieldGuid('material/particle'),...(fields??[]).filter(f=>f.kind==='vector').map(f=>f.texture)])].sort(),payload:{schemaVersion:3,emitters:capacities.map((n,i)=>({
  id:`field-${i}`,capacity:n,backend:{required:'gpu'},space,bounds:{kind:'aabb',min:[-4,-4,-4],max:[4,4,4]},simulationWhenCulled:'continue',
  schedule:{rate:0,bursts:[{time:0,count:n}]},...(fields?{forceFields:fields}:{}),program:{module:`fields-${key==='affine-spatial'?'affine-spatial-':['sphere','box'].includes(key)?'boundary-':''}${fields?'on':'off'}.vfx.wgsl`},
  renderers:[{kind:'billboard',capacity:n,material:fieldGuid('material/particle')}],
 }))}});
};
for(const [key,fields] of [['off',undefined],['constant',[vector('field/constant/8')]],['zero',[vector('field/constant/8',0)]],['sphere',[{kind:'sphere',transform,strength:.5,attenuation:1}]],['box',[{kind:'box',transform,strength:.5,attenuation:1}]]])effect(key,fields);
for(const kind of ['radial','vortex'])for(const n of [8,16,32])for(const sampling of ['nearest','trilinear'])effect(`${kind}/${n}/${sampling}`,[vector(`field/${kind}/${n}`,1,sampling)]);
effect('transformed',[{...vector('field/constant/8'),transform:transformed}]);
effect('affine-spatial',[{...vector('field/radial/16'),transform:transformed}]);
effect('local',[{...vector('field/constant/8'),transform:transformed}],256,'local');
effect('vortex/16/reversed',[vector('field/vortex/16',-1)]);
effect('shared',[vector('field/constant/8')],512,'world',2);
effect('zero-vector',[vector('field/zero/8')]);
for(const n of [10000,100000,1000000])for(const on of [false,true])effect(`benchmark/${n}/${on?'on':'off'}`,on?[vector('field/vortex/16'),{kind:'sphere',transform,strength:.5,attenuation:1}]:undefined,n);
writeFileSync(resolve(root,'field-effects.pack.json'),JSON.stringify({schemaVersion:'2.0.0',kind:'internal-text-package',assets},null,2)+'\n');
