#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';
import { collectRhiDebugDraws, runRhiDebugBrowserAdmission } from '../../../shared/scripts/rhi-debug-browser-admission.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(scriptsDir);
const root = resolve(scriptsDir, '..', '..', '..', '..');
const packageName = '@forgeax/bevy-update-gltf-scene';

if (process.env.UPDATE_GLTF_SCENE_PUBLIC === '1') {
  await verifyDemoCapture({
    pkg: packageName,
    label: 'bevy update_gltf_scene public captureFrame',
    mode: 'structural',
    capturePrepareHook: '__prepareUpdateGltfSceneCapture',
    appDir,
    assertTape: ({ tape }) => assertSceneTape({ events: tape.events, blobPool: tape.blobPool }),
  });
} else {
  const publicExit = await runPublicCaptureFrame();
  if (publicExit !== 0) process.exit(publicExit);
  await runRhiDebugBrowserAdmission({
    pkg: packageName,
    label: 'bevy update_gltf_scene',
    readyHook: '__bevyUpdateGltfSceneReady',
    capturePrepareHook: '__prepareUpdateGltfSceneCapture',
    screenshotPath: resolve(appDir, 'artifacts', 'update-gltf-scene-rhi-debug.png'),
    triggerLabel: 'update-gltf-scene-public-trigger',
    assertTape: ({ events, blobPool }) => assertSceneTape({ events, blobPool }),
    formatCapture: ({ capture, selected, inspected }) =>
      `${capture.runId ?? 'remote'} drawOrdinal=${selected.drawOrdinal} indexCount=${inspected.drawCall.indexCount} bindings=${inspected.bindings.length} modelTranslation=${JSON.stringify(selected.modelTranslation)}`,
  });
}

function runPublicCaptureFrame() {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: root,
      env: { ...process.env, UPDATE_GLTF_SCENE_PUBLIC: '1' },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
}

function assertSceneTape({ events, blobPool }) {
  const { draws, groups, layouts, initialData } = collectRhiDebugDraws(events);
  const indexed = draws.filter(({ event }) => event.kind === 'drawIndexed');
  const scene = indexed.filter(
    (draw) =>
      draw.pass?.colorAttachmentViewHandleIds?.length === 1 &&
      typeof draw.pass.depthStencilViewHandleId === 'string' &&
      draw.vertexBuffer !== undefined &&
      draw.indexBuffer !== undefined &&
      hasPositionNormalUv(draw.pipeline),
  );
  if (scene.length !== 1) throw new Error(`expected one semantically selected glTF mesh draw, got ${scene.length} of ${indexed.length} indexed draws`);
  const selected = scene[0];
  if (selected.event.indexCount <= 0 || selected.event.instanceCount <= 0 || !['uint16', 'uint32'].includes(selected.indexBuffer.format)) {
    throw new Error(`selected glTF mesh draw is not a valid indexed draw: ${JSON.stringify(selected.event)}`);
  }
  assertNonEmptyBuffer(selected.vertexBuffer.bufferHandleId, initialData, blobPool, 'vertex');
  assertNonEmptyBuffer(selected.indexBuffer.bufferHandleId, initialData, blobPool, 'index');

  const materialSet = selected.bindGroups.get(1);
  const materialGroup = materialSet === undefined ? undefined : groups.get(materialSet.bindGroupHandleId);
  const materialLayout = materialGroup === undefined ? undefined : layouts.get(materialGroup.layoutHandleId);
  if (materialLayout?.desc?.label !== 'pbr-material-skylight-bgl') throw new Error('selected glTF mesh draw is missing the canonical PBR material bind group');
  const materialKinds = new Set(materialGroup.entries.map((entry) => entry.resourceKind));
  if (!materialKinds.has('buffer') || !materialKinds.has('sampler') || !materialKinds.has('textureView')) {
    throw new Error(`selected glTF material bind group lacks uniform/texture/sampler bindings: ${JSON.stringify([...materialKinds])}`);
  }
  const materialBuffer = materialGroup.resourceHandleIds[0];
  const materialWrite = latestWrite(events, materialBuffer);
  const materialFloats = materialWrite === undefined ? undefined : floatsFor(blobPool.get(materialWrite.dataHash));
  if (materialFloats === undefined || materialFloats.length < 4 || materialFloats.slice(0, 4).some((value) => !Number.isFinite(value)) || materialFloats[3] <= 0) {
    throw new Error('selected glTF material binding has no finite non-zero material uniform');
  }

  const meshSet = selected.bindGroups.get(2);
  const meshGroup = meshSet === undefined ? undefined : groups.get(meshSet.bindGroupHandleId);
  const meshLayout = meshGroup === undefined ? undefined : layouts.get(meshGroup.layoutHandleId);
  if (meshLayout?.desc?.label !== 'pbr-mesh-array-bgl') throw new Error('selected glTF mesh draw is missing the mesh/model storage binding');
  const modelBuffer = meshGroup.resourceHandleIds[0];
  const modelWrite = latestWrite(events, modelBuffer);
  const modelFloats = modelWrite === undefined ? undefined : floatsFor(blobPool.get(modelWrite.dataHash));
  if (modelFloats === undefined || modelFloats.length < 16 || modelFloats.slice(0, 16).some((value) => !Number.isFinite(value))) {
    throw new Error('selected glTF mesh draw has no finite model matrix');
  }
  const modelMatrix = modelFloats.slice(0, 16);
  const identityDelta = modelMatrix.reduce((sum, value, index) => sum + Math.abs(value - (index % 5 === 0 ? 1 : 0)), 0);
  if (identityDelta <= 0.001) throw new Error(`selected glTF model transform is identity: ${JSON.stringify(modelMatrix)}`);

  const drawOrdinal = draws.indexOf(selected);
  const modelTranslation = [modelMatrix[12], modelMatrix[13], modelMatrix[14]];
  console.log(`[bevy update_gltf_scene] semantic selector indexed=1 materialBindings=${materialKinds.size} modelTranslation=${JSON.stringify(modelTranslation)} drawOrdinal=${drawOrdinal}`);
  return { drawOrdinal, modelTranslation };
}

function hasPositionNormalUv(pipeline) {
  const attributes = pipeline?.desc?.vertex?.buffers?.flatMap((buffer) => buffer.attributes ?? []) ?? [];
  const locations = new Set(attributes.map((attribute) => attribute.shaderLocation));
  return locations.has(0) && locations.has(1) && locations.has(2) && pipeline?.desc?.fragment?.targets?.length === 1;
}

function latestWrite(events, handleId) {
  return [...events].reverse().find((event) => event.kind === 'writeBuffer' && event.handleId === handleId && event.size >= 16);
}

function floatsFor(blob) {
  if (blob === undefined || blob.byteLength < 4) return undefined;
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : Uint8Array.from(bytes);
  return new Float32Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 4));
}

function assertNonEmptyBuffer(handleId, initialData, blobPool, label) {
  const seed = initialData.get(handleId);
  const blob = seed === undefined ? undefined : blobPool.get(seed.dataHash);
  const bytes = blob === undefined ? undefined : blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (bytes === undefined || bytes.byteLength === 0 || bytes.every((value) => value === 0)) throw new Error(`selected glTF ${label} buffer has no non-zero captured data`);
}
