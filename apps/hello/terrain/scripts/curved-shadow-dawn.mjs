import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { DEFAULT_STANDARD_PROFILE, DirectionalLight, DirectionalShadowFilterValue, MeshRenderer } from '@forgeax/engine-render';
import { Terrain } from '@forgeax/engine-terrain';
import { writeReferencePng } from '../../../shared/png-codec.mjs';
import { terrainHarness } from './harness.mjs';

const root = resolve(import.meta.dirname, '../../../..');
const dir = resolve(process.env.TERRAIN_CURVED_SHADOW_DIR ?? resolve(import.meta.dirname, '../.forgeax-debug/curved-shadow'));
mkdirSync(dir, { recursive: true });
const report = {
  status: 'RUNNING',
  producingHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  receiverSourceSha256: createHash('sha256').update(readFileSync(resolve(root, 'packages/shader/src/lighting-directional.wgsl'))).digest('hex'),
  renderBuildSha256: createHash('sha256').update(readFileSync(resolve(root, 'packages/render/dist/index.mjs'))).digest('hex'),
  boundary: 'Same curved author asset, camera, LOD policy and material. Only the directional castShadow flag changes. Shadow differences can include legitimate self-occlusion; screenshots require visual assessment and tape replay for cause attribution.',
  budgets: { unoccludedCurvedPeakByteDifference: 2 },
  failures: [],
  cases: [],
};
const save = () => writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
const difference = (a,b) => {
  let changed=0, peak=0, sum=0;
  for (let i=0;i<a.length;i++) if (i%4!==3) {
    const d=Math.abs(a[i]-b[i]);sum+=d;peak=Math.max(peak,d);if(d>2)changed++;
  }
  return { changedChannels:changed, peakByteDifference:peak, meanByteDifference:sum/(960*540*3) };
};
try {
  for (const renderPath of ['forward','deferred']) {
  for (const [filter,shadowFilter] of [['pcf1',DirectionalShadowFilterValue.pcf1],['pcf3',DirectionalShadowFilterValue.pcf3],['pcf5',DirectionalShadowFilterValue.pcf5]]) {
    const recorder=attachRecorder(webgpu).unwrap();
    const h=await terrainHarness({width:960,height:540,backendArgs:['backend=metal'],appOptions:{rhi:recorder.backend.rhi,standardProfile:{...DEFAULT_STANDARD_PROFILE,renderPath,ssao:false}}});
    const capture=async name => {
      const pending=recorder.captureFrame();(await recorder.frameBoundary()).unwrap();await h.frame();(await recorder.frameBoundary()).unwrap();
      const tape=(await pending).unwrap();writeFileSync(resolve(dir,name+'.rhitape'),tape.bytes);
      const pixels=await h.pixels();writeFileSync(resolve(dir,name+'.png'),writeReferencePng(pixels,960,540));
      const model=buildFrameModel(decodeTape(tape.bytes).unwrap());
      const terrain=model.works.filter(work=>work.pipeline.shaders.some(shader=>shader.source?.includes('fn terrainDecodeHeight')));
      assert(terrain.length>0,'actual curved terrain must draw');
      const facts={name,digest:tape.digest,tapeBytes:tape.bytes.byteLength,unseededResources:model.unseededResources,inspection:h.app.renderer.inspect(),terrainWorks:terrain.map(work=>({workIndex:work.workIndex,shaders:work.pipeline.shaders.map(shader=>shader.entryPoint),vertexBuffers:work.vertexBuffers,indexBuffer:work.indexBuffer,bindings:work.bindings,attachments:work.attachments}))};
      return {pixels,facts};
    };
    try {
      const lights=[...h.app.world.query({read:[DirectionalLight]}).unwrap()];assert.equal(lights.length,1);
      h.app.world.set(lights[0].entity,DirectionalLight,{shadowFilter}).unwrap();
      for (const lod0Diameter of [0.35,1.2]) {
        h.app.world.set(h.subjects.terrain,Terrain,{forcedLod:-1,lod0Diameter}).unwrap();
        h.app.world.set(lights[0].entity,DirectionalLight,{castShadow:true}).unwrap();
        for(let i=0;i<60;i++)await h.frame();
        const on=await capture(`${renderPath}-${filter}-${lod0Diameter}-shadow-on`);
        h.app.world.set(lights[0].entity,DirectionalLight,{castShadow:false}).unwrap();
        for(let i=0;i<60;i++)await h.frame();
        const off=await capture(`${renderPath}-${filter}-${lod0Diameter}-shadow-off`);
        assert.deepEqual(h.errors,[]);
        report.cases.push({renderPath,filter,lod0Diameter,completedWarmupFramesPerControl:60,difference:difference(on.pixels,off.pixels),on:on.facts,off:off.facts});save();
      }
      h.app.world.removeComponent(h.subjects.walker,MeshRenderer).unwrap();
      h.app.world.set(lights[0].entity,DirectionalLight,{direction:[0,-1,0]}).unwrap();
      // A heightfield has no overhang. With vertical incident light and no
      // other caster, every actual curved triangle is unoccluded along +Y.
      // Reuse the preregistered plane 2/255 budget, without flattening geometry.
      for (const lod0Diameter of [0.35,1.2]) {
        h.app.world.set(h.subjects.terrain,Terrain,{forcedLod:-1,lod0Diameter}).unwrap();
        h.app.world.set(lights[0].entity,DirectionalLight,{castShadow:true}).unwrap();
        for(let i=0;i<60;i++)await h.frame();
        const on=await capture(`${renderPath}-${filter}-${lod0Diameter}-vertical-on`);
        h.app.world.set(lights[0].entity,DirectionalLight,{castShadow:false}).unwrap();
        for(let i=0;i<60;i++)await h.frame();
        const off=await capture(`${renderPath}-${filter}-${lod0Diameter}-vertical-off`);
        assert.deepEqual(h.errors,[]);
        const delta=difference(on.pixels,off.pixels);
        report.cases.push({renderPath,filter,lod0Diameter,lightDirection:[0,-1,0],independentCaster:false,completedWarmupFramesPerControl:60,difference:delta,on:on.facts,off:off.facts});
        if(delta.peakByteDifference>report.budgets.unoccludedCurvedPeakByteDifference)report.failures.push(`${renderPath}-${filter}-${lod0Diameter}-vertical: ${JSON.stringify(delta)}`);
        save();
      }
    } finally {await h.dispose();(await recorder.dispose()).unwrap();}
  }
  }
  report.status=report.failures.length ? 'FAIL' : 'PASS';save();console.log(JSON.stringify({status:report.status,cases:report.cases.map(row=>({renderPath:row.renderPath,lod0Diameter:row.lod0Diameter,difference:row.difference}))}));
  assert.deepEqual(report.failures,[],'unoccluded curved receiver must satisfy the original 2/255 budget');
} catch(error) {report.status='FAIL';report.error=String(error);save();throw error;}
