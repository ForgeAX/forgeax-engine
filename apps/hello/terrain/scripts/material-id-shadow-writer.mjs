import { encodePng } from '@forgeax/engine-image/png';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createSphereGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/source';
import {
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  ShadowParticipation,
} from '@forgeax/engine-render';
import { RhiError } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as backend from '@forgeax/engine-rhi-webgpu';
import { Mobility, MobilityKindValue, Transform } from '@forgeax/engine-scene';
import { Terrain } from '@forgeax/engine-terrain';
import { derive, projectMaterialParameterSchema } from '@forgeax/engine-types';

import { materialPackageId, materialTerrainGuid } from '../src/identity.ts';
import { terrainHarness } from './harness.mjs';

const dir = resolve(process.argv[2]);
mkdirSync(dir, { recursive: true });
const rows = [];
const root = resolve(import.meta.dirname, '../../../..');
const producingHead = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const renderBuildSha256 = createHash('sha256')
  .update(readFileSync(resolve(root, 'packages/render/dist/index.mjs')))
  .digest('hex');
writeFileSync(
  resolve(dir, 'writer-report.json'),
  JSON.stringify({ status: 'RUNNING', producingHead, rows }, null, 2),
);
try {
  for (const encoding of ['weights', 'ids']) {
    let rejectSubmit = false;
    const recorder = attachRecorder(backend).unwrap();
    const h = await terrainHarness({
      width: 960,
      height: 540,
      backendArgs: ['backend=metal'],
      rootGuid: materialTerrainGuid(encoding),
      appOptions: {
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' },
        rhi: recorder.backend.rhi,
        rhiInstrumentation: {
          beforeSubmit() {
            if (!rejectSubmit) return undefined;
            rejectSubmit = false;
            return new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'terrain writer one-shot static submit rejection',
              hint: 'retry the unchanged static caster and receiver family',
            });
          },
        },
      },
    });
    try {
      const lights = [...h.app.world.query({ read: [DirectionalLight] }).unwrap()];
      assert.equal(lights.length, 1);
      h.app.world.set(lights[0].entity, DirectionalLight, { cascadeCount: 4 }).unwrap();
      const mesh = h.app.world.sharedRefs.acquire(
        'MeshAsset',
        createSphereGeometry(2, 16, 12).unwrap(),
      );
      // The settled static producer requires the real cooked scene-index
      // Standard program. An uncooked Materials.standard shared ref falls back
      // to a CPU draw and cannot establish conservation of GPU static depth.
      const staticMaterialGuid = AssetGuid.derive(materialPackageId, 'static-caster-material');
      const staticMaterial = (await h.app.assets.loadByGuid(staticMaterialGuid)).unwrap();
      assert.equal(staticMaterial.kind, 'material');
      const readiness = h.app.assets.getMaterialReadiness(AssetGuid.format(staticMaterialGuid));
      assert.equal(
        readiness?.status,
        'Ready',
        'the static material must complete native shader cook',
      );
      assert.equal(readiness.receipt.schemaVersion, 'material-cook/4');
      const projection = h.app.assets.getMaterialProjection(AssetGuid.format(staticMaterialGuid));
      assert(
        projection?.passes.some(
          (pass) =>
            pass.name === 'shadow-caster' &&
            pass.programs.some(
              (program) => program.address === 'scene-index' && program.abi?.sceneIndexEntry,
            ),
        ),
        'the static shadow material must publish its scene-index program',
      );
      const material = h.app.world.sharedRefs.acquire('MaterialAsset', staticMaterial);
      const staticCaster = h.app.world
        .spawn(
          { component: Transform, data: { pos: [60, 30, 60] } },
          { component: Mobility, data: { kind: MobilityKindValue.static } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
          { component: ShadowParticipation, data: { cast: true } },
        )
        .unwrap();
      h.app.world.sharedRefs.release(mesh).unwrap();
      h.app.world.sharedRefs.release(material).unwrap();
      const eye = [20, 30, 135];
      h.app.world
        .set(h.subjects.camera, Transform, {
          pos: eye,
          quat: quat.fromLookAt(quat.create(), eye, [62, 0, 60], [0, 1, 0]),
        })
        .unwrap();
      h.app.world.set(h.subjects.terrain, Terrain, { lod0Diameter: 2, forcedLod: 0 }).unwrap();
      for (let i = 0; i < 60; i++) await h.frame();
      const materialObservation = h.app.renderer
        .inspect()
        .meshMaterialBindings.find((entry) => entry.entityKey === Number(staticCaster));
      assert(materialObservation, 'the real static caster must be extracted');
      assert(
        materialObservation.residency.every((slot) => slot.readiness === 'ready'),
        'the cooked static caster material must be resident before rejecting its producer',
      );
      // Exercise the actual cache invalidation path, then capture the restored LOD0 writer.
      for (const receiverCount of [1, 2]) {
        let foreign;
        if (receiverCount === 2) {
          // Identity is an instance, not an asset GUID. Both roots share the exact
          // author/derived asset but must be foreign casters in the other's family.
          foreign = h.app.world
            .spawn(
              { component: Transform, data: { pos: [3, 1, 0] } },
              {
                component: Terrain,
                data: { ...h.app.world.get(h.subjects.terrain, Terrain).unwrap(), forcedLod: 0 },
              },
            )
            .unwrap();
          for (let i = 0; i < 60; i++) await h.frame();
        }
        // Changing caster content demotes a known static caster until it settles
        // again. Invalidate the light-space view while keeping the caster intact.
        const changedEye = [20, 30, 115];
        h.app.world
          .set(h.subjects.camera, Transform, {
            pos: changedEye,
            quat: quat.fromLookAt(quat.create(), changedEye, [62, 0, 60], [0, 1, 0]),
          })
          .unwrap();
        h.app.world.set(h.subjects.terrain, Terrain, { forcedLod: 2 }).unwrap();
        await h.frame();
        h.app.world
          .set(h.subjects.camera, Transform, {
            pos: eye,
            quat: quat.fromLookAt(quat.create(), eye, [62, 0, 60], [0, 1, 0]),
          })
          .unwrap();
        h.app.world.set(h.subjects.terrain, Terrain, { forcedLod: 0 }).unwrap();
        // The first real static/family producer candidate is rejected. The
        // unchanged retry must execute its full copies and preserve numerical
        // static blocker depth; a pool/cache hit alone cannot prove that.
        assert.deepEqual(h.errors, []);
        const completedBeforeRejection = h.completed;
        h.app.world.update(1 / 60).unwrap();
        rejectSubmit = true;
        const failed = h.draw();
        assert.equal(failed.ok, false);
        assert.equal(failed.error.code, 'frame-submit-rejected');
        assert.equal(h.completed, completedBeforeRejection);
        const rejectionEvents = h.errors.slice();
        assert.equal(rejectionEvents.length, 1);
        assert.equal(rejectionEvents[0].code, 'device-operation-failed');
        assert.equal(rejectionEvents[0].detail.operation, 'renderer-event');
        assert.equal(rejectionEvents[0].detail.cause.code, 'webgpu-runtime-error');
        assert.equal(
          rejectionEvents[0].detail.cause.expected,
          'terrain writer one-shot static submit rejection',
        );
        h.errors.length = 0;
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        await h.frame();
        (await recorder.frameBoundary()).unwrap();
        const artifact = (await pending).unwrap();
        const name = `forward-${encoding}-${receiverCount}-roots-static-lod0-proof`;
        writeFileSync(resolve(dir, `${name}.rhitape`), artifact.bytes);
        const live = await h.pixels();
        writeFileSync(resolve(dir, `${name}-capture.png`), encodePng(960, 540, live));
        const tape = decodeTape(artifact.bytes).unwrap();
        const model = buildFrameModel(tape);
        const asset = h.app.world.sharedRefs
          .resolve(h.app.world.get(h.subjects.terrain, Terrain).unwrap().asset)
          .unwrap();
        const parameters = h.app.assets.lookup(asset.sections[0].material).parameters;
        const abi = derive(
          projectMaterialParameterSchema(
            parameters,
            asset.sections[0].material,
            'runtime',
          ).unwrap(),
        );
        const familyOffset = abi.uboLayout.entries.find(
          (field) => field.name === 'terrainShadowFamily',
        )?.offset;
        assert.notEqual(
          familyOffset,
          undefined,
          'the published material schema must own the family field',
        );
        const blobs = new Map(tape.blobs.map((blob) => [blob.hash, blob.bytes]));
        const instanceOrdinal = (work) => {
          const uniform = work.bindings.find(
            (binding) => binding.groupIndex === 1 && binding.binding === 0,
          );
          assert(uniform, 'actual Terrain writer must bind its material UBO');
          const buffer = tape.bootstrap.find(
            (resource) => resource.handleId === uniform.resourceId,
          );
          assert(buffer, 'the writer UBO must have a captured initial state');
          const bytes = new Uint8Array(buffer.create.desc.size);
          for (const data of buffer.initialData ?? [])
            bytes.set(blobs.get(data.hash).subarray(0, data.byteLength), data.byteOffset);
          for (const event of tape.events.slice(0, work.eventIndex + 1))
            if (event.kind === 'writeBuffer' && event.handleId === uniform.resourceId)
              bytes.set(blobs.get(event.dataHash).subarray(0, event.size), event.bufferOffset);
          const offset = (uniform.bufferOffset ?? 0) + (uniform.dynamicOffset ?? 0) + familyOffset;
          const ordinal = new DataView(bytes.buffer).getFloat32(offset, true);
          assert(Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= receiverCount);
          return ordinal;
        };
        const casters = model.works.filter((w) =>
          w.pipeline.shaders.some(
            (s) =>
              s.source?.includes('fn shadowVertex') && s.source.includes('fn terrainDecodeHeight'),
          ),
        );
        assert(casters.length > 0, 'restored LOD must record real terrain shadow producers');
        const resources = new Map(
          model.resources.map((resource) => [resource.resourceId, resource]),
        );
        const shadow = model.resources.find(
          (resource) =>
            resource.kind === 'texture' &&
            resource.descriptor?.desc?.label === 'directional-shadow-depth',
        );
        assert(shadow, 'the actual composed directional array must be captured');
        const size = shadow.descriptor.desc.size;
        const cascades = 4;
        assert.equal(size.depthOrArrayLayers, cascades * (1 + receiverCount));
        const roles = casters.map((work) => {
          const view = resources.get(work.attachments.depthStencilViewHandleId);
          assert.equal(view.descriptor.sourceHandleId, shadow.resourceId);
          const layer = view.descriptor.desc.baseArrayLayer;
          const cullMode = work.pipeline.descriptor.desc.primitive.cullMode;
          const ordinal = instanceOrdinal(work);
          const own = Math.floor(layer / cascades) === ordinal;
          assert.equal(
            cullMode,
            own ? 'front' : 'none',
            'actual UBO instance ordinal distinguishes own and foreign caster roles',
          );
          return { workIndex: work.workIndex, layer, cullMode, instanceOrdinal: ordinal };
        });
        for (let family = 1; family <= receiverCount; family++) {
          const modes = new Set(
            roles
              .filter((role) => Math.floor(role.layer / cascades) === family)
              .map((role) => role.cullMode),
          );
          assert(
            modes.has('front'),
            'each instance family must execute its same-root back-face writer',
          );
          if (receiverCount === 2)
            assert(modes.has('none'), 'same-GUID foreign Terrain keeps both faces');
        }
        const copies = tape.events.filter(
          (event) =>
            event.kind === 'copyTextureToTexture' &&
            event.destination.textureHandleId === shadow.resourceId &&
            event.destination.origin.z >= cascades,
        );
        assert.equal(
          copies.length,
          receiverCount * cascades,
          'all family cascades need complete static seeds',
        );
        for (const copy of copies) {
          assert.equal(copy.source.textureHandleId, copies[0].source.textureHandleId);
          assert.deepEqual(copy.copySize, {
            width: size.width,
            height: size.height,
            depthOrArrayLayers: 1,
          });
          assert.equal(copy.source.origin.z, copy.destination.origin.z % cascades);
          assert.equal(
            resources.get(copy.source.textureHandleId).descriptor.desc.label,
            'directional-shadow-static',
          );
        }
        const staticProducers = model.works.filter((work) => {
          const view = resources.get(work.attachments?.depthStencilViewHandleId);
          return (
            resources.get(view?.descriptor?.sourceHandleId)?.descriptor?.desc?.label ===
            'directional-shadow-static'
          );
        });
        assert(
          staticProducers.length > 0,
          'capture must execute the real settled GPU caster producer',
        );
        for (const copy of copies) {
          const prior = staticProducers.filter(
            (work) =>
              resources.get(work.attachments.depthStencilViewHandleId).descriptor.desc
                .baseArrayLayer === copy.source.origin.z,
          );
          // A cascade with no projected sphere still has its full clear producer.
          if (prior.length > 0)
            assert(prior.every((work) => work.eventIndex < tape.events.indexOf(copy)));
          assert(
            roles
              .filter((role) => role.layer === copy.destination.origin.z)
              .every(
                (role) =>
                  casters.find((work) => work.workIndex === role.workIndex).eventIndex >
                  tape.events.indexOf(copy),
              ),
          );
        }
        const ordinaryCasters = model.works.filter(
          (work) =>
            work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_shadow') &&
            !work.pipeline.shaders.some((shader) =>
              shader.source?.includes('fn terrainDecodeHeight'),
            ),
        );
        assert(ordinaryCasters.length > 0, 'the real ordinary caster must remain present');
        for (const work of ordinaryCasters)
          assert.equal(work.pipeline.descriptor.desc.primitive.cullMode, 'back');
        // An explicit provider keeps this fresh replay device outside the
        // live harness's device slot. All reads are actual final post-work
        // bytes, rather than bootstrap seeds or predicted copy outcomes.
        const { create } = await import('@forgeax/engine-dawn-node');
        const replayProvider = create(['backend=metal']);
        const adapter = (await backend.requestAdapterFrom(replayProvider)).unwrap();
        const device = (
          await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
        ).unwrap();
        const nativeReplayDevice = device.nativeDevice().unwrap();
        const replayErrors = [];
        nativeReplayDevice.addEventListener('uncapturederror', (event) =>
          replayErrors.push(event.error.message),
        );
        let replay;
        const staticDepth = {
          coveredTexels: 0,
          comparisons: 0,
          layers: [],
          replayPeakByteDifference: 0,
        };
        try {
          replay = (
            await openReplay(tape, { device, createShaderModule: backend.createShaderModule })
          ).unwrap();
          const finalWork = model.works.at(-1);
          const requests = Array.from({ length: cascades }, (_, cascade) => ({
            resourceId: copies[0].source.textureHandleId,
            workIndex: finalWork.workIndex,
            subresource: { mipLevel: 0, arrayLayer: cascade, aspect: 'depth-only' },
          }));
          for (let layer = cascades; layer < size.depthOrArrayLayers; layer++)
            requests.push({
              resourceId: shadow.resourceId,
              workIndex: finalWork.workIndex,
              subresource: { mipLevel: 0, arrayLayer: layer, aspect: 'depth-only' },
            });
          requests.push({
            resourceId: finalWork.attachments.colorViewHandleIds[0],
            workIndex: finalWork.workIndex,
          });
          const reads = (await replay.readAtWorks(requests))
            .unwrap()
            .map((result) => result.unwrap());
          const depths = reads.slice(0, -1).map((read, index) => {
            assert.equal(read.format, 'depth32float');
            assert.equal(read.bytes.byteLength, size.width * size.height * 4);
            const bytes = Uint8Array.from(read.bytes);
            const file = `${name}-${index < cascades ? `static-c${index}` : `family-layer${index}`}.f32.gz`;
            writeFileSync(resolve(dir, file), gzipSync(bytes));
            staticDepth.layers.push({
              file,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            });
            return new Float32Array(bytes.buffer);
          });
          for (let cascade = 0; cascade < cascades; cascade++) {
            const source = depths[cascade];
            for (let pixel = 0; pixel < source.length; pixel++) {
              assert(Number.isFinite(source[pixel]));
              if (source[pixel] <= 0) continue;
              staticDepth.coveredTexels++;
              for (let family = 1; family <= receiverCount; family++) {
                const target = depths[family * cascades + cascade][pixel];
                assert(
                  Number.isFinite(target) && target >= source[pixel],
                  'reverse-Z family depth must preserve every actual static blocker or a closer blocker',
                );
                staticDepth.comparisons++;
              }
            }
          }
          assert(
            staticDepth.coveredTexels > 0,
            'empty static maps cannot prove blocker preservation',
          );
          const image = reads.at(-1);
          assert.equal(image.bytes.byteLength, live.byteLength);
          const pixels = image.bytes.slice();
          if (image.format.startsWith('bgra'))
            for (let pixel = 0; pixel < pixels.length; pixel += 4)
              [pixels[pixel], pixels[pixel + 2]] = [pixels[pixel + 2], pixels[pixel]];
          for (let pixel = 0; pixel < pixels.length; pixel++)
            staticDepth.replayPeakByteDifference = Math.max(
              staticDepth.replayPeakByteDifference,
              Math.abs(pixels[pixel] - live[pixel]),
            );
          assert(
            staticDepth.replayPeakByteDifference <= 2,
            'fresh unmodified replay must match live candidate pixels',
          );
          await nativeReplayDevice.queue.onSubmittedWorkDone();
          assert.deepEqual(replayErrors, [], 'fresh replay must remain WebGPU-validation clean');
          writeFileSync(resolve(dir, `${name}-replay.png`), encodePng(960, 540, pixels));
        } finally {
          try {
            if (replay !== undefined) (await replay.dispose()).unwrap();
          } finally {
            nativeReplayDevice.destroy();
            assert(replayProvider); // Retain the native provider through fresh replay cleanup.
          }
        }
        rows.push({
          encoding,
          receiverCount,
          producingHead,
          renderBuildSha256,
          digest: artifact.digest,
          completedFrames: h.completed,
          adapter: h.shim.adapterInfo,
          shadowTexture: shadow,
          roles,
          staticCopies: copies,
          staticProducerWorks: staticProducers.map((work) => work.workIndex),
          staticDepth,
          retryAfterRejectedStaticSubmission: {
            code: failed.error.code,
            completedFramesBefore: completedBeforeRejection,
            completedFramesAfterRetry: h.completed,
            rejectionEvents,
          },
          casters: casters.map((w) => ({
            workIndex: w.workIndex,
            eventIndex: w.eventIndex,
            pipeline: w.pipeline,
            bindings: w.bindings,
            attachments: w.attachments,
          })),
        });
        writeFileSync(
          resolve(dir, 'writer-report.json'),
          JSON.stringify({ status: 'RUNNING', rows }, null, 2),
        );
        console.log(
          JSON.stringify({
            encoding,
            receiverCount,
            casters: casters.length,
            digest: artifact.digest,
          }),
        );
        assert.deepEqual(h.errors, []);
        const stablePending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        await h.frame();
        (await recorder.frameBoundary()).unwrap();
        const stableArtifact = (await stablePending).unwrap();
        writeFileSync(resolve(dir, `${name}-stable-cache.rhitape`), stableArtifact.bytes);
        writeFileSync(
          resolve(dir, `${name}-stable-cache-inspection.json`),
          JSON.stringify(
            {
              sourceHead: producingHead,
              renderBuildSha256,
              digest: stableArtifact.digest,
              completedFrames: h.completed,
              shadowRaster: h.app.renderer.inspect().shadowRaster,
            },
            null,
            2,
          ),
        );
        assert.equal(
          h.app.renderer.inspect().shadowRaster.passCount,
          0,
          'accepted retry must commit the stable shadow cache',
        );
        if (foreign !== undefined) h.app.world.despawn(foreign).unwrap();
      }
    } finally {
      await h.dispose();
      (await recorder.dispose()).unwrap();
    }
  }
  writeFileSync(
    resolve(dir, 'writer-report.json'),
    JSON.stringify(
      {
        status: 'PASS',
        boundary:
          'Actual RHI writer roles, array extents and full static copies; separate image, depth and replay gates remain required.',
        rows,
      },
      null,
      2,
    ),
  );
} catch (error) {
  writeFileSync(
    resolve(dir, 'writer-report.json'),
    JSON.stringify({ status: 'FAIL', producingHead, rows, error: String(error) }, null, 2),
  );
  throw error;
}
process.exit(0);
