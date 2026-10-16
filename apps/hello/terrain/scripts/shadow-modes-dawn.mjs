import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { quat } from '@forgeax/engine-math';
import {
  Camera,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  DirectionalShadowFilterValue,
  PointLight,
  PointLightShadow,
  SpotLight,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { Terrain } from '@forgeax/engine-terrain';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as backend from '@forgeax/engine-rhi-webgpu';
import { writeReferencePng } from '../../../shared/png-codec.mjs';
import { terrainHarness } from './harness.mjs';
const dir = resolve(
  process.env.TERRAIN_SHADOW_MODES_DIR ??
    resolve(import.meta.dirname, '../.forgeax-debug/shadow-modes'),
);
mkdirSync(dir, { recursive: true });
const report = {
  status: 'RUNNING',
  pid: process.pid,
  producingHead: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: resolve(import.meta.dirname, '../../../..'),
    encoding: 'utf8',
  }).trim(),
  scriptSha256: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'),
  renderBuildSha256: createHash('sha256')
    .update(readFileSync(resolve(import.meta.dirname, '../../../../packages/render/dist/index.mjs')))
    .digest('hex'),
  phases: [],
  cases: [],
  boundary:
    'Real finite folded Terrain, original ordinary Terrain cull=none, 60 completed warmup frames per case. PCSS carrier is read after real GBuffer writes. Spot/Point upper and lower lights prove actual two-face depth writers; this is structural/depth conservation evidence, not a full Spot/Point penumbra image-quality claim.',
};
const save = () => writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
const phase = (name, detail = {}) => {
  report.phases.push({ name, utc: new Date().toISOString(), ...detail });
  save();
  console.log(JSON.stringify(report.phases.at(-1)));
};
phase('before-native-module');
const { create } = createRequire(import.meta.url)('webgpu');
phase('native-module-ready');
try {
  for (const renderPath of ['forward', 'deferred']) {
    phase('before-harness', { renderPath });
    const recorder = attachRecorder(backend).unwrap();
    const h = await terrainHarness({
      width: 640,
      height: 480,
      backendArgs: ['backend=metal'],
      appOptions: {
        rhi: recorder.backend.rhi,
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath, ssao: false },
      },
    });
    phase('harness-ready', { renderPath });
    try {
      phase('before-root-load', { renderPath });
      const root = (
        await h.app.assets.loadByGuid(
          AssetGuid.derive(definePackageId('019fcaf0-0000-7000-8000-000000000001'), 'terrain'),
        )
      ).unwrap();
      assert.equal(root.kind, 'terrain');
      const handle = h.app.world.sharedRefs.acquire('TerrainAsset', root);
      h.app.world.set(h.subjects.terrain, Terrain, { asset: handle, forcedLod: 0 }).unwrap();
      h.app.world.sharedRefs.release(handle).unwrap();
      phase('root-ready', { renderPath });
      const eye = [11, 16, 14];
      h.app.world
        .set(h.subjects.camera, Transform, {
          pos: eye,
          quat: quat.fromLookAt(quat.create(), eye, [3.5, 3.5, 3.5], [0, 1, 0]),
        })
        .unwrap();
      h.app.world.set(h.subjects.camera, Camera, { near: 0.1, far: 40, aspect: 4 / 3 }).unwrap();
      h.app.world.set(h.subjects.walker, Transform, { pos: [-100, -100, -100] }).unwrap();
      const lights = [...h.app.world.query({ read: [DirectionalLight] }).unwrap()];
      assert.equal(lights.length, 1);
      const directional = lights[0].entity;
      for (const name of [
        'pcss-medium',
        'pcss-high',
        'spot-above',
        'spot-below',
        'point-above',
        'point-below',
      ]) {
        const pcss = name.startsWith('pcss');
        h.app.world
          .set(directional, DirectionalLight, {
            direction: [0, -1, 0],
            intensity: 3,
            castShadow: pcss,
            mapSize: 256,
            shadowDistance: 40,
            shadowFilter:
              DirectionalShadowFilterValue[name === 'pcss-medium' ? 'pcssMedium' : 'pcssHigh'],
          })
          .unwrap();
        let extra;
        if (!pcss) {
          const below = name.endsWith('below'),
            position = [3.5, below ? -10 : 17, 3.5];
          const components = [{ component: Transform, data: { pos: position } }];
          if (name.startsWith('spot'))
            components.push({
              component: SpotLight,
              data: {
                direction: [0, below ? 1 : -1, 0],
                intensity: 20,
                range: 40,
                outerConeDeg: 60,
                mapSize: 256,
                farPlane: 40,
              },
            });
          else
            components.push(
              { component: PointLight, data: { intensity: 20, range: 40 } },
              { component: PointLightShadow, data: { mapSize: 256, farPlane: 40 } },
            );
          extra = h.app.world.spawn(...components).unwrap();
        }
        try {
          phase('before-warmup', { renderPath, name });
          for (let i = 0; i < 60; i++) await h.frame();
          phase('warmup-complete', { renderPath, name });
          h.app.world.set(h.subjects.terrain, Terrain, { forcedLod: 2 }).unwrap();
          await h.frame();
          h.app.world.set(h.subjects.terrain, Terrain, { forcedLod: 0 }).unwrap();
          const pending = recorder.captureFrame();
          (await recorder.frameBoundary()).unwrap();
          await h.frame();
          (await recorder.frameBoundary()).unwrap();
          const artifact = (await pending).unwrap(),
            tape = decodeTape(artifact.bytes).unwrap(),
            model = buildFrameModel(tape);
          phase('capture-complete', { renderPath, name, digest: artifact.digest });
          writeFileSync(resolve(dir, `${renderPath}-${name}.rhitape`), artifact.bytes);
          phase('before-live-pixels', { renderPath, name });
          const livePixels = await h.pixels();
          phase('live-pixels-complete', { renderPath, name });
          writeFileSync(
            resolve(dir, `${renderPath}-${name}.png`),
            writeReferencePng(livePixels, 640, 480),
          );
          const resource = (id) => model.resources.find((r) => r.resourceId === id);
          const depthOf = (w) =>
            resource(resource(w.attachments?.depthStencilViewHandleId)?.descriptor?.sourceHandleId);
          const casters = model.works.filter(
            (w) =>
              (w.attachments?.colorViewHandleIds.length ?? 0) === 0 &&
              w.pipeline.shaders.some((s) => s.source?.includes('fn terrainDecodeHeight')),
          );
          const selected = casters.filter((w) =>
            pcss
              ? resource(w.attachments.depthStencilViewHandleId)?.descriptor?.desc?.baseArrayLayer <
                4
              : true,
          );
          assert(selected.length > 0, 'the actual light must rasterize the finite Terrain');
          for (const work of selected)
            assert.equal(
              work.pipeline.descriptor.desc.primitive.cullMode,
              'none',
              'ordinary PCSS, Spot and Point must preserve both Terrain faces',
            );
          const textures = [...new Set(selected.map((w) => depthOf(w)?.resourceId))].map(resource);
          assert(textures.every(Boolean));
          const regions = new Map();
          for (const work of selected) {
            const texture = depthOf(work),
              view = resource(work.attachments.depthStencilViewHandleId);
            const extent = texture.descriptor.desc.size;
            const pass = model.passes.find((entry) => entry.passIndex === work.passIndex);
            const events = tape.events.slice(pass.beginEventIndex, work.eventIndex);
            const viewport = events.filter((event) => event.kind === 'setViewport').at(-1);
            const scissor = events.filter((event) => event.kind === 'setScissorRect').at(-1);
            const left = Math.max(0, Math.ceil(viewport?.x ?? 0), scissor?.x ?? 0);
            const top = Math.max(0, Math.ceil(viewport?.y ?? 0), scissor?.y ?? 0);
            const right = Math.min(
              extent.width,
              Math.floor((viewport?.x ?? 0) + (viewport?.w ?? extent.width)),
              (scissor?.x ?? 0) + (scissor?.w ?? extent.width),
            );
            const bottom = Math.min(
              extent.height,
              Math.floor((viewport?.y ?? 0) + (viewport?.h ?? extent.height)),
              (scissor?.y ?? 0) + (scissor?.h ?? extent.height),
            );
            assert(
              right > left && bottom > top,
              'the selected real writer must have a nonempty physical region',
            );
            const region = {
              texture: texture.resourceId,
              layer: view.descriptor.desc.baseArrayLayer ?? 0,
              left,
              top,
              right,
              bottom,
            };
            regions.set(JSON.stringify(region), region);
          }
          phase('before-replay-device', { renderPath, name });
          const replayProvider = create(['backend=metal']);
          const adapter = (await backend.requestAdapterFrom(replayProvider)).unwrap();
          const device = (
            await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
          ).unwrap();
          let replay;
          phase('replay-device-ready', { renderPath, name });
          const errors = [];
          device
            .nativeDevice()
            .unwrap()
            .addEventListener('uncapturederror', (event) => errors.push(event.error.message));
          let nonzeroDepth = 0,
            carrierPixels = 0;
          try {
            replay = (
              await openReplay(tape, { device, createShaderModule: backend.createShaderModule })
            ).unwrap();
            phase('replay-ready', { renderPath, name });
            for (const region of regions.values()) {
              phase('before-depth-readback', { renderPath, name, region });
              const texture = resource(region.texture);
              const read = (
                await replay.readResourceAtWork(texture.resourceId, model.works.at(-1).workIndex, {
                  mipLevel: 0,
                  arrayLayer: region.layer,
                  aspect: 'depth-only',
                })
              ).unwrap();
              const raw = Uint8Array.from(read.bytes),
                depth = new Float32Array(raw.buffer);
              assert.equal(read.format, 'depth32float');
              assert.equal(raw.byteLength, read.width * read.height * 4);
              const stride = read.width;
              assert.equal(stride, texture.descriptor.desc.size.width);
              for (let y = region.top; y < region.bottom; y++)
                for (let x = region.left; x < region.right; x++) {
                  const value = depth[y * stride + x];
                  assert(Number.isFinite(value));
                  if (value > 0) nonzeroDepth++;
                }
            }
            assert(
              nonzeroDepth > 0,
              'front and back light controls must retain actual depth coverage',
            );
            if (pcss && renderPath === 'deferred') {
              phase('before-carrier-readback', { renderPath, name });
              const ng = model.resources.find(
                (r) =>
                  r.kind === 'texture' && r.descriptor?.desc?.label === 'gbuffer-receiver-geometry',
              );
              assert(ng);
              const read = (
                await replay.readResourceAtWork(ng.resourceId, model.works.at(-1).workIndex, {
                  mipLevel: 0,
                  arrayLayer: 0,
                })
              ).unwrap();
              const raw = Uint8Array.from(read.bytes),
                packed = new Uint32Array(raw.buffer);
              for (const value of packed) {
                assert.equal(
                  value >>> 24,
                  0,
                  'actual PCSS GBuffer receiver must choose ordinary base zero',
                );
                if (value & 0x00ffffff) carrierPixels++;
              }
              assert(carrierPixels > 2000, 'empty GBuffer cannot prove PCSS routing');
            }
            await device.queue.onSubmittedWorkDone();
            assert.deepEqual(errors, []);
          } finally {
            phase('before-replay-dispose', { renderPath, name });
            try {
              if (replay) (await replay.dispose()).unwrap();
            } finally {
              device.nativeDevice().unwrap().destroy();
              // Keep the native provider strongly reachable until device work
              // and disposal finish; do not infer crash recovery from this.
              assert(replayProvider);
              phase('replay-disposed', { renderPath, name });
            }
          }
          assert.deepEqual(h.errors, []);
          report.cases.push({
            renderPath,
            name,
            completedWarmupFrames: 60,
            digest: artifact.digest,
            terrainCasterWorks: selected.map((w) => w.workIndex),
            depthResources: textures.map((t) => ({
              id: t.resourceId,
              descriptor: t.descriptor.desc,
            })),
            nonzeroDepth,
            writerRegions: [...regions.values()],
            carrierPixels,
          });
          save();
        } finally {
          if (extra !== undefined) h.app.world.despawn(extra).unwrap();
        }
      }
    } finally {
      phase('before-harness-dispose', { renderPath });
      await h.dispose();
      (await recorder.dispose()).unwrap();
      phase('harness-disposed', { renderPath });
    }
  }
  report.status = 'PASS';
  save();
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = 'FAIL';
  report.failure = { message: String(error), code: error.code, detail: error.detail };
  save();
  throw error;
}
process.exit(0);
