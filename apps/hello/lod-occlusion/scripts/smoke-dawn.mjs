#!/usr/bin/env node
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { emitSmokeReceipt, smokeFrameBudget } from '../../../shared/scripts/smoke-receipt.mjs';
import { setupGpuShim } from '../../triangle/scripts/smoke-helpers.mjs';
import { loadLodProducerInputs } from './load-lod-producer-inputs.mjs';
import {
  loadLodProducerAssets,
  createLodPhaseProgress,
  observeCompletedReceipt,
  selectedLod,
  summarizeHiddenObservation,
  summarizeLodObservation,
} from './lod-acceptance-evidence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const distRoot = resolve(appRoot, 'dist');
const producerInputDirectory = process.env.FORGEAX_E03_INPUTS_DIR;
const outputRoot = resolve(
  process.env.FORGEAX_E03_EVIDENCE_DIR ?? resolve(appRoot, 'evidence/e03-lod-o'),
);
const frameCount = Math.max(60, smokeFrameBudget(), smokeFrameBudget(process.env.LOD_SMOKE_FRAMES));
const report = {
  taskId: 'E03',
  backend: 'dawn-node',
  requiredCompletedFramesPerPhase: frameCount,
  requiredAcceptedEvidenceFramesPerPhase: frameCount,
  phases: [],
  warmupFrameIds: [],
};

if (!existsSync(resolve(distRoot, 'pack-index.json'))) {
  console.error('[hello-lod-occlusion] FAIL - missing dist/pack-index.json; run build first');
  process.exit(1);
}

if (!producerInputDirectory) {
  console.error(
    '[hello-lod-occlusion] FAIL - FORGEAX_E03_INPUTS_DIR must point to the selected producer manifest directory',
  );
  process.exit(1);
}

const {
  verified: verifiedProducer,
  roles: expectedProducerRoles,
  inputRoot: producerRoot,
  shaderBytes,
} = await loadLodProducerInputs(producerInputDirectory, {
  shaderManifest: resolve(distRoot, 'shaders/manifest.json'),
});
const producerManifest = verifiedProducer.manifest;
report.producerInputs = {
  producerHead: producerManifest.provenance.producerHead,
  manifestSha256: verifiedProducer.sha256,
  sourceSha256: producerManifest.provenance.source.sha256,
  metaSha256: producerManifest.provenance.meta.sha256,
  shaderPublicationSha256: producerManifest.shaderClosure.publication.sha256,
  gpuReadiness: producerManifest.shaderClosure.gpuReadiness,
  admission: producerManifest.admission,
};

mkdirSync(outputRoot, { recursive: true });
const packIndexText = readFileSync(resolve(distRoot, 'pack-index.json'), 'utf8');
const packIndex = decodeCatalogWire(JSON.parse(packIndexText)).unwrap();
const packageFiles = new Map(
  packIndex.map((entry) => [entry.packageUrl, resolve(distRoot, entry.packageUrl.slice(1))]),
);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (request) => {
  const url = new URL(typeof request === 'string' ? request : request.url, 'http://127.0.0.1');
  if (url.pathname === '/pack-index.json') return new Response(packIndexText);
  const packageFile = packageFiles.get(url.pathname);
  if (packageFile !== undefined) return new Response(readFileSync(packageFile));
  const assetFile = resolve(distRoot, url.pathname.slice(1));
  if (existsSync(assetFile)) return new Response(readFileSync(assetFile));
  return originalFetch(request);
};

const shim = await setupGpuShim({
  width: 400,
  height: 300,
  rerunCmd: 'pnpm --filter @forgeax/hello-lod-occlusion smoke',
});
const shaderManifest = new TextDecoder().decode(shaderBytes);
const { createWorldContext, World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import(
  '@forgeax/engine-runtime/internal/renderer-host'
);
const {
  Camera,
  CameraView,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  renderComponentsPlugin,
  Visibility,
  VisibilityStateValue,
} = await import('@forgeax/engine-render');
const { scenePlugin, Transform } = await import('@forgeax/engine-scene');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

let renderer;
const phaseProgress = createLodPhaseProgress();
let phaseToken = phaseProgress.beginPhase('setup', Number.MAX_SAFE_INTEGER);
let lastReceipt;
let revisionFour;
let rootMeshHandle;
let renderEntity;
let world;
let assets;
let meshByIndex;
let cameraIds;
let finalLodEvidence;
let lastLodEvidenceFailure;
try {
  const constructed = await constructRuntimeRendererHost(
    shim.mockCanvas,
    {},
    {
      shaderManifestUrl: `data:application/json,${encodeURIComponent(shaderManifest)}`,
    },
  );
  if (!constructed.ok) throw constructed.error;
  ({ assets, renderer } = constructed.value);
  assets.configurePackIndex('/pack-index.json');
  const producerAdmission = await loadLodProducerAssets(
    assets,
    producerManifest,
    async (path) => new Uint8Array(readFileSync(resolve(producerRoot, path))),
    expectedProducerRoles,
  );
  world = new World({ assets: assets });
  await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);

  meshByIndex = ['root', 'middle', 'lowest'].map((role) => {
    const parsed = AssetGuid.parse(expectedProducerRoles[role]);
    if (!parsed.ok) throw new Error(`LOD sidecar has an invalid ${role} GUID`);
    return parsed.value;
  });
  rootMeshHandle = producerAdmission.root;
  let rootMeshAsset = assets.read(rootMeshHandle).unwrap();
  if (rootMeshAsset.lods?.length !== 1) throw new Error('Initial source must contain root and middle only');
  const materialHandle = world.assets.create(Materials.standard({ baseColor: [0.2, 0.6, 0.95, 1], roughness: 0.5 })).unwrap();
  renderEntity = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: rootMeshHandle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
      { component: Visibility, data: { state: VisibilityStateValue.inherited } },
    )
    .unwrap();
  const nearCamera = spawnCamera(world, 5, [0, 0, 0.5, 1], 0);
  const farCamera = spawnCamera(world, 45, [0.5, 0, 0.5, 1], 1);
  cameraIds = [Number(nearCamera), Number(farCamera)];
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [-0.5, -1, -0.3], intensity: 2, castShadow: false },
    })
    .unwrap();

  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const frameRequest = {
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  };
  const drawCompletedFrame = async () => {
    const drawPhase = phaseToken;
    world.update().unwrap();
    const receipt = await drawReadyFrame(renderer, frameRequest);
    const result = await observeCompletedReceipt(
      receipt,
      (exactReceipt) => renderer.observe(exactReceipt, { include: ['lod-occlusion', 'draws'] }),
      (exactReceipt) => phaseProgress.markCompleted(drawPhase, exactReceipt),
    );
    if (result.status === 'completion-failed')
      throw new Error(`frame completion failed: ${String(result.error)}`);
    const completion = result.completion;
    lastReceipt = receipt;
    let evidence;
    let evidenceFailure;
    if (result.status === 'observation-failed') {
      evidenceFailure = `receipt observation failed: ${String(result.error)}`;
    } else {
      try {
        evidence =
          world.get(renderEntity, Visibility).unwrap().state === VisibilityStateValue.hidden
            ? summarizeHiddenObservation(result.value, receipt, cameraIds, world.identity)
            : summarizeLodObservation(
                result.value,
                receipt,
                cameraIds,
                world.get(renderEntity, MeshFilter).unwrap().assetHandle,
              );
        if (!phaseProgress.accept(drawPhase, completion, evidence)) {
          evidenceFailure = 'completed receipt was duplicate, stale, or belonged to an old phase';
          evidence = undefined;
        }
      } catch (error) {
        evidenceFailure = error instanceof Error ? error.message : String(error);
      }
    }
    if (evidence !== undefined) {
      finalLodEvidence = evidence;
      lastLodEvidenceFailure = undefined;
    } else {
      lastLodEvidenceFailure = { frameId: receipt.frameId, message: evidenceFailure };
    }
    return {
      receipt,
      evidenceReceipt:
        evidence === undefined
          ? undefined
          : {
              frameId: receipt.frameId,
              deviceGeneration: receipt.deviceGeneration,
            },
      evidence,
      evidenceFailure,
    };
  };
  const evidenceFor = (frame) => {
    if (frame.evidence === undefined) {
      throw new Error(
        `no valid same-submit receipt LOD evidence is available: ${JSON.stringify({ frameId: frame.receipt.frameId, message: frame.evidenceFailure ?? lastLodEvidenceFailure })}`,
      );
    }
    return frame.evidence;
  };
  const runPhase = async (name, expected) => {
    phaseToken = phaseProgress.beginPhase(name, frameCount);
    const frameIds = [];
    const acceptedFrameIds = [];
    let lastFrame;
    let phaseEvidenceFrame;
    let attempts = 0;
    while (acceptedFrameIds.length < frameCount && attempts < frameCount + 16) {
      attempts += 1;
      lastFrame = await drawCompletedFrame();
      frameIds.push(lastFrame.receipt.frameId);
      if (lastFrame.evidenceReceipt !== undefined) {
        acceptedFrameIds.push(lastFrame.receipt.frameId);
        phaseEvidenceFrame = lastFrame;
      }
    }
    if (acceptedFrameIds.length !== frameCount || phaseEvidenceFrame === undefined)
      throw new Error(
        `${name} accepted ${acceptedFrameIds.length}/${frameCount} complete same-submit receipt observations: ${JSON.stringify(lastLodEvidenceFailure)}`,
      );
    const evidence = evidenceFor(phaseEvidenceFrame);
    if (new Set(acceptedFrameIds).size !== frameCount)
      throw new Error(`${name} did not produce unique accepted receipt ids`);
    if (
      acceptedFrameIds.some((frameId, index) => index > 0 && frameId <= acceptedFrameIds[index - 1])
    ) {
      throw new Error(`${name} accepted receipt ids are not strictly increasing`);
    }
    if (expected.visible === 0) {
      if (
        world.get(renderEntity, Visibility).unwrap().state !== VisibilityStateValue.hidden ||
        evidence.draws?.status !== 'complete' ||
        evidence.draws.draws.length !== 0 ||
        evidence.aggregate !== undefined
      )
        throw new Error(`${name} requires actual World hiding and empty completed draws`);
    } else if (evidence.aggregate?.visible !== expected.visible) {
      throw new Error(
        `${name} visible count mismatch: expected ${expected.visible}, got ${evidence.aggregate.visible}`,
      );
    }
    if (
      expected.nearLevel !== undefined &&
      selectedLod(evidence.cameraViews[0]) !== expected.nearLevel
    ) {
      throw new Error(
        `${name} near LOD mismatch: expected ${expected.nearLevel}, got ${selectedLod(evidence.cameraViews[0])}`,
      );
    }
    if (
      expected.farLevel !== undefined &&
      selectedLod(evidence.cameraViews[1]) !== expected.farLevel
    ) {
      throw new Error(
        `${name} far LOD mismatch: expected ${expected.farLevel}, got ${selectedLod(evidence.cameraViews[1])}`,
      );
    }
    if (
      expected.farBelow !== undefined &&
      !(selectedLod(evidence.cameraViews[1]) < expected.farBelow)
    ) {
      throw new Error(`${name} far LOD did not fall back below ${expected.farBelow}`);
    }
    const phase = {
      name,
      completedFrames: frameIds.length,
      acceptedEvidenceFrames: acceptedFrameIds.length,
      failedOrRejectedReceiptIds: frameIds.filter((frameId) => !acceptedFrameIds.includes(frameId)),
      firstFrameId: acceptedFrameIds[0],
      lastFrameId: acceptedFrameIds.at(-1),
      acceptedFrameIds,
      evidenceReceipt: phaseEvidenceFrame.evidenceReceipt,
      evidence,
      assetRegistry: {
        rootReady: assets.validate(rootMeshHandle).ok,
        middleReady: rootMeshAsset.lods.length >= 1,
        lowestReady: rootMeshAsset.lods.length >= 2,
      },
      rootMeshResident: assets.validate(rootMeshHandle).ok,
      visibilityState: world.get(renderEntity, Visibility).unwrap().state,
      dynamicGeometryReceipt:
        revisionFour === undefined ? undefined : renderer.dynamicGeometryReceipt(revisionFour),
    };
    report.phases.push(phase);
    writeFileSync(
      resolve(outputRoot, `dawn-${name}.json`),
      `${JSON.stringify(phase, null, 2)}\n`,
      'utf8',
    );
    return phase;
  };

  let fallbackReady = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    phaseToken = phaseProgress.beginPhase(`fallback-warmup-${attempt + 1}`, 1);
    const warmup = await drawCompletedFrame();
    report.warmupFrameIds.push(warmup.receipt.frameId);
    if (warmup.evidence === undefined) continue;
    const evidence = evidenceFor(warmup);
    if (rootMeshAsset.lods.length === 1 && selectedLod(evidence.cameraViews[1]) === 1) {
      fallbackReady = true;
      break;
    }
  }
  if (!fallbackReady)
    throw new Error(
      `not-ready LOD2 did not produce a real per-view finer-LOD fallback: ${JSON.stringify(lastLodEvidenceFailure)}`,
    );
  await runPhase('lod2-not-ready-fallback', { visible: 2, nearLevel: 0, farBelow: 2 });

  const before = assets.snapshot(rootMeshHandle).unwrap();
  const originalWorldIdentity = world.identity;
  await producerAdmission.admitLowest();
  rootMeshAsset = assets.read(rootMeshHandle).unwrap();
  const after = assets.snapshot(rootMeshHandle).unwrap();
  const adoptedNewVersion = after.version(rootMeshHandle).unwrap() > before.version(rootMeshHandle).unwrap();
  before.dispose(); after.dispose();
  if (rootMeshAsset.lods?.length !== 2 || !adoptedNewVersion || world.identity !== originalWorldIdentity || world.get(renderEntity, MeshFilter).unwrap().assetHandle !== rootMeshHandle)
    throw new Error('Expanded source must advance the root version without rebinding the World');
  let residentLevel = false;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    phaseToken = phaseProgress.beginPhase(`resident-warmup-${attempt + 1}`, 1);
    const warmup = await drawCompletedFrame();
    report.warmupFrameIds.push(warmup.receipt.frameId);
    if (warmup.evidence === undefined) continue;
    if (selectedLod(evidenceFor(warmup).cameraViews[1]) === 2) {
      residentLevel = true;
      break;
    }
  }
  if (!residentLevel)
    throw new Error(
      `loaded lowest LOD never became the selected resident GPU LOD: ${JSON.stringify(lastLodEvidenceFailure)}`,
    );
  await runPhase('lod2-ready-resident', { visible: 2, nearLevel: 0, farLevel: 2 });

  const visibleResidency = assets.validate(rootMeshHandle).ok;
  world.set(renderEntity, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
  const hidden = await runPhase('visibility-hidden', { visible: 0 });
  if (hidden.rootMeshResident !== visibleResidency || !hidden.assetRegistry.lowestReady) {
    throw new Error('hiding the renderable changed MeshAsset ownership or AssetRegistry readiness');
  }
  world.set(renderEntity, Visibility, { state: VisibilityStateValue.inherited }).unwrap();
  await runPhase('visibility-restored-resident', { visible: 2, nearLevel: 0, farLevel: 2 });

  const lateMesh = structuredClone(rootMeshAsset);
  const acceptedMesh = structuredClone(rootMeshAsset);
  const lateHandle = world.assets.create(lateMesh).unwrap();
  const acceptedHandle = world.assets.create(acceptedMesh).unwrap();
  const preparedLate = renderer.prepareDynamicGeometry({
    world,
    entity: renderEntity,
    meshHandle: lateHandle,
    revision: 3,
    topologyRevision: 1,
    fixedStep: 0,
  });
  if (!preparedLate.ok)
    throw new Error(`revision 3 preparation failed: ${preparedLate.error.code}`);
  const preparedFour = renderer.prepareDynamicGeometry({
    world,
    entity: renderEntity,
    meshHandle: acceptedHandle,
    revision: 4,
    topologyRevision: 1,
    fixedStep: 0,
  });
  if (!preparedFour.ok) {
    renderer.cancelDynamicGeometry(preparedLate.value).unwrap();
    assets.release(lateHandle).unwrap();
    assets.release(acceptedHandle).unwrap();
    throw new Error(`revision 4 preparation failed: ${preparedFour.error.code}`);
  }
  const acceptedFour = renderer.acceptDynamicGeometry(preparedFour.value, { world, fixedStep: 0 });
  if (!acceptedFour.ok) {
    renderer.cancelDynamicGeometry(preparedLate.value).unwrap();
    renderer.cancelDynamicGeometry(preparedFour.value).unwrap();
    assets.release(lateHandle).unwrap();
    assets.release(acceptedHandle).unwrap();
    throw new Error(`revision 4 acceptance failed: ${acceptedFour.error.code}`);
  }
  assets.release(acceptedHandle).unwrap();
  const acceptedBinding = world.get(renderEntity, MeshFilter).unwrap().assetHandle;
  const lateAcceptance = renderer.acceptDynamicGeometry(preparedLate.value, {
    world,
    fixedStep: 0,
  });
  const retainedBinding = world.get(renderEntity, MeshFilter).unwrap().assetHandle;
  // Accepting revision 4 already cancels the superseded prepared credential.
  assets.release(lateHandle).unwrap();
  if (lateAcceptance.ok || lateAcceptance.error.code !== 'dynamic-geometry-candidate-not-found') {
    throw new Error(
      `superseded revision 3 credential was not rejected: ${lateAcceptance.ok ? 'accepted' : lateAcceptance.error.code}`,
    );
  }
  if (retainedBinding !== acceptedBinding || acceptedBinding !== acceptedFour.value.meshHandle) {
    throw new Error('late revision 3 changed the accepted revision 4 MeshFilter binding');
  }
  revisionFour = acceptedFour.value;
  report.revisionRace = {
    acceptedRevision: acceptedFour.value.revision,
    acceptedBinding,
    lateRevision: preparedLate.value.revision,
    lateError: lateAcceptance.error.code,
    retainedBinding,
  };
  const dynamicPhase = await runPhase('revision-4-keeps-late-3-stale', {
    visible: 2,
    nearLevel: 0,
    farLevel: 2,
  });
  const dynamicReceipt = dynamicPhase.dynamicGeometryReceipt;
  if (
    dynamicReceipt?.revision !== 4 ||
    dynamicReceipt.recordStageConsumed !== true ||
    dynamicReceipt.frameId < dynamicPhase.firstFrameId ||
    dynamicReceipt.frameId > dynamicPhase.lastFrameId
  ) {
    throw new Error(
      `revision 4 lacks a matching consumed Renderer receipt: ${JSON.stringify(dynamicReceipt)}`,
    );
  }

  const inspection = renderer.inspect();
  if (inspection.lodOcclusion === undefined)
    throw new Error('renderer did not publish LOD inspection');
  const mainGpuChannel = inspection.renderScene?.gpuDriven?.channels?.find(
    (channel) => channel.viewPass === 'main',
  );
  if (mainGpuChannel?.lane !== 'gpu' || mainGpuChannel.drawCount <= 0) {
    throw new Error(
      `renderer did not submit the main GPU-driven lane: ${JSON.stringify(mainGpuChannel)}`,
    );
  }
  if (!inspection.output.graphPassNames.includes('gpu-driven.frustum-compact')) {
    throw new Error('renderer did not include the GPU-driven LOD graph passes');
  }
  const passNames = inspection.output.graphPassNames;
  const lateOcclusion =
    passNames.includes('gpu-driven.occlusion-cull') && passNames.includes('main-late');
  if (lateOcclusion !== (inspection.capabilities.firstInstanceIndirect === true)) {
    throw new Error(
      `two-phase GPU occlusion must follow firstInstanceIndirect: ${JSON.stringify(passNames)}`,
    );
  }

  report.status = 'PASS';
  report.completedFrames = phaseProgress.snapshot().totalCompletedFrames;
  report.acceptedEvidenceFrames = phaseProgress.snapshot().totalAcceptedFrames;
  report.backendKind = inspection.capabilities.backendKind;
  report.lateOcclusion = lateOcclusion;
  report.finalInspection = finalLodEvidence;
  writeFileSync(
    resolve(outputRoot, 'dawn-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log(
    `[hello-lod-occlusion] backend=${report.backendKind} phases=${report.phases.length} completedFrames=${report.completedFrames} acceptedEvidenceFrames=${report.acceptedEvidenceFrames} sameSubmitViews=2 lateOcclusion=${lateOcclusion}`,
  );
  emitSmokeReceipt('hello-lod-occlusion/smoke', report.completedFrames);
} catch (error) {
  report.status = 'FAILED';
  report.completedFrames = phaseProgress.snapshot().totalCompletedFrames;
  report.acceptedEvidenceFrames = phaseProgress.snapshot().totalAcceptedFrames;
  report.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (lastReceipt !== undefined) {
    report.lastReceipt = {
      frameId: lastReceipt.frameId,
      deviceGeneration: lastReceipt.deviceGeneration,
    };
    report.lastValidLodEvidence = finalLodEvidence;
    report.lastObservedLodFailure = lastLodEvidenceFailure;
  }
  writeFileSync(
    resolve(outputRoot, 'dawn-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.error(`[hello-lod-occlusion] FAIL - ${report.failure}`);
  throw error;
} finally {
  if (renderer !== undefined) {
    const disposed = await renderer.dispose();
    if (!disposed.ok)
      console.error(`[hello-lod-occlusion] renderer dispose failed: ${disposed.error.code}`);
  }
  shim.renderTarget?.destroy?.();
  shim.sharedDevice?.destroy?.();
  globalThis.fetch = originalFetch;
  delete globalThis.navigator.gpu;
}

function spawnCamera(world, distance, viewport, order) {
  return world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 0, distance], quat: new Float32Array([0, 0, 0, 1]) },
      },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 2 / 3, near: 0.1, far: 100 } },
      { component: CameraView, data: { viewport, order } },
    )
    .unwrap();
}
