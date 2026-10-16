import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFileSync,mkdirSync } from 'node:fs';
import { bakeNavigationMesh } from '../../import/dist/navigation-bake.mjs';
import { createNavigationMesh } from '../dist/index.mjs';
import { settings, doorway,lowCeiling,stairs,slope,islands,floor } from './fixtures.mjs';
const report={generatedAt:new Date().toISOString(),cases:[],failures:[]};
const cases=[
  ['door-small',doorway(1.2),settings,[-4,0,0],[4,0,0],true],
  ['door-large',doorway(1.2),{...settings,radius:0.7},[-4,0,0],[4,0,0],false],
  ['clearance-falsifier',doorway(1.2),{...settings,radius:0},[-4,0,0],[4,0,0],true],
  ['ceiling-short',lowCeiling(1.5),{...settings,height:1.2},[-4,0,0],[4,0,0],true],
  ['ceiling-tall',lowCeiling(1.5),settings,[-4,0,0],[4,0,0],false],
  ['stairs-allowed',stairs(0.2),settings,[-4,0,0],[5,1,0],true],
  ['stairs-high',stairs(0.5),settings,[-4,0,0],[5,2.5,0],false],
  ['slope-allowed',slope(20),settings,[-3,3-3*Math.tan(20*Math.PI/180),0],[3,3+3*Math.tan(20*Math.PI/180),0],true],
  ['slope-steep',slope(60),settings,[-1,1.268,0],[1,4.732,0],false],
  ['islands',islands(),settings,[-4,0,0],[4,0,0],false],
];
for(const [name,geometry,s,start,goal,expected] of cases) {
  const begin=performance.now(),baked=await bakeNavigationMesh({geometry,settings:s}),bakeMs=performance.now()-begin;
  let path;
  if(baked.ok) path=createNavigationMesh(baked.value).unwrap().findPath(start,goal,{maxProjection:0.3});
  const success=path?.ok===true;
  const entry={name,bakeMs,sourceDigest:baked.ok?baked.value.sourceDigest:null,settings:s,bakeCode:baked.ok?'ok':baked.error.code,queryCode:path?.ok?'ok':path?.error.code,success,expected,
    mesh:baked.ok?baked.value:null,path:path?.ok?[...path.value.points]:null};
  // Independent geometric oracle: sample the output route and never enter an undersized wall gap.
  if(path?.ok && name.startsWith('door')) {
    for(let i=3;i<path.value.points.length;i+=3)for(let j=0;j<=100;j++) {
      const t=j/100,x=path.value.points[i-3]*(1-t)+path.value.points[i]*t,z=path.value.points[i-1]*(1-t)+path.value.points[i+2]*t;
      assert.ok(Math.abs(x)>0.2+s.radius-0.06||Math.abs(z)<=0.6-s.radius+0.06,'path enters inflated doorway wall');
    }
  }
  report.cases.push(entry);if(success!==expected)report.failures.push(name);
  console.log(name,{success,expected,bakeMs,queryCode:entry.queryCode,bakeCode:entry.bakeCode,polygons:baked.ok?baked.value.polygons.length:0});
}
mkdirSync('artifacts/roi-navigation',{recursive:true});writeFileSync('artifacts/roi-navigation/geometry.json',JSON.stringify(report,null,2));
assert.deepEqual(report.failures,[]);
