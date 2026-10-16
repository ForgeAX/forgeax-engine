import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {loadRapier3D} from '../../physics-rapier3d/dist/index.mjs';
import {distribution} from './crowd.mjs';
const R=await loadRapier3D(),report={timestamp:new Date().toISOString(),backendHash:createHash('sha256').update(readFileSync(new URL('../../physics-rapier3d/dist/index.mjs',import.meta.url))).digest('hex'),cases:[]};
for(const count of [100,1000])for(const mode of ['global','direct','direct','global']){
 const world=new R.World({x:0,y:0,z:0}),bodies=Array.from({length:count},(_,i)=>{const b=world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(i*2,0,0));world.createCollider(R.ColliderDesc.ball(.3).setTranslation(0,1,0),b);return b;});world.step();const samples=[];
 try{for(let frame=0;frame<120;frame++){const begin=performance.now();for(const b of bodies){const p=b.translation(),c=b.collider(0),q=c.translation();b.setNextKinematicTranslation({x:p.x+.01,y:p.y,z:p.z});b.setTranslation({x:p.x+.01,y:p.y,z:p.z},true);if(mode==='global')world.propagateModifiedBodyPositionsToColliders();else c.setTranslation({x:q.x+.01,y:q.y,z:q.z});}const elapsed=performance.now()-begin;world.step();if(frame>=20)samples.push(elapsed);}for(const b of bodies){const c=b.collider(0);assert.ok(Math.abs(c.translation().x-b.translation().x)<.001);assert.ok(Math.abs(c.translationWrtParent().y-1)<.001);}report.cases.push({count,mode,...distribution(samples),samples});console.log(count,mode,distribution(samples));}finally{world.free();}
}
writeFileSync(new URL('../../../artifacts/roi-navigation/kcc-sync.json',import.meta.url),JSON.stringify(report));
