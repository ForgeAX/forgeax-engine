import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus,platform,arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { World,createWorldContext } from '../../ecs/dist/index.mjs';
import { Name,Transform } from '../../scene/dist/index.mjs';
import { SceneInstance } from '../../render/dist/index.mjs';
import { AssetRegistry } from '../../assets-runtime/dist/index.mjs';
import { ShaderRegistry } from '../../shader/dist/index.mjs';
import { physicsPlugin } from '../../physics/dist/index.mjs';
import * as navigation from '../dist/index.mjs';
import { bakeNavigationMesh } from '../../import/dist/navigation-bake.mjs';
import { settings,box,floor,doorway,stairs,slope,actor } from './fixtures.mjs';
const output=new URL('../../../artifacts/roi-navigation/',import.meta.url);mkdirSync(output,{recursive:true});
export const distribution=(values)=>{const sorted=[...values].sort((a,b)=>a-b);return {p50:sorted[Math.floor(sorted.length/2)]??0,p95:sorted[Math.floor(sorted.length*0.95)]??0,max:sorted.at(-1)??0};};
// Budgets fixed before the first measurements. Point-follower budgets remain independent.
export const budgets={neighbors1000Ms:10,solver1000Ms:1000/60,world100Ms:1000/60,world1000Ms:100,bakeSmallMs:1000,bakeMediumMs:5000,bakeLargeMs:10000,queryP95Ms:50};
export async function runCrowd({name,geometry=[floor()],starts,goals,frames=1200,trace=true,nav=navigation,instrument=false,bakeSettings={...settings,radius:0.35},scene,avoidanceOptions}={}) {
  const asset=(await bakeNavigationMesh({geometry,settings:bakeSettings})).unwrap(),mesh=nav.createNavigationMesh(asset).unwrap(),world=new World();
  const samples=[],stages={};let accumulated={};
  if(instrument){const wrap=system=>({...system,fn(...args){const start=performance.now();try{return system.fn(...args);}finally{accumulated[system.name]=(accumulated[system.name]??0)+performance.now()-start;}}}),add=world.addSystem.bind(world),adds=world.addSystems.bind(world);world.addSystem=(schedule,system)=>add(schedule,wrap(system));world.addSystems=(schedule,set,systems)=>adds(schedule,set,systems.map(wrap));}
  const ctx=await createWorldContext(world,[physicsPlugin('rapier-3d'),nav.navigationCharacterPlugin(mesh,avoidanceOptions)]);
  const registry=new AssetRegistry(new ShaderRegistry({manifestUrl:undefined}));world.components.register(SceneInstance).unwrap();
  const trajectories=[],heapBefore=process.memoryUsage();let motorMs=0;let minimum=Infinity,overlapFrames=0;
  try {
    const authored=scene??{kind:'scene',entities:Object.fromEntries([...geometry.map((g,i)=>[`geometry-${i}`,{components:g.components}]),...starts.map(([x,z],i)=>[`actor-${i}`,{components:{...actor(x,z).components,Name:{value:String(i)}}}])])};
    registry.instantiateFlat(world.allocSharedRef('SceneAsset',authored),world).unwrap();
    const entities=Array.from(world.query({with:[nav.NavigationCharacter]}).unwrap(),row=>row.entity).sort((a,b)=>Number(world.get(a,Name).unwrap().value)-Number(world.get(b,Name).unwrap().value));
    const latency=[],destinations=[];
    for(let i=0;i<entities.length;i++){const t=performance.now();nav.setNavigationTarget(world,entities[i],goals[i],{maxProjection:0.3}).unwrap();latency.push(performance.now()-t);const path=world.get(entities[i],nav.NavigationAgent).unwrap().path;destinations.push([...path.slice(-3)]);}
    const physics=world.getResource('PhysicsWorld'),move=physics.moveAndSlide.bind(physics);
    if(instrument)physics.moveAndSlide=(...args)=>{const t=performance.now();try{return move(...args);}finally{motorMs+=performance.now()-t;}};
    for(let frame=0;frame<frames;frame++){
      accumulated={};motorMs=0;const start=performance.now();world.update(1/60).unwrap();const elapsed=performance.now()-start;
      if(frame>=30){samples.push(elapsed);for(const [key,value] of Object.entries(accumulated))(stages[key]??=[]).push(value);if(instrument)(stages.moveAndSlide??=[]).push(motorMs);}
      if(trace){const positions=entities.map(e=>[...world.get(e,Transform).unwrap().pos]);const intents=entities.map(e=>{const c=world.get(e,nav.NavigationCharacter).unwrap();return {desired:[...c.desired],actual:[...c.actual],status:world.get(e,nav.NavigationAgent).unwrap().status};});trajectories.push({frame,positions,intents});let overlap=false;for(let i=0;i<positions.length;i++)for(let j=i+1;j<positions.length;j++){const d=Math.hypot(positions[i][0]-positions[j][0],positions[i][2]-positions[j][2]);minimum=Math.min(minimum,d);if(d<0.59)overlap=true;}if(overlap)overlapFrames++;}
    }
    const states=entities.map((e,i)=>{const a=world.get(e,nav.NavigationAgent).unwrap(),p=[...world.get(e,Transform).unwrap().pos];return {id:e,status:a.status,waypoint:a.waypoint,path:[...a.path],stalledFor:world.get(e,nav.NavigationCharacter).unwrap().stalledFor,position:p,requestedDistance:Math.hypot(p[0]-goals[i][0],p[2]-goals[i][2]),distance:Math.hypot(p[0]-destinations[i][0],p[2]-destinations[i][2])};});
    const arrived=states.filter(s=>s.status===nav.NavigationAgentStatus.arrived).length,blocked=states.filter(s=>s.status===nav.NavigationAgentStatus.blocked).length;
    assert.ok(states.every(s=>s.status!==nav.NavigationAgentStatus.arrived||s.distance<=0.081),'actual arrival oracle');
    return {name,agents:entities.length,frames,dt:1/60,instrumented:instrument,settings:bakeSettings,avoidanceOptions:avoidanceOptions??{neighborDistance:4,maxNeighbors:16,horizon:1.5,maxCandidates:128},asset,geometry:geometry.map(g=>g.components),starts,goals,destinations,states,arrived,blocked,arrivalRate:arrived/entities.length,stuckRate:blocked/entities.length,minimumSeparation:minimum,overlapFrames,queryLatency:{...distribution(latency),samples:latency},fullWorld:{...distribution(samples),samples},stages:Object.fromEntries(Object.entries(stages).map(([k,v])=>[k,{...distribution(v),samples:v}])),memory:{before:heapBefore,after:process.memoryUsage()},trajectories};
  }finally{await ctx.fiber.dispose();}
}
export async function effectCases(nav=navigation){
  const crossStarts=[[-3,-0.6],[-3,0.6],[3,-0.6],[3,0.6],[-0.6,-3],[0.6,-3],[-0.6,3],[0.6,3]];
  const doorStarts=Array.from({length:12},(_,i)=>[i<6?-3.4-(i%3)*0.8:3.4+(i%3)*0.8,(Math.floor(i/3)%2)*1.2-0.6]);
  const specifications=[
    {name:'head-on',starts:[[-2,0],[2,0]],goals:[[2,0,0],[-2,0,0]],frames:600},
    {name:'crossing',starts:crossStarts,goals:crossStarts.map(([x,z])=>[-x,0,-z])},
    {name:'narrow-door',geometry:doorway(1.6),starts:doorStarts,goals:doorStarts.map(([x,z])=>[-x,0,-z]),frames:1800},
    {name:'wall-corner',geometry:[floor(),box(0.4,3,5,0,1.5,-1)],starts:[[-3,-3]],goals:[[3,0,3]],frames:1200},
    {name:'stairs',geometry:stairs(0.2),starts:[[-4,0]],goals:[[5,1,0]],frames:1200},
    {name:'slope',geometry:slope(20),starts:[[-3,0]],goals:[[3,3+3*Math.tan(Math.PI/9)+.1/Math.cos(Math.PI/9),0]],frames:1200,scene:{kind:'scene',entities:{ramp:{components:slope(20)[0].components},'actor-0':{components:{...actor(-3).components,Name:{value:'0'},Transform:{pos:[-3,3-3*Math.tan(Math.PI/9)+.1/Math.cos(Math.PI/9)+.82,0]}}}}}},
  ];const cases=[];for(const spec of specifications){const result=await runCrowd({...spec,nav});cases.push(result);console.log(spec.name,JSON.stringify({arrived:result.arrived,blocked:result.blocked,minimum:result.minimumSeparation,overlapFrames:result.overlapFrames,p95:result.fullWorld.p95}));writeFileSync(new URL(`effect-${spec.name}.json`,output),JSON.stringify(result));}return cases;
}
if(process.argv[1]===new URL(import.meta.url).pathname){const report={timestamp:new Date().toISOString(),hardware:{cpu:cpus()[0].model,platform:platform(),arch:arch(),node:process.version},budgets,sourceDigest:createHash('sha256').update(readFileSync(new URL('../dist/index.mjs',import.meta.url))).digest('hex'),cases:process.argv.includes('--single-file')?[await runCrowd({name:'narrow-door-single-file',geometry:doorway(1.6),starts:[[-3,0],[-4,0],[-5,0],[3,0],[4,0],[5,0]],goals:[[3,0,0],[4,0,0],[5,0,0],[-3,0,0],[-4,0,0],[-5,0,0]],frames:1800})]:await effectCases()};writeFileSync(new URL(process.argv.includes('--single-file')?'effect-door-single-file.json':'effects.json',output),JSON.stringify(process.argv.includes('--single-file')?report.cases[0]:report));const failed=report.cases.filter(c=>c.arrived!==c.agents||c.overlapFrames>0);if(failed.length)throw new Error(`Effect gates failed: ${failed.map(c=>c.name)}`);}
