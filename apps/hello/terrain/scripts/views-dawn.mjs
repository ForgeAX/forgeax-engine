import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RhiError } from '@forgeax/engine-rhi';
import { quat } from '@forgeax/engine-math';
import {
  Camera,
  CameraView,
  ANTIALIAS_TAA,
  DEFAULT_STANDARD_PROFILE,
  perspective,
  querySubmittedTerrainHeight,
} from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { Terrain } from '@forgeax/engine-terrain';
import { writeReferencePng } from '../../../shared/png-codec.mjs';
import { terrainHarness } from './harness.mjs';

const renderValue = (result) => {
  if (!result.ok) throw result.error;
  return result.value;
};

let reject = false;
const renderPath = process.env.TERRAIN_VIEWS_RENDER_PATH ?? 'forward';
assert(['forward', 'deferred'].includes(renderPath));
const recorder = attachRecorder(webgpu).unwrap();
const h = await terrainHarness({
  width: 960,
  height: 540,
  backendArgs: ['backend=metal'],
  appOptions: {
    rhi: recorder.backend.rhi,
    standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath },
    rhiInstrumentation: {
      beforeSubmit() {
        if (reject) {
          reject = false;
          return new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'terrain views one-shot submit rejection',
            hint: 'retry the same real view submission',
          });
        }
      },
    },
  },
});
const dir = resolve(
  process.env.TERRAIN_VIEWS_ARTIFACT_DIR ??
    resolve(import.meta.dirname, `../.forgeax-debug/views-${renderPath}`),
);
mkdirSync(dir, { recursive: true });
const report = { status: 'RUNNING', renderPath, cases: [] };
const query = (receipt, view, extra = {}) =>
  querySubmittedTerrainHeight(receipt, {
    worldId: 0,
    entity: h.subjects.terrain,
    x: 58.2,
    z: 60.4,
    ...(view === undefined ? {} : { view }),
    ...extra,
  });
try {
  h.app.world.set(h.subjects.terrain, Terrain, { forcedLod: -1, lod0Diameter: 1.2 }).unwrap();
  h.app.world
    .addComponent(h.subjects.camera, {
      component: CameraView,
      data: { viewport: [0, 0, 0.5, 1], order: 0 },
    })
    .unwrap();
  const eye = [65, 95, 300];
  const right = h.app.world
    .spawn(
      {
        component: Transform,
        data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [62, 0, 56], [0, 1, 0]) },
      },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 3, aspect: 8 / 9, near: 0.1, far: 500 }),
          antialias: ANTIALIAS_TAA,
        },
      },
      { component: CameraView, data: { viewport: [0.5, 0, 0.5, 1], order: 1 } },
    )
    .unwrap();
  h.app.world.set(h.subjects.camera, Camera, { aspect: 8 / 9, antialias: ANTIALIAS_TAA }).unwrap();
  for (let i = 0; i < 60; i++) await h.frame();
  const { receipt } = await h.frame();
  const leftHeight = (await query(receipt, String(h.subjects.camera))).unwrap();
  const rightHeight = (await query(receipt, String(right))).unwrap();
  assert(Number.isFinite(leftHeight) && Number.isFinite(rightHeight));
  assert(
    Math.abs(leftHeight - rightHeight) > 1e-4,
    'distinct view-local LODs must produce distinct submitted triangle heights',
  );
  assert.equal((await query(receipt)).ok, false, 'multiple views require explicit identity');
  writeFileSync(resolve(dir, 'split-lod.png'), writeReferencePng(await h.pixels(), 960, 540));
  report.cases.push({
    name: 'two-view-local-lod',
    leftHeight,
    rightHeight,
    inspection: h.app.renderer.inspect(),
  });
  const pending = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  await h.frame();
  (await recorder.frameBoundary()).unwrap();
  const tape = (await pending).unwrap();
  writeFileSync(resolve(dir, 'two-view.rhitape'), tape.bytes);
  const model = buildFrameModel(decodeTape(tape.bytes).unwrap());
  const receiverTextures = model.resources.filter(
    (resource) =>
      resource.kind === 'texture' &&
      resource.descriptor?.desc?.label === 'gbuffer-receiver-geometry',
  );
  const receiverLineage = [];
  if (renderPath === 'deferred') {
    assert.equal(
      receiverTextures.length,
      2,
      'two views must own distinct primitive-normal attachments',
    );
    const resource = (id) => model.resources.find((entry) => entry.resourceId === id);
    const lighting = model.works.filter((work) =>
      work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_standard_deferred'),
    );
    assert.equal(lighting.length, 2, 'each rendered view needs its real deferred lighting work');
    for (const consumer of lighting) {
      const readView = consumer.bindings.find(
        (binding) => binding.groupIndex === 1 && binding.binding === 15,
      )?.resourceId;
      const textureId = resource(readView)?.descriptor?.sourceHandleId;
      const texture = receiverTextures.find((entry) => entry.resourceId === textureId);
      assert(texture, 'lighting binding15 must read its actual primitive-normal texture');
      const writers = model.works.filter(
        (work) =>
          work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_gbuffer') &&
          work.attachments?.colorViewHandleIds[0] === consumer.attachments?.colorViewHandleIds[0],
      );
      assert(writers.length > 0, 'view scene-color identity must identify actual gbuffer writers');
      for (const writer of writers) {
        const writeView = writer.attachments.colorViewHandleIds[5];
        assert.equal(
          resource(writeView)?.descriptor?.sourceHandleId,
          textureId,
          'each view must consume the Ng texture it wrote',
        );
        assert(writer.workIndex < consumer.workIndex);
      }
      assert.equal(texture.descriptor.desc.format, 'r32uint');
      assert.deepEqual(texture.descriptor.desc.size, {
        width: 480,
        height: 540,
        depthOrArrayLayers: 1,
      });
      assert.equal(texture.lifecycle.byteEstimate.bytes, 480 * 540 * 4);
      receiverLineage.push({
        textureId,
        readView,
        lightingWork: consumer.workIndex,
        writerWorks: writers.map((work) => work.workIndex),
        sceneColorView: consumer.attachments.colorViewHandleIds[0],
      });
    }
    assert.equal(
      new Set(receiverLineage.map((entry) => entry.textureId)).size,
      2,
      'view lighting must bind distinct primitive-normal textures',
    );
  } else
    assert.equal(
      receiverTextures.length,
      0,
      'Forward must allocate no primitive-normal attachment',
    );
  report.resourceEvidence = {
    digest: tape.digest,
    bytes: tape.bytes.length,
    receiverTextures,
    receiverLineage,
    resourceLifecycle: model.resourceLifecycle,
    boundary:
      'Captured descriptor bytes and recorded resource lifetime; opaque driver allocation and retirement timing are unavailable.',
  };
  h.app.world.set(right, CameraView, { updateInterval: 64 }).unwrap();
  const before = h.app.renderer.inspect().views.find((view) => view.entityKey === right);
  h.app.world.set(right, Transform, { pos: [65, 95, 320] }).unwrap();
  let heldReceipt;
  for (let i = 0; i < 4; i++) heldReceipt = (await h.frame()).receipt;
  const after = h.app.renderer.inspect().views.find((view) => view.entityKey === right);
  assert.equal(after.renderedFrames, before.renderedFrames);
  assert.equal(after.temporal.frameIndex, before.temporal.frameIndex);
  assert.equal((await query(heldReceipt, String(right))).unwrap(), rightHeight);
  assert.equal((await query(heldReceipt, String(right), { expectedAsset: 999999 })).ok, false);
  report.cases.push({ name: 'held-view-frozen-surface', before, after, rightHeight });
  h.app.world.set(right, CameraView, { updateInterval: 1 }).unwrap();
  await h.frame();
  const accepted = h.app.renderer.inspect().views;
  h.app.world.set(h.subjects.camera, CameraView, { viewport: [0, 0, 0.6, 1] }).unwrap();
  h.app.world.update(1 / 60).unwrap();
  reject = true;
  const failed = h.draw();
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'frame-submit-rejected');
  const failedInspection = h.app.renderer.inspect().views;
  assert.deepEqual(
    failedInspection.map((view) => [view.width, view.renderedFrames, view.temporal.frameIndex]),
    accepted.map((view) => [view.width, view.renderedFrames, view.temporal.frameIndex]),
  );
  report.cases.push({
    name: 'rejected-candidate-preserves-accepted-view',
    code: failed.error.code,
    accepted,
    failedInspection,
  });
  report.rejectionEvents = h.errors.slice();
  writeFileSync(
    resolve(dir, 'rejection-events.json'),
    JSON.stringify(report.rejectionEvents, null, 2),
  );
  assert.equal(h.errors.length, 1, 'only the injected before-submit error may be emitted');
  assert.equal(h.errors[0].code, 'device-operation-failed');
  assert.equal(h.errors[0].detail.operation, 'renderer-event');
  assert.equal(h.errors[0].detail.cause.code, 'webgpu-runtime-error');
  assert.equal(h.errors[0].detail.cause.expected, 'terrain views one-shot submit rejection');
  h.errors.length = 0;
  h.app.world.set(h.subjects.camera, CameraView, { viewport: [0, 0, 0.5, 1] }).unwrap();
  const recovered = (await h.frame()).receipt;
  assert(Number.isFinite((await query(recovered, String(right))).unwrap()));
  assert.deepEqual(h.errors, []);
  report.cases.push({ name: 'recovered-view', inspection: h.app.renderer.inspect() });
  // A reused Terrain asset still contributes a separate receiver family. An
  // auxiliary target camera must use the same complete instance roster.
  const terrainData = h.app.world.get(h.subjects.terrain, Terrain).unwrap();
  const spawnForeign = (pos) =>
    h.app.world
      .spawn(
        { component: Transform, data: { pos } },
        { component: Terrain, data: { ...terrainData, forcedLod: 0 } },
      )
      .unwrap();
  const foreign = spawnForeign([3, 1, 0]);
  const target = renderValue(
    h.app.renderer.createRenderTarget({
      shape: '2d',
      width: 160,
      height: 120,
      format: 'rgba8unorm',
      sampleCount: 1,
      mipLevels: 1,
      sampled: true,
      readback: true,
    }),
  );
  const targetHandle = h.app.world.sharedRefs.acquire('RenderTarget', target);
  const captureCamera = h.app.world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [20, 30, 135],
          quat: quat.fromLookAt(quat.create(), [20, 30, 135], [62, 0, 60], [0, 1, 0]),
        },
      },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 3, aspect: 4 / 3, near: 0.1, far: 500 }),
          target: targetHandle,
        },
      },
    )
    .unwrap();
  h.app.world.sharedRefs.release(targetHandle).unwrap();
  for (let i = 0; i < 60; i++) await h.frame();
  const ticket = renderValue(h.app.renderer.requestTargetReadback(target, { mipLevel: 0 }));
  const capturedReceipt = (await h.frame()).receipt;
  const observed = renderValue(
    await h.app.renderer.observe(capturedReceipt, {
      include: ['target-readbacks'],
      targetReadbacks: [ticket],
    }),
  );
  const targetPixels = observed.targetReadbacks?.[0];
  assert(targetPixels?.bytes, 'the auxiliary camera must publish its actual completed target');
  let captureCovered = 0;
  for (let y = 0; y < 120; y++)
    for (let x = 0; x < 160; x++) {
      const offset = y * targetPixels.bytesPerRow + x * 4;
      if (
        targetPixels.bytes[offset] +
          targetPixels.bytes[offset + 1] +
          targetPixels.bytes[offset + 2] >
        30
      )
        captureCovered++;
    }
  assert(captureCovered > 160 * 120 * 0.15, 'a black target cannot establish capture correctness');
  const captureFamilies = async (name) => {
    h.app.world.set(h.subjects.terrain, Terrain, { forcedLod: 2 }).unwrap();
    await h.frame();
    h.app.world.set(h.subjects.terrain, Terrain, { forcedLod: 0 }).unwrap();
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await h.frame();
    (await recorder.frameBoundary()).unwrap();
    const artifact = (await pending).unwrap();
    writeFileSync(resolve(dir, `${name}.rhitape`), artifact.bytes);
    const frame = buildFrameModel(decodeTape(artifact.bytes).unwrap());
    const families = frame.resources.filter(
      (resource) =>
        resource.kind === 'texture' &&
        resource.descriptor?.desc?.label === 'directional-shadow-depth' &&
        resource.descriptor?.desc?.size?.depthOrArrayLayers === 12,
    );
    assert(
      families.length >= 2,
      'both rendered display views must admit all two-root, four-cascade families',
    );
    const targetTexture = frame.resources.find(
      (resource) =>
        resource.kind === 'texture' &&
        resource.descriptor?.desc?.size?.width === 160 &&
        resource.descriptor?.desc?.size?.height === 120 &&
        resource.descriptor?.desc?.format === 'rgba8unorm',
    );
    assert(targetTexture, 'actual capture texture must be in the tape');
    const sourceOfView = (id) =>
      frame.resources.find((resource) => resource.resourceId === id)?.descriptor?.sourceHandleId;
    const captureWorks = frame.works.filter(
      (work) =>
        work.attachments?.colorViewHandleIds.some(
          (id) => sourceOfView(id) === targetTexture.resourceId,
        ) &&
        work.pipeline.shaders.some((shader) => shader.source?.includes('fn terrainDecodeHeight')),
    );
    assert(captureWorks.length > 0, 'the actual target writer must execute Terrain geometry');
    for (const work of captureWorks) {
      const shadowView = work.bindings.find(
        (binding) => binding.groupIndex === 0 && binding.binding === 3,
      )?.resourceId;
      assert(
        families.some((resource) => resource.resourceId === sourceOfView(shadowView)),
        'the auxiliary Terrain receiver must bind a complete two-root shadow family',
      );
    }
    return {
      name,
      digest: artifact.digest,
      familyResources: families.map((resource) => ({
        id: resource.resourceId,
        bytes: resource.lifecycle.byteEstimate,
      })),
      captureWorks: captureWorks.map((work) => work.workIndex),
    };
  };
  report.cases.push({
    name: 'same-guid-roots-and-target-capture',
    original: h.subjects.terrain,
    foreign,
    captureCamera,
    captureCovered,
    ...(await captureFamilies('two-root-target')),
  });
  h.app.world.set(right, CameraView, { updateInterval: 64 }).unwrap();
  const heldBefore = h.app.renderer.inspect().views.find((view) => view.entityKey === right);
  const heldImage = await h.pixels();
  h.app.world.despawn(foreign).unwrap();
  for (let i = 0; i < 3; i++) await h.frame();
  const heldAfter = h.app.renderer.inspect().views.find((view) => view.entityKey === right);
  assert.equal(
    heldAfter.renderedFrames,
    heldBefore.renderedFrames,
    'root removal must not reinterpret a held picture',
  );
  const removedImage = await h.pixels();
  let heldPeak = 0;
  for (let y = 0; y < 540; y++)
    for (let x = 480; x < 960; x++)
      for (let channel = 0; channel < 3; channel++) {
        const offset = (y * 960 + x) * 4 + channel;
        heldPeak = Math.max(heldPeak, Math.abs(heldImage[offset] - removedImage[offset]));
      }
  assert.equal(
    heldPeak,
    0,
    'held view pixels must retain the completed picture across another view roster change',
  );
  const replacement = spawnForeign([5, 1, 0]);
  assert.notEqual(replacement, foreign, 'replacement must have a different actual entity identity');
  h.app.world.set(right, CameraView, { updateInterval: 1 }).unwrap();
  for (let i = 0; i < 60; i++) await h.frame();
  report.cases.push({
    name: 'held-roster-removal-and-identity-replacement',
    heldPeak,
    heldBefore,
    heldAfter,
    foreign,
    replacement,
    ...(await captureFamilies('replacement-target')),
  });
  assert.deepEqual(h.errors, []);
  report.status = 'PASS';
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = 'FAIL';
  report.failure = { message: String(error), code: error.code, detail: error.detail };
  report.events = h.errors.slice();
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
  throw error;
} finally {
  await h.dispose();
  (await recorder.dispose()).unwrap();
}
process.exit(0);
