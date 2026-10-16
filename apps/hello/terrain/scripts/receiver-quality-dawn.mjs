import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { Camera, DEFAULT_STANDARD_PROFILE, DirectionalLight, DirectionalShadowFilterValue, Materials, MeshFilter, MeshRenderer, ShadowParticipation } from '@forgeax/engine-render';
import { Mobility, MobilityKindValue, Transform } from '@forgeax/engine-scene';
import { createSphereGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import { Terrain } from '@forgeax/engine-terrain';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { writeReferencePng } from '../../../shared/png-codec.mjs';
import { terrainHarness } from './harness.mjs';

const dir = resolve(process.env.TERRAIN_RECEIVER_ARTIFACT_DIR ?? resolve(import.meta.dirname, '../.forgeax-debug/receiver-quality'));
mkdirSync(dir, { recursive: true });
const rootDir = resolve(import.meta.dirname, '../../../..');
const report = { status: 'RUNNING', sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim(), cases: [],
  producingShaderInputs: JSON.parse(readFileSync(resolve(rootDir, 'shared-build-inputs/manifest.json'), 'utf8')).shaderBuild,
  failures: [], captures: [],
  budgets: { unoccludedPlanePeakByteDifference: 2, minimumCoveredPixels: 2000, casterMinimumChangedChannels: 100, casterMinimumPeakByteDifference: 10, packedNormalAngularErrorRadians: 0.002 },
  boundary: 'Real cooked Terrain, real directional writers/receivers, original depth/normal bias, 60 completed warmup frames per cell. The Ng carrier is primitive-derived with 12-bit oct quantization. Performance is a separate exclusive-window gate.' };
const save = () => writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
const difference = (a, b) => {
  let changedChannels = 0, peakByteDifference = 0, sum = 0;
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) {
    const delta = Math.abs(a[i] - b[i]); sum += delta;
    peakByteDifference = Math.max(peakByteDifference, delta); if (delta > 2) changedChannels++;
  }
  return { changedChannels, peakByteDifference, meanByteDifference: sum / ((a.length / 4) * 3) };
};
try {
  for (const renderPath of ['forward', 'deferred']) {
    const recorder = attachRecorder(webgpu).unwrap();
    const h = await terrainHarness({ width: 640, height: 480, backendArgs: ['backend=metal'], appOptions: { rhi: recorder.backend.rhi,
      standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath, ssao: false } } });
    const capture = async (name, refreshTerrainProducer = true) => {
      // Refresh the real caster from a different resident topology. This makes
      // the selected tape contain its producer, not only a cached depth seed.
      if (refreshTerrainProducer) {
        h.app.world.set(h.subjects.terrain, Terrain, { forcedLod: 0 }).unwrap();
        await h.frame();
        h.app.world.set(h.subjects.terrain, Terrain, { forcedLod: 2 }).unwrap();
      }
      const pending = recorder.captureFrame(); (await recorder.frameBoundary()).unwrap(); await h.frame(); (await recorder.frameBoundary()).unwrap();
      const tape = (await pending).unwrap(); writeFileSync(resolve(dir, `${name}.rhitape`), tape.bytes);
      const model = buildFrameModel(decodeTape(tape.bytes).unwrap());
      const terrain = model.works.filter((w) => w.pipeline.shaders.some((s) => s.source?.includes('fn terrainDecodeHeight')));
      assert(terrain.length > 0, 'the capture must execute the real Terrain shader');
      if (refreshTerrainProducer) assert(terrain.some((w) => w.pipeline.shaders.some((s) => s.entryPoint === 'fs_shadow')), 'the tape must contain the real Terrain shadow producer');
      else assert(model.works.some((w) => w.kind === 'drawIndexedIndirect' && w.pipeline.shaders.some((s) => s.entryPoint === 'fs_shadow')), 'contact capture must execute the actual static Standard shadow producer');
      if (renderPath === 'deferred') assert(terrain.some((w) => w.pipeline.shaders.some((s) => s.entryPoint === 'fs_gbuffer') && w.attachments?.colorViewHandleIds.length === 6), 'Deferred must publish six actual GBuffer targets');
      const receivers = (renderPath === 'deferred' ? model.works : terrain).filter((work) => (work.attachments?.colorViewHandleIds.length ?? 0) > 0
        && work.pipeline.shaders.some((shader) => shader.entryPoint === (renderPath === 'deferred' ? 'fs_standard_deferred' : 'fs_opaque')))
        .flatMap((work) => work.pipeline.shaders.filter((shader) => shader.stage === 'fragment').map((shader) => ({ workIndex: work.workIndex, source: shader.source })));
      const actualBiasHelpers = receivers.flatMap(({ workIndex, source }) => {
        const helper = source?.match(/fn _directionalReceiverDepthBias[^]*?\n}\n/)?.[0];
        if (helper === undefined) return [];
        assert(/min\(1\.0000001f?,/.test(helper) && helper.includes('missingCoverage'), 'real production tape must execute the final stable total-bias kernel');
        return [{ workIndex, shaderSha256: createHash('sha256').update(source).digest('hex'), biasHelperSha256: createHash('sha256').update(helper).digest('hex') }];
      });
      assert(actualBiasHelpers.length > 0, 'the selected tape must include a real directional receiver');
      report.captures.push({ name, digest: tape.digest, bytes: tape.bytes.length, workCount: model.works.length,
        actualBiasHelpers,
        terrainWorks: terrain.map((w) => ({ index: w.workIndex, shaders: w.pipeline.shaders.map((s) => s.entryPoint), attachments: w.attachments, indexBuffer: w.indexBuffer })) });
      const bytes = await h.pixels();
      writeFileSync(resolve(dir, `${name}.png`), writeReferencePng(bytes, 640, 480));
      return bytes;
    };
    try {
      const eye = [11, 16, 14];
      h.app.world.set(h.subjects.camera, Transform, { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [3.5, 3.5, 3.5], [0, 1, 0]) }).unwrap();
      h.app.world.set(h.subjects.camera, Camera, { near: 0.1, far: 40, aspect: 640 / 480 }).unwrap();
      h.app.world.set(h.subjects.walker, Transform, { pos: [-100, -100, -100] }).unwrap();
      const lights = [...h.app.world.query({ read: [DirectionalLight] }).unwrap()]; assert.equal(lights.length, 1);
      const light = lights[0].entity;
      for (const prefix of ['', 'orientation/']) {
        const guid = AssetGuid.derive(definePackageId('019fcaf0-0000-7000-8000-000000000001'), prefix + 'terrain');
        const root = (await h.app.assets.loadByGuid(guid)).unwrap(); assert.equal(root.kind, 'terrain'); assert(h.app.assets.terrainClosureCurrent(root));
        const handle = h.app.world.sharedRefs.acquire('TerrainAsset', root);
        h.app.world.set(h.subjects.terrain, Terrain, { asset: handle, forcedLod: 2 }).unwrap(); h.app.world.sharedRefs.release(handle).unwrap();
        for (const [filter, shadowFilter] of [['pcf1', DirectionalShadowFilterValue.pcf1], ['pcf3', DirectionalShadowFilterValue.pcf3], ['pcf5', DirectionalShadowFilterValue.pcf5]]) {
          for (const phase of [0, 0.04, 0.12]) {
            const name = `${renderPath}-${prefix ? 'opposed-ba' : 'vertical-ba'}-${filter}-${phase}`;
            h.app.world.set(h.subjects.terrain, Transform, { pos: [phase, 0, phase * 0.3] }).unwrap();
            h.app.world.set(light, DirectionalLight, { direction: [0, -1, 0], color: [1, 1, 1], intensity: 3, mapSize: 512, shadowFilter, castShadow: true }).unwrap();
            const before = h.completed; for (let i = 0; i < 60; i++) await h.frame();
            const on = filter === 'pcf3' && phase === 0 ? await capture(name) : await h.pixels();
            h.app.world.set(light, DirectionalLight, { castShadow: false }).unwrap(); await h.frame(); const off = await h.pixels();
            let covered = 0; for (let i = 0; i < off.length; i += 4) if (off[i] + off[i + 1] + off[i + 2] > 30) covered++;
            const delta = difference(on, off); report.cases.push({ name, completedWarmupFrames: 60, completedCaseFrames: h.completed - before, coveredPixels: covered, ...delta }); save();
            assert(covered >= report.budgets.minimumCoveredPixels, 'black/cull-only comparisons never pass');
            if (delta.peakByteDifference > report.budgets.unoccludedPlanePeakByteDifference) report.failures.push(`${name}: unoccluded plane ${JSON.stringify(delta)}`);
            if (filter === 'pcf3' && phase === 0) { writeFileSync(resolve(dir, `${name}.png`), writeReferencePng(on, 640, 480)); writeFileSync(resolve(dir, `${name}-reference.png`), writeReferencePng(off, 640, 480)); }
          }
        }
      }
      // The 12-bit oct carrier can move n.L across the old 0.01 bias guard.
      // Exercise both tangent directions, since oct quantization can move
      // the receiver cosine to either side of the original guard.
      const grazingRoot = (await h.app.assets.loadByGuid(AssetGuid.derive(definePackageId('019fcaf0-0000-7000-8000-000000000001'), 'terrain'))).unwrap();
      const grazingHandle = h.app.world.sharedRefs.acquire('TerrainAsset', grazingRoot);
      h.app.world.set(h.subjects.terrain, Terrain, { asset: grazingHandle, forcedLod: 2 }).unwrap();
      h.app.world.sharedRefs.release(grazingHandle).unwrap();
      h.app.world.set(h.subjects.terrain, Transform, { pos: [0, 0, 0] }).unwrap();
      for (const tangentSign of [-1, 1]) {
      for (const [filter, shadowFilter] of [['pcf3', DirectionalShadowFilterValue.pcf3], ['pcf5', DirectionalShadowFilterValue.pcf5]]) {
      for (const cosine of [0.0099, 0.0101, 0.0104]) {
        const direction = [cosine * Math.SQRT1_2, -cosine * Math.SQRT1_2, tangentSign * Math.sqrt(1 - cosine * cosine)];
        h.app.world.set(light, DirectionalLight, { direction, intensity: 300, castShadow: true, shadowFilter }).unwrap();
        for (let i = 0; i < 60; i++) await h.frame();
        const name = `${renderPath}-grazing-${filter}-${tangentSign}-${cosine}`;
        const on = await capture(name);
        h.app.world.set(light, DirectionalLight, { castShadow: false }).unwrap(); await h.frame();
        const off = await h.pixels(); const delta = difference(on, off);
        writeFileSync(resolve(dir, `${name}.png`), writeReferencePng(on, 640, 480));
        writeFileSync(resolve(dir, `${name}-reference.png`), writeReferencePng(off, 640, 480));
        report.cases.push({ name, filter, cosine, tangentSign, intensity: 300, completedWarmupFrames: 60, ...delta }); save();
        if (delta.peakByteDifference > report.budgets.unoccludedPlanePeakByteDifference) report.failures.push(`${name}: unoccluded grazing plane ${JSON.stringify(delta)}`);
      }
      }
      }
      h.app.world.set(light, DirectionalLight, { direction: [0, -1, 0], intensity: 3 }).unwrap();
      // A real overhead sphere must still cast onto the fixed receiver plane.
      h.app.world.set(h.subjects.terrain, Transform, { pos: [0, 0, 0] }).unwrap();
      h.app.world.set(h.subjects.walker, Transform, { pos: [3.5, 7, 3.5] }).unwrap();
      h.app.world.set(light, DirectionalLight, { castShadow: true, shadowFilter: DirectionalShadowFilterValue.pcf3 }).unwrap();
      for (let i = 0; i < 60; i++) await h.frame();
      const on = await capture(`${renderPath}-real-caster`);
      h.app.world.addComponent(h.subjects.walker, { component: ShadowParticipation, data: { cast: false, receive: true } }).unwrap();
      await h.frame(); const off = await h.pixels(); const delta = difference(on, off);
      report.cases.push({ name: `${renderPath}-real-caster`, ...delta }); save();
      assert(delta.changedChannels >= report.budgets.casterMinimumChangedChannels && delta.peakByteDifference >= report.budgets.casterMinimumPeakByteDifference, 'a real caster must retain an actual shadow');
      writeFileSync(resolve(dir, `${renderPath}-real-caster.png`), writeReferencePng(on, 640, 480));
      writeFileSync(resolve(dir, `${renderPath}-caster-disabled.png`), writeReferencePng(off, 640, 480));
      for (const tangentSign of [-1, 1]) {
        const cosine = 0.0099, distance = 150;
        const l = [-cosine * Math.SQRT1_2, cosine * Math.SQRT1_2, -tangentSign * Math.sqrt(1 - cosine * cosine)];
        const position = [3.5 + l[0] * distance, 3.5 + l[1] * distance, 3.5 + l[2] * distance];
        // The actual radius-one sphere lies 1.485m above the receiver plane,
        // so the caster does not intersect it or hide the receiver in color.
        h.app.world.set(h.subjects.walker, Transform, { pos: position }).unwrap();
        h.app.world.set(h.subjects.walker, ShadowParticipation, { cast: true }).unwrap();
        h.app.world.set(light, DirectionalLight, { direction: l.map((value) => -value), intensity: 300, castShadow: true, shadowFilter: DirectionalShadowFilterValue.pcf3 }).unwrap();
        for (let i = 0; i < 60; i++) await h.frame();
        const name = `${renderPath}-grazing-real-caster-${tangentSign}`;
        const on = await capture(name);
        h.app.world.set(h.subjects.walker, ShadowParticipation, { cast: false }).unwrap();
        await h.frame(); const off = await h.pixels(); const delta = difference(on, off);
        writeFileSync(resolve(dir, `${name}.png`), writeReferencePng(on, 640, 480));
        writeFileSync(resolve(dir, `${name}-reference.png`), writeReferencePng(off, 640, 480));
        report.cases.push({ name, cosine, tangentSign, casterPosition: position, casterRadius: 1, receiverNormalClearance: cosine * distance, completedWarmupFrames: 60, ...delta }); save();
        if (delta.changedChannels < report.budgets.casterMinimumChangedChannels || delta.peakByteDifference < report.budgets.casterMinimumPeakByteDifference)
          report.failures.push(`${name}: grazing real caster shadow missing ${JSON.stringify(delta)}`);
      }
      // Real static Standard spheres touch the flat author cells or leave
      // a five-centimetre gap. Filter changes keep their World pose fixed.
      const contactHandle=h.app.world.sharedRefs.acquire('TerrainAsset',grazingRoot);
      h.app.world.set(h.subjects.terrain,Terrain,{asset:contactHandle,forcedLod:0}).unwrap();h.app.world.sharedRefs.release(contactHandle).unwrap();
      h.app.world.set(h.subjects.terrain,Transform,{pos:[0,0,0]}).unwrap();
      h.app.world.set(light,DirectionalLight,{direction:[0,-1,0],intensity:3,mapSize:512,castShadow:true}).unwrap();
      for(const gap of [0,0.05]) {
        const mesh=h.app.world.sharedRefs.acquire('MeshAsset',createSphereGeometry(1,24,16).unwrap());
        const material=h.app.world.sharedRefs.acquire('MaterialAsset',Materials.standard({baseColor:[0.8,0.2,0.04,1],roughness:0.8}));
        const caster=h.app.world.spawn(
          {component:Transform,data:{pos:[1.5,1+gap,3.5]}},
          {component:Mobility,data:{kind:MobilityKindValue.static}},
          {component:MeshFilter,data:{assetHandle:mesh}},
          {component:MeshRenderer,data:{materials:[material]}},
          {component:ShadowParticipation,data:{cast:true,receive:false}},
        ).unwrap();
        h.app.world.sharedRefs.release(mesh).unwrap();h.app.world.sharedRefs.release(material).unwrap();
        try {
          for(const [filter,shadowFilter] of [['pcf3',DirectionalShadowFilterValue.pcf3],['pcf5',DirectionalShadowFilterValue.pcf5]]) {
            h.app.world.set(light,DirectionalLight,{shadowFilter}).unwrap();
            h.app.world.set(caster,ShadowParticipation,{cast:true}).unwrap();
            for(let i=0;i<60;i++)await h.frame();
            h.app.world.set(caster,ShadowParticipation,{cast:false}).unwrap();await h.frame();
            h.app.world.set(caster,ShadowParticipation,{cast:true}).unwrap();
            const name=`${renderPath}-contact-caster-${filter}-${gap}`;
            const on=await capture(name,false);
            h.app.world.set(caster,ShadowParticipation,{cast:false}).unwrap();await h.frame();
            const off=await h.pixels();const delta=difference(on,off);
            writeFileSync(resolve(dir,`${name}-reference.png`),writeReferencePng(off,640,480));
            report.cases.push({name,gap,casterRadius:1,casterPosition:[1.5,1+gap,3.5],casterMobility:'static',completedWarmupFrames:60,...delta});save();
            if(delta.changedChannels<report.budgets.casterMinimumChangedChannels||delta.peakByteDifference<report.budgets.casterMinimumPeakByteDifference)report.failures.push(`${name}: near-contact real caster shadow missing ${JSON.stringify(delta)}`);
          }
        }finally{h.app.world.despawn(caster).unwrap();}
      }
      assert.deepEqual(h.errors, []);
    } catch (error) {
      (report.ownerFailures ??= []).push({ renderPath, completedFrames: h.completed, events: h.errors, inspection: h.app.renderer.inspect(),
        failure: { message: String(error), code: error.code, detail: error.detail } });
      save();
      throw error;
    } finally { await h.dispose(); (await recorder.dispose()).unwrap(); }
  }
  assert.deepEqual(report.failures, [], 'all frozen receiver quality budgets must pass');
  report.status = 'PASS'; save(); console.log(JSON.stringify(report, null, 2));
} catch (error) { report.status = 'FAIL'; report.failure = String(error); save(); throw error; }
process.exit(0);
