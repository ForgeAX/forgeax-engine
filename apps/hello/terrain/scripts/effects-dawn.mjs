import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Disabled } from '@forgeax/engine-ecs';
import {
  Camera,
  DEFAULT_STANDARD_PROFILE,
  Fog,
  Materials,
  MeshRenderer,
  ProjectedDecal,
  querySubmittedTerrainHeight,
  ScreenSpaceReflection,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { Terrain, terrainHeight } from '@forgeax/engine-terrain';
import { writeReferencePng } from '../../../shared/png-codec.mjs';
import { terrainHarness } from './harness.mjs';
import { terrainReloadPolicy } from '../src/reload-policy.ts';
import { installTerrainWalker } from '../src/walker.ts';

const dir = resolve(import.meta.dirname, '../.forgeax-debug/effects');
const rootDir = resolve(import.meta.dirname, '../../../..');
const git = (revision) =>
  execFileSync('git', ['rev-parse', revision], { cwd: rootDir, encoding: 'utf8' }).trim();
const hashFile = (path) => createHash('sha256').update(readFileSync(resolve(rootDir, path))).digest('hex');
const ssrIdentity = {
  sourceHead: git('HEAD'),
  sourceTree: git('HEAD^{tree}'),
  lockSha256: hashFile('pnpm-lock.yaml'),
  buildSha256: hashFile('packages/render/dist/index.mjs'),
};
mkdirSync(dir, { recursive: true });
const report = {
  status: 'RUNNING',
  cases: [],
  evidenceBoundary:
    'Real Dawn raster frames and recorded work/resource facts. Visual assessment and fresh-device replay are separate gates.',
};
const shader = (work, text) => work.pipeline.shaders.some((s) => s.source?.includes(text));
const difference = (a, b) => {
  let sum = 0,
    peak = 0,
    changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const delta = Math.abs(a[i] - b[i]);
    sum += delta;
    peak = Math.max(peak, delta);
    if (delta > 2) changed++;
  }
  return {
    meanByteDifference: sum / ((a.length / 4) * 3),
    peakByteDifference: peak,
    changedChannels: changed,
  };
};
try {
  for (const renderPath of ['forward', 'deferred']) {
    const recorder = attachRecorder(webgpu).unwrap();
    const h = await terrainHarness({
      width: 960,
      height: 540,
      backendArgs: ['backend=metal'],
      appOptions: {
        rhi: recorder.backend.rhi,
        ssrIdentity,
        standardProfile: {
          ...DEFAULT_STANDARD_PROFILE,
          renderPath,
          ssao: renderPath === 'deferred',
        },
      },
    });
    const capture = async (name) => {
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const { receipt } = await h.frame();
      (await recorder.frameBoundary()).unwrap();
      const recorded = (await pending).unwrap();
      writeFileSync(resolve(dir, `${name}.rhitape`), recorded.bytes);
      const model = buildFrameModel(decodeTape(recorded.bytes).unwrap());
      const terrain = model.works.filter((w) => shader(w, 'fn terrainDecodeHeight'));
      assert(terrain.length > 0, 'the real frame must draw displaced terrain');
      assert(
        terrain.some(
          (w) => w.attachments !== null && w.attachments.depthStencilViewHandleId !== null,
        ),
        'terrain must write depth',
      );
      const vertex = new Set(
        terrain.flatMap((w) =>
          w.vertexBuffers.filter((v) => v.slot === 0).map((v) => v.bufferHandleId),
        ),
      );
      const indices = new Set(
        terrain.flatMap((w) => (w.indexBuffer === null ? [] : [w.indexBuffer.bufferHandleId])),
      );
      const pixels = await h.pixels();
      writeFileSync(resolve(dir, `${name}.png`), writeReferencePng(pixels, 960, 540));
      const proof = {
        name,
        digest: recorded.digest,
        tapeBytes: recorded.bytes.byteLength,
        workCount: model.works.length,
        terrainWorks: terrain.map((w) => ({
          workIndex: w.workIndex,
          shaders: w.pipeline.shaders.map((s) => s.entryPoint),
          vertexBuffers: w.vertexBuffers,
          indexBuffer: w.indexBuffer,
          attachments: w.attachments,
        })),
        physicalVertexBuffers: [...vertex],
        physicalIndexBuffers: [...indices],
        unseededResources: model.unseededResources,
        inspection: h.app.renderer.inspect(),
        pixels: await h.verify(receipt),
      };
      report.cases.push(proof);
      writeFileSync(resolve(dir, `${name}.json`), JSON.stringify(proof, null, 2));
      return { proof, pixels, model, receipt };
    };
    try {
      h.app.world.set(h.subjects.terrain, Terrain, { forcedLod: -1, lod0Diameter: 1.2 }).unwrap();
      for (let i = 0; i < 60; i++) await h.frame();
      const base = await capture(`${renderPath}-base`);
      assert.equal(
        base.proof.physicalVertexBuffers.length,
        1,
        'mixed terrain LODs share one physical rule-grid vertex buffer',
      );
      assert(
        base.proof.physicalIndexBuffers.length >= 2,
        'the real scene must execute at least two distinct terrain LOD index buffers',
      );
      // Delay a real accepted-frame query across actual fixed-step collider withdrawal.
      let releaseQuery;
      let delayQuery = true;
      let latestReceipt = base.receipt;
      const policy = terrainReloadPolicy(
        h.app.world,
        h.app.assets,
        h.subjects.terrain,
        async (request) => {
          const answer = await querySubmittedTerrainHeight(latestReceipt, request);
          if (!delayQuery) return answer;
          return await new Promise((resolve) => {
            releaseQuery = () => resolve(answer);
          });
        },
      );
      const stopWalker = installTerrainWalker(h.app.world, h.subjects, policy.gate);
      try {
        const walker = h.app.world.getResource('TerrainWalker');
        walker.speed = 1;
        latestReceipt = (await h.frame()).receipt;
        assert.equal(typeof releaseQuery, 'function');
        const before = Array.from(h.app.world.get(h.subjects.walker, Transform).unwrap().pos);
        const updates = walker.updates;
        h.app.world.addComponent(h.subjects.terrain, { component: Disabled, data: {} }).unwrap();
        latestReceipt = (await h.frame()).receipt;
        assert.deepEqual(
          h.app.physics.getDerivedPublication(h.subjects.terrain)?.shapeIds ?? [],
          [],
          'disabled terrain has no published collider shapes',
        );
        releaseQuery();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(
          policy.gate.blocked,
          true,
          'a prior GPU receipt cannot resume gameplay after collider withdrawal',
        );
        assert.equal(walker.updates, updates);
        assert.deepEqual(
          Array.from(h.app.world.get(h.subjects.walker, Transform).unwrap().pos),
          before,
        );
        h.app.world.removeComponent(h.subjects.terrain, Disabled).unwrap();
        delayQuery = false;
        for (let i = 0; i < 3; i++) latestReceipt = (await h.frame()).receipt;
        assert.equal(policy.gate.blocked, false);
        assert(
          walker.updates > updates,
          'the ordinary writer resumes after both current surfaces agree',
        );
        report.cases.push({
          name: `${renderPath}-delayed-query-collider-withdrawal`,
          rejectedStaleReadiness: true,
          resumedWriterUpdates: walker.updates - updates,
        });
      } finally {
        stopWalker();
        policy.dispose();
      }
      const fog = h.app.world
        .spawn({
          component: Fog,
          data: { color: [0.3, 0.45, 0.65], density: 0.012, heightFalloff: 0.015, maxOpacity: 0.8 },
        })
        .unwrap();
      for (let i = 0; i < 60; i++) await h.frame();
      const fogged = await capture(`${renderPath}-fog`);
      fogged.proof.fogDifference = difference(base.pixels, fogged.pixels);
      assert(
        fogged.proof.fogDifference.changedChannels > 1000,
        'fog must change the actual terrain picture',
      );
      h.app.world.despawn(fog).unwrap();
      if (renderPath === 'deferred') {
        // SSR's existing admission requires a complete Standard scene input set.
        // Keep the default unlit marker in baseline pictures; this variant uses
        // an ordinary Standard marker so the terrain GBuffer path is exercised.
        const markerMaterial = h.app.world.sharedRefs.acquire(
          'MaterialAsset', Materials.standard({ baseColor: [1, 0.3, 0.025, 1], roughness: 0.4 }),
        );
        h.app.world.set(h.subjects.walker, MeshRenderer, { materials: [markerMaterial] }).unwrap();
        h.app.world.sharedRefs.release(markerMaterial).unwrap();
        const root = h.app.world.sharedRefs
          .resolve(h.app.world.get(h.subjects.terrain, Terrain).unwrap().asset)
          .unwrap();
        const material = h.app.world.sharedRefs.acquire(
          'MaterialAsset',
          Materials.standard({ baseColor: [0.8, 0.02, 0.01, 1], roughness: 0.25 }),
        );
        const decal = h.app.world
          .spawn(
            {
              component: Transform,
              data: {
                pos: [62, terrainHeight(root, 62, 62), 62],
                quat: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
                scale: [24, 24, 30],
              },
            },
            { component: ProjectedDecal, data: { material, opacity: 1, normalThreshold: 0 } },
          )
          .unwrap();
        h.app.world.sharedRefs.release(material).unwrap();
        h.app.world
          .addComponent(h.subjects.camera, {
            component: ScreenSpaceReflection,
            data: { maxDistance: 40, thickness: 0.2, maxRoughness: 1 },
          })
          .unwrap();
        h.app.world.set(h.subjects.camera, Camera, { antialias: 3 }).unwrap();
        for (let i = 0; i < 60; i++) await h.frame();
        const effects = await capture('deferred-decal-ssr-taa');
        assert(
          effects.model.works.some((w) => shader(w, 'struct DecalParams')),
          'the captured frame must contain decal projection',
        );
        assert(
          effects.proof.inspection.perFramePassNames.some((p) => p.includes('ssr')),
          'the captured frame must execute SSR',
        );
        assert.equal(effects.proof.inspection.temporal.historyValid, true);
        assert(
          effects.model.works.some((w) =>
            w.pipeline.shaders.some((s) => s.entryPoint === 'fs_temporal'),
          ),
          'terrain must participate in the actual temporal producer',
        );
        h.app.world.set(decal, ProjectedDecal, { opacity: 0 }).unwrap();
        for (let i = 0; i < 60; i++) await h.frame();
        const off = await capture('deferred-decal-off');
        off.proof.decalDifference = difference(effects.pixels, off.pixels);
        assert(
          off.proof.decalDifference.changedChannels > 1000,
          'decal removal must falsify the visible decal result',
        );
      }
      assert.deepEqual(h.errors, []);
      h.app.world
        .addComponent(h.subjects.terrain, {
          component: Visibility,
          data: { state: VisibilityStateValue.hidden },
        })
        .unwrap();
      const hidden = await h.frame();
      const hiddenQuery = await querySubmittedTerrainHeight(hidden.receipt, {
        worldId: 0,
        entity: h.subjects.terrain,
        x: 62,
        z: 62,
      });
      assert.equal(
        hiddenQuery.ok,
        false,
        'hidden terrain cannot satisfy a submitted picture query',
      );
      report.cases.push({ name: `${renderPath}-hidden`, query: hiddenQuery });
    } finally {
      await h.dispose();
      (await recorder.dispose()).unwrap();
    }
  }
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.error = String(error);
  throw error;
} finally {
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
}
process.exit(0);
