// Independent live AnimationPlayer + retarget oracle against baked AnimationPlayer, between keys.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { ChildOf, scenePlugin, Transform } from '@forgeax/engine-scene';
import { AnimationPlayer, AnimationTargetId, animationPlugin, bindAnimationTargets,
  createSkeletonRetargeter, deriveAnimationTargetId, retargetAnimationClip } from '../dist/index.mjs';

const out = resolve(process.env.ANIMATION_EVIDENCE ?? 'artifacts/animation-maturity');
mkdirSync(out,{recursive:true});
const report = { mapping:'4 source joints to 3 target joints; animated unmapped intermediate', duration:1.13, loopPolicy:'terminal sampled without wrap; closed-clip endpoints and actual player wrap compared separately',
  thresholds:{ angularRadians:0.002, translation:1e-5, fps:60 }, cases:[] };
for (const fps of [15,30,60,120]) {
  const world = new World();
  const context = await createWorldContext(world,[scenePlugin(),animationPlugin()]);
  const chain = (name,length) => {
    const joints=[];
    for(let i=0;i<(name==='source'?4:3);i++) joints.push(world.spawn(
      {component:Transform,data:{pos:i===0?[name==='source'?-3:4,0,0]:[length,0,0],
        quat:quat.fromEuler(quat.create(),0.1*i,name==='source'?-0.2:0.3,0.1,'XYZ')}},
      {component:AnimationTargetId,data:{value:deriveAnimationTargetId([name,String(i)])}},
      ...(i===0?[]:[{component:ChildOf,data:{parent:joints[i-1]}}]),
    ).unwrap());
    return joints;
  };
  const source=chain('source',1); const target=chain('target',1.7);
  const pairs=target.map((t,i)=>({source:source[i===0?0:i+1],target:t}));
  const channels=[];
  for(let joint=0;joint<source.length;joint++) {
    const rest=world.get(source[joint],Transform).unwrap().quat;
    const output=[];
    for(const amount of [0,0.35,-0.2,0]) {
      const q=quat.fromEuler(quat.create(),amount*(joint+1),amount*-0.7,amount*1.1,'XYZ');
      quat.multiply(q,rest,q); output.push(...q);
    }
    channels.push({targetId:deriveAnimationTargetId(['source',String(joint)]),property:'rotation',sampler:{
      input:new Float32Array([0,0.37,0.81,1.13]),output:new Float32Array(output),interpolation:'LINEAR',
    }});
  }
  channels.push({targetId:deriveAnimationTargetId(['source','0']),property:'translation',sampler:{
    input:new Float32Array([0,0.37,0.81,1.13]), output:new Float32Array([-3,0,0,-2.7,0.1,0.2,-2.9,-0.1,0.1,-3,0,0]),interpolation:'LINEAR',
  }});
  const clip={kind:'animation-clip',duration:1.13,channels};
  const options={pairs,rootTranslationScale:1.7};
  const runtime=createSkeletonRetargeter(world,options).unwrap();
  const started=performance.now();
  const baked=retargetAnimationClip(world,{...options,clip,fps}).unwrap();
  const bakeMs=performance.now()-started;
  for(const [joints,payload] of [[source,clip],[target,baked]]) {
    world.addComponent(joints[0],{component:AnimationPlayer,data:{clips:[world.allocSharedRef('AnimationClip',payload)],
      times:[0],weights:[1],speeds:[0],paused:true,looping:false}}).unwrap();
    bindAnimationTargets(world,joints[0],joints).unwrap();
  }
  const rows=[];
  // Irrationally offset samples do not align with bake grids or source keys.
  for(let i=0;i<=600;i++) {
    const time=i===600?clip.duration:((i+0.381966)*clip.duration/600);
    world.set(source[0],AnimationPlayer,{times:[time]}).unwrap();
    world.set(target[0],AnimationPlayer,{weights:[0]}).unwrap(); world.update(0).unwrap(); runtime.retarget().unwrap();
    const expected=target.map((j)=>{const t=world.get(j,Transform).unwrap();return {q:[...t.quat],p:[...t.pos]};});
    world.set(target[0],AnimationPlayer,{weights:[1],times:[time]}).unwrap(); world.update(0).unwrap();
    let angle=0,translation=0;
    for(let j=0;j<3;j++) {
      const actual=world.get(target[j],Transform).unwrap(); const e=expected[j];
      const dot=Math.abs([...actual.quat].reduce((sum,v,k)=>sum+v*e.q[k],0))/(Math.hypot(...actual.quat)*Math.hypot(...e.q));
      angle=Math.max(angle,2*Math.acos(Math.min(1,dot)));
      translation=Math.max(translation,Math.hypot(...[0,1,2].map((k)=>actual.pos[k]-e.p[k])));
    }
    rows.push({time,angle,translation});
  }
  const poseAt = (time) => {
    world.set(target[0],AnimationPlayer,{times:[time],weights:[1],paused:true,looping:false}).unwrap();
    world.update(0).unwrap();
    return target.flatMap((j)=>{const t=world.get(j,Transform).unwrap();return [...t.pos,...t.quat,...t.scale];});
  };
  const first=poseAt(0),last=poseAt(baked.duration);
  const seamMaxComponent=Math.max(...first.map((v,i)=>Math.abs(v-last[i])));
  world.set(target[0],AnimationPlayer,{times:[baked.duration-0.01],speeds:[1],paused:false,looping:true}).unwrap();
  world.update(0.02).unwrap();
  const wrapped=target.flatMap((j)=>{const t=world.get(j,Transform).unwrap();return [...t.pos,...t.quat,...t.scale];});
  const wrapTime=world.get(target[0],AnimationPlayer).unwrap().times[0];
  const direct=poseAt(wrapTime);
  const wrapMaxComponent=Math.max(...direct.map((v,i)=>Math.abs(v-wrapped[i])));
  assert(seamMaxComponent<1e-5 && wrapMaxComponent<1e-5);
  const jsonBytes=Buffer.byteLength(JSON.stringify(baked,(_key,v)=>v instanceof Float32Array?[...v]:v));
  const row={fps,bakeMs,channels:baked.channels.length,keys:baked.channels[0].sampler.input.length,jsonUtf8Bytes:jsonBytes,
    maxAngle:Math.max(...rows.map((r)=>r.angle)),maxTranslation:Math.max(...rows.map((r)=>r.translation)),seamMaxComponent,wrapMaxComponent,wrapTime,rows};
  if(fps>=60) {assert(row.maxAngle<report.thresholds.angularRadians); assert(row.maxTranslation<report.thresholds.translation);}
  report.cases.push(row); console.log(JSON.stringify({...row,rows:undefined}));
  await context.fiber.dispose();
}
writeFileSync(resolve(out,'bake-error.json'),JSON.stringify(report,null,2));
