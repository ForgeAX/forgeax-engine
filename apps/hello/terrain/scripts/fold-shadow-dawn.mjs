import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import {
  Camera,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  DirectionalShadowFilterValue,
  MeshRenderer,
  querySubmittedTerrainHeight,
} from '@forgeax/engine-render';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { mat4, quat, ray, vec2 } from '@forgeax/engine-math';
import { Transform } from '@forgeax/engine-scene';
import { Terrain } from '@forgeax/engine-terrain';
import { writeReferencePng } from '../../../shared/png-codec.mjs';
import { terrainHarness } from './harness.mjs';

const root = resolve(import.meta.dirname, '../../../..');
const dir = resolve(
  process.env.TERRAIN_FOLD_SHADOW_DIR ??
    resolve(import.meta.dirname, '../.forgeax-debug/fold-shadow'),
);
mkdirSync(dir, { recursive: true });
const report = {
  status: 'RUNNING',
  producingHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  receiverSourceSha256: createHash('sha256')
    .update(readFileSync(resolve(root, 'packages/shader/src/lighting-directional.wgsl')))
    .digest('hex'),
  renderBuildSha256: createHash('sha256')
    .update(readFileSync(resolve(root, 'packages/render/dist/index.mjs')))
    .digest('hex'),
  boundary:
    'Strong continuous-fold falsifier: actual cooked source rows [0,0,0,0,7,7,7,7] at full LOD0, vertical light, no independent caster, map128, two translations. No heightfield overhang exists. The original 2/255 budget remains unchanged; this diagnostic tests adjacent horizontal plateau coverage.',
  budgets: { unoccludedCurvedPeakByteDifference: 2, selfBlockerMinimumPeakByteDifference: 10 },
  failures: [],
  cases: [],
};
const save = () => writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
const difference = (a, b) => {
  let changed = 0,
    peak = 0,
    sum = 0;
  for (let i = 0; i < a.length; i++)
    if (i % 4 !== 3) {
      const d = Math.abs(a[i] - b[i]);
      sum += d;
      peak = Math.max(peak, d);
      if (d > 2) changed++;
    }
  return {
    changedChannels: changed,
    peakByteDifference: peak,
    meanByteDifference: sum / (960 * 540 * 3),
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
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath, ssao: false },
      },
    });
    const capture = async (name) => {
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const { receipt } = await h.frame();
      (await recorder.frameBoundary()).unwrap();
      const tape = (await pending).unwrap();
      writeFileSync(resolve(dir, name + '.rhitape'), tape.bytes);
      const pixels = await h.pixels();
      writeFileSync(resolve(dir, name + '.png'), writeReferencePng(pixels, 960, 540));
      const model = buildFrameModel(decodeTape(tape.bytes).unwrap());
      const terrain = model.works.filter((work) =>
        work.pipeline.shaders.some((shader) => shader.source?.includes('fn terrainDecodeHeight')),
      );
      assert(terrain.length > 0, 'actual curved terrain must draw');
      const facts = {
        name,
        digest: tape.digest,
        tapeBytes: tape.bytes.byteLength,
        unseededResources: model.unseededResources,
        inspection: h.app.renderer.inspect(),
        terrainWorks: terrain.map((work) => ({
          workIndex: work.workIndex,
          shaders: work.pipeline.shaders.map((shader) => shader.entryPoint),
          vertexBuffers: work.vertexBuffers,
          indexBuffer: work.indexBuffer,
          bindings: work.bindings,
          attachments: work.attachments,
        })),
      };
      return { pixels, facts, receipt };
    };
    try {
      const lights = [...h.app.world.query({ read: [DirectionalLight] }).unwrap()];
      assert.equal(lights.length, 1);
      h.app.world.removeComponent(h.subjects.walker, MeshRenderer).unwrap();
      h.app.world.set(lights[0].entity, DirectionalLight, { direction: [0, -1, 0] }).unwrap();
      // A heightfield has no overhang. With vertical incident light and no
      // other caster, every actual curved triangle is unoccluded along +Y.
      // Reuse the preregistered plane 2/255 budget, without flattening geometry.
      const fold = (
        await h.app.assets.loadByGuid(
          AssetGuid.derive(definePackageId('019fcaf0-0000-7000-8000-000000000001'), 'terrain'),
        )
      ).unwrap();
      const foldHandle = h.app.world.sharedRefs.acquire('TerrainAsset', fold);
      h.app.world.set(h.subjects.terrain, Terrain, { asset: foldHandle, forcedLod: 0 }).unwrap();
      h.app.world.sharedRefs.release(foldHandle).unwrap();
      const eye = [3.5, 9, 15];
      h.app.world
        .set(h.subjects.camera, Transform, {
          pos: eye,
          quat: quat.fromLookAt(quat.create(), eye, [3.5, 3.5, 3.5], [0, 1, 0]),
        })
        .unwrap();
      h.app.world.set(lights[0].entity, DirectionalLight, { mapSize: 128 }).unwrap();
      for (const shadowFilter of [
        DirectionalShadowFilterValue.pcf1,
        DirectionalShadowFilterValue.pcf3,
        DirectionalShadowFilterValue.pcf5,
      ]) {
        h.app.world.set(lights[0].entity, DirectionalLight, { shadowFilter }).unwrap();
        for (const lod0Diameter of [0, 0.31]) {
          h.app.world
            .set(h.subjects.terrain, Transform, { pos: [lod0Diameter, 0, lod0Diameter * 0.3] })
            .unwrap();
          h.app.world.set(h.subjects.terrain, Terrain, { forcedLod: 0 }).unwrap();
          h.app.world.set(lights[0].entity, DirectionalLight, { castShadow: true }).unwrap();
          for (let i = 0; i < 60; i++) await h.frame();
          const on = await capture(`${renderPath}-${shadowFilter}-${lod0Diameter}-vertical-on`);
          h.app.world.set(lights[0].entity, DirectionalLight, { castShadow: false }).unwrap();
          for (let i = 0; i < 60; i++) await h.frame();
          const off = await capture(`${renderPath}-${shadowFilter}-${lod0Diameter}-vertical-off`);
          assert.deepEqual(h.errors, []);
          const delta = difference(on.pixels, off.pixels);
          report.cases.push({
            renderPath,
            shadowFilter,
            lod0Diameter,
            lightDirection: [0, -1, 0],
            independentCaster: false,
            completedWarmupFramesPerControl: 60,
            difference: delta,
            on: on.facts,
            off: off.facts,
          });
          if (delta.peakByteDifference > report.budgets.unoccludedCurvedPeakByteDifference)
            report.failures.push(
              `${renderPath}-${lod0Diameter}-vertical: ${JSON.stringify(delta)}`,
            );
          save();
        }
      }
      // The same finite fold must keep genuine same-root occlusion. Rebuild
      // the LOD0 triangle reference from the admitted grid and author endpoints
      // (0/7 decode exactly), independently of the caster-family selector.
      h.app.world.set(h.subjects.terrain, Transform, { pos: [0, 0, 0] }).unwrap();
      h.app.world
        .set(lights[0].entity, DirectionalLight, {
          direction: [-1, -1, 0],
          mapSize: 512,
          shadowDistance: 40,
          shadowFilter: DirectionalShadowFilterValue.pcf3,
          castShadow: true,
        })
        .unwrap();
      for (let i = 0; i < 60; i++) await h.frame();
      const blockedOn = await capture(`${renderPath}-fold-self-blocker-on`);
      h.app.world.set(lights[0].entity, DirectionalLight, { castShadow: false }).unwrap();
      for (let i = 0; i < 60; i++) await h.frame();
      const blockedOff = await capture(`${renderPath}-fold-self-blocker-off`);
      const grid = h.app.assets.lookup(fold.grids[0]);
      assert(grid.indices && grid.attributes.position);
      const vertices = Array.from({ length: grid.attributes.position.length / 3 }, (_, index) => {
        const x = grid.attributes.position[index * 3],
          z = grid.attributes.position[index * 3 + 2];
        const height = fold.heights[z * fold.columns + x];
        assert(height === 0 || height === 7);
        return [x * fold.spacing, height, z * fold.spacing];
      });
      const camera = h.app.world.get(h.subjects.camera, Camera).unwrap();
      const projection = mat4.perspectiveReverseZ(
        mat4.create(),
        camera.fov,
        camera.aspect,
        camera.near,
        camera.far,
      );
      const view = mat4.lookAt(mat4.create(), eye, [3.5, 3.5, 3.5], [0, 1, 0]);
      const vp = mat4.multiply(mat4.create(), projection, view);
      const references = [];
      for (const [position, expectBlocker] of [
        [[1.5, 0, 3.5], true],
        [[5.5, 7, 3.5], false],
      ]) {
        const height = (
          await querySubmittedTerrainHeight(blockedOff.receipt, {
            worldId: 0,
            entity: h.subjects.terrain,
            expectedAsset: foldHandle,
            x: position[0],
            z: position[2],
          })
        ).unwrap();
        assert.equal(
          height,
          position[1],
          'the actual submitted receiver must agree with the endpoint reference',
        );
        const lightRay = ray.create(undefined, position, [1, 1, 0]);
        const intersections = [];
        for (let i = 0; i < grid.indices.length; i += 3) {
          const hit = ray.rayTriangleIntersects(
            lightRay,
            vertices[grid.indices[i]],
            vertices[grid.indices[i + 1]],
            vertices[grid.indices[i + 2]],
          );
          if (hit.hit && hit.t > 1e-4) intersections.push({ triangle: i / 3, distance: hit.t });
        }
        assert.equal(
          intersections.length > 0,
          expectBlocker,
          'finite double-sided triangle ray reference',
        );
        const pixel = vec2.create();
        assert(ray.worldToScreen(pixel, position, vp, 960, 540).onScreen);
        const x = Math.floor(pixel[0]),
          y = Math.floor(pixel[1]);
        let peak = 0,
          peakDifference = 0,
          covered = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const offset = ((y + dy) * 960 + x + dx) * 4;
            for (let channel = 0; channel < 3; channel++) {
              const reference = blockedOff.pixels[offset + channel];
              peak = Math.max(peak, reference - blockedOn.pixels[offset + channel]);
              peakDifference = Math.max(
                peakDifference,
                Math.abs(reference - blockedOn.pixels[offset + channel]),
              );
              covered += reference > 30 ? 1 : 0;
            }
          }
        assert(
          covered >= 9,
          'neither black output nor a hidden receiver can satisfy the ray control',
        );
        if (expectBlocker && peak < report.budgets.selfBlockerMinimumPeakByteDifference)
          report.failures.push(`${renderPath}: true same-root blocker missing, peak=${peak}`);
        if (!expectBlocker && peakDifference > report.budgets.unoccludedCurvedPeakByteDifference)
          report.failures.push(
            `${renderPath}: finite-edge unoccluded plateau changed, peak=${peakDifference}`,
          );
        references.push({
          position,
          pixel: [x, y],
          expectBlocker,
          intersections,
          peakDimmingBytes: peak,
          peakByteDifference: peakDifference,
          coveredChannels: covered,
        });
      }
      report.cases.push({
        renderPath,
        name: 'finite-fold-triangle-ray-controls',
        completedWarmupFramesPerControl: 60,
        references,
        on: blockedOn.facts,
        off: blockedOff.facts,
      });
      assert.deepEqual(h.errors, []);
      save();
    } finally {
      await h.dispose();
      (await recorder.dispose()).unwrap();
    }
  }
  report.status = report.failures.length ? 'FAIL' : 'PASS';
  save();
  console.log(
    JSON.stringify({
      status: report.status,
      cases: report.cases.map((row) => ({
        renderPath: row.renderPath,
        lod0Diameter: row.lod0Diameter,
        difference: row.difference,
      })),
    }),
  );
  assert.deepEqual(
    report.failures,
    [],
    'unoccluded curved receiver must satisfy the original 2/255 budget',
  );
} catch (error) {
  report.status = 'FAIL';
  report.error = String(error);
  save();
  throw error;
}
