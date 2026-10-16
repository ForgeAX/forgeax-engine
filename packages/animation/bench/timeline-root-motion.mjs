import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { AnimationPlayer, AnimationRootMotion, AnimationTargetId, bindAnimationTargets, animationPlugin, drainAnimationEvents, deriveAnimationTargetId } from '../dist/index.mjs';

const targetId = deriveAnimationTargetId(['Root']);
const out = resolve(process.env.ANIMATION_EVIDENCE ?? 'artifacts/g12-g30');
mkdirSync(out,{recursive:true});
const report = { head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), hardware:cpus()[0]?.model, platform:`${platform()} ${release()}`, node:process.version, dt:1/60, warmup:60, samples:300, cases:[] };
function stats(values) {
  const ordered = [...values].sort((a,b)=>a-b);
  return Object.fromEntries([['p50',0.5],['p95',0.95],['p99',0.99]].map(([key,p])=>[key,ordered[Math.floor(p*(ordered.length-1))]]));
}
for (const count of [100,1000]) {
  // ABBA reduces, but cannot remove, host contention and thermal drift.
  for (const mode of ['baseline','both','both','baseline','events','motion']) {
    const world = new World();
    const context = await createWorldContext(world,[animationPlugin()]);
    const source = {kind:'animation-clip',duration:1,channels:[{targetId,property:'translation',sampler:{input:new Float32Array([0,1]),output:new Float32Array([0,0,0,2,0,0]),interpolation:'LINEAR'}}],
      ...(mode==='both'||mode==='events' ? {events:[0.25,0.75].map(time=>({time,targetId,action:{kind:'method',name:'footstep',args:[]}}))}: {})};
    const clip = world.allocSharedRef('AnimationClip',source);
    const players=[];
    for (let i=0;i<count;i++) {
      const player=world.spawn({component:AnimationPlayer,data:{clips:[clip],times:[0],speeds:[1],weights:[1]}},
        ...(mode==='both'||mode==='motion' ? [{component:AnimationRootMotion,data:{targetId}}]:[])).unwrap();
      const target=world.spawn({component:Transform,data:{}},{component:ChildOf,data:{parent:player}},{component:AnimationTargetId,data:{value:targetId}}).unwrap();
      bindAnimationTargets(world,player,[target]).unwrap(); players.push(player);
    }
    const rawMs=[]; let eventCount=0;
    for (let frame=0;frame<report.warmup+report.samples;frame++) {
      const start=performance.now(); world.update(report.dt).unwrap();
      for (const player of players) eventCount+=drainAnimationEvents(world,player).length;
      if (frame>=report.warmup) rawMs.push(performance.now()-start);
    }
    if (mode==='both'||mode==='motion') {
      for (const player of players) assert(Math.abs(world.get(player,AnimationRootMotion).unwrap().accumulatedPosition[0]-12)<1e-4,'root motion drift exceeds 1e-4');
    }
    if (mode==='both'||mode==='events') assert.equal(eventCount,count*12,'missed/duplicated footstep key');
    const row={count,mode,eventCount,ms:stats(rawMs),rawMs}; report.cases.push(row);
    console.log(JSON.stringify({...row,rawMs:undefined}));
    await context.fiber.dispose();
  }
}
writeFileSync(resolve(out,'cpu-performance.json'),JSON.stringify(report,null,2));
