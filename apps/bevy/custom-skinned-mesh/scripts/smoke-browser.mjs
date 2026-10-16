#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';
import { collectRhiDebugDraws, runRhiDebugBrowserAdmission } from '../../../shared/scripts/rhi-debug-browser-admission.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(scriptsDir);
const root = resolve(scriptsDir, '..', '..', '..', '..');
const packageName = '@forgeax/bevy-custom-skinned-mesh';

if (process.env.CUSTOM_SKINNED_MESH_PUBLIC === '1') {
  await verifyDemoCapture({
    pkg: packageName,
    label: 'bevy custom_skinned_mesh public captureFrame',
    mode: 'structural',
    capturePrepareHook: '__prepareCustomSkinnedMeshCapture',
    appDir,
    assertTape: ({ tape }) => assertSkinTape({ events: tape.events, blobPool: tape.blobPool }),
  });
} else {
  const publicExit = await runPublicCaptureFrame();
  if (publicExit !== 0) process.exit(publicExit);
  await runRhiDebugBrowserAdmission({
    pkg: packageName,
    label: 'bevy custom_skinned_mesh',
    readyHook: '__bevyCustomSkinnedMeshReady',
    capturePrepareHook: '__prepareCustomSkinnedMeshCapture',
    screenshotPath: resolve(appDir, 'artifacts', 'custom-skinned-mesh-rhi-debug.png'),
    triggerLabel: 'custom-skinned-mesh-public-trigger',
    assertTape: ({ events, blobPool }) => assertSkinTape({ events, blobPool }),
    formatCapture: ({ capture, selected, inspected }) =>
      `${capture.runId ?? 'remote'} drawOrdinal=${selected.drawOrdinal} indexCount=${inspected.drawCall.indexCount} bindings=${inspected.bindings.length} paletteBytes=${selected.paletteBytes}`,
  });
}

function runPublicCaptureFrame() {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: root,
      env: { ...process.env, CUSTOM_SKINNED_MESH_PUBLIC: '1' },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
}

function assertSkinTape({ events, blobPool }) {
  const { draws, groups, layouts, initialData } = collectRhiDebugDraws(events);
  const indexed = draws.filter(({ event }) => event.kind === 'drawIndexed');
  const skinDraws = indexed.filter(
    (draw) =>
      draw.pass?.colorAttachmentViewHandleIds?.length === 1 &&
      typeof draw.pass.depthStencilViewHandleId === 'string' &&
      draw.vertexBuffer !== undefined &&
      draw.indexBuffer !== undefined &&
      hasSkinAttributes(draw.pipeline),
  );
  if (skinDraws.length !== 6) throw new Error(`expected six semantically selected skinned draws, got ${skinDraws.length} of ${indexed.length} indexed draws`);
  const selected = skinDraws[0];
  if (selected.event.indexCount <= 0 || selected.event.instanceCount <= 0 || !['uint16', 'uint32'].includes(selected.indexBuffer.format)) {
    throw new Error(`selected skinned draw is not a valid indexed draw: ${JSON.stringify(selected.event)}`);
  }
  assertNonEmptyBuffer(selected.vertexBuffer.bufferHandleId, initialData, blobPool, 'vertex');
  assertNonEmptyBuffer(selected.indexBuffer.bufferHandleId, initialData, blobPool, 'index');

  const materialSet = selected.bindGroups.get(1);
  const materialGroup = materialSet === undefined ? undefined : groups.get(materialSet.bindGroupHandleId);
  const materialLayout = materialGroup === undefined ? undefined : layouts.get(materialGroup.layoutHandleId);
  if (materialLayout?.desc?.label !== 'pbr-material-skylight-bgl') throw new Error('selected skinned draw is missing the canonical PBR material bind group');
  const materialKinds = new Set(materialGroup.entries.map((entry) => entry.resourceKind));
  if (!materialKinds.has('buffer') || !materialKinds.has('sampler') || !materialKinds.has('textureView')) {
    throw new Error(`selected skinned material bind group lacks uniform/texture/sampler bindings: ${JSON.stringify([...materialKinds])}`);
  }

  const skinSet = selected.bindGroups.get(2);
  const skinGroup = skinSet === undefined ? undefined : groups.get(skinSet.bindGroupHandleId);
  const skinLayout = skinGroup === undefined ? undefined : layouts.get(skinGroup.layoutHandleId);
  if (skinLayout?.desc?.label !== 'pbr-skin-mesh-array-bgl') throw new Error('selected skinned draw is missing the two-binding skin mesh layout');
  const paletteEntry = skinGroup.entries.find((entry) => entry.binding === 1);
  const meshEntry = skinGroup.entries.find((entry) => entry.binding === 0);
  if (paletteEntry?.resourceKind !== 'buffer' || paletteEntry.bufferSize !== 16320 || meshEntry?.resourceKind !== 'buffer') {
    throw new Error(`skin bind group does not expose mesh + 16320-byte palette windows: ${JSON.stringify(skinGroup.entries)}`);
  }
  if (!Array.isArray(skinSet.dynamicOffsets) || skinSet.dynamicOffsets.length !== 2 || skinSet.dynamicOffsets.some((offset) => !Number.isInteger(offset) || offset < 0 || offset % 256 !== 0)) {
    throw new Error(`skin bind group dynamic offsets are not two aligned values: ${JSON.stringify(skinSet.dynamicOffsets)}`);
  }

  const skinHandles = new Set(skinGroup.resourceHandleIds);
  const paletteWrite = [...events]
    .reverse()
    .find((event) => event.kind === 'writeBuffer' && skinHandles.has(event.handleId) && event.size >= 512);
  if (paletteWrite === undefined) throw new Error('selected skin bind group has no non-trivial joint-palette upload');
  const paletteBytes = blobPool.get(paletteWrite.dataHash);
  const paletteView = paletteBytes === undefined
    ? undefined
    : paletteBytes instanceof Uint8Array
      ? paletteBytes
      : new Uint8Array(paletteBytes);
  if (paletteView === undefined || paletteView.byteLength < 512 || paletteView.every((value) => value === 0)) {
    throw new Error('selected skin joint-palette upload is empty or all zero');
  }
  const paletteFloats = floatsFor(paletteView);
  const poseDelta = matrixDeltas(paletteFloats).some((delta) => delta > 0.001);
  if (!poseDelta) throw new Error('selected skin joint-palette upload contains only identity matrices');

  const drawOrdinal = draws.indexOf(selected);
  console.log(`[bevy custom_skinned_mesh] semantic selector skinDraws=${skinDraws.length} materialBindings=${materialKinds.size} paletteBytes=${paletteWrite.size} drawOrdinal=${drawOrdinal}`);
  return { drawOrdinal, paletteBytes: paletteWrite.size };
}

function hasSkinAttributes(pipeline) {
  const attributes = pipeline?.desc?.vertex?.buffers?.flatMap((buffer) => buffer.attributes ?? []) ?? [];
  return attributes.some((attribute) => attribute.shaderLocation === 4 && attribute.format === 'uint16x4') && attributes.some((attribute) => attribute.shaderLocation === 5 && attribute.format === 'float32x4');
}

function assertNonEmptyBuffer(handleId, initialData, blobPool, label) {
  const seed = initialData.get(handleId);
  const blob = seed === undefined ? undefined : blobPool.get(seed.dataHash);
  const bytes = blob === undefined ? undefined : blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (bytes === undefined || bytes.byteLength === 0 || bytes.every((value) => value === 0)) throw new Error(`selected skinned ${label} buffer has no non-zero captured data`);
}

function floatsFor(blob) {
  if (blob === undefined || blob.byteLength < 4) return undefined;
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : Uint8Array.from(bytes);
  return new Float32Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 4));
}

function matrixDeltas(floats) {
  if (floats === undefined) return [];
  const deltas = [];
  for (let offset = 0; offset + 16 <= floats.length; offset += 16) {
    let delta = 0;
    for (let index = 0; index < 16; index += 1) delta += Math.abs(floats[offset + index] - (index % 5 === 0 ? 1 : 0));
    deltas.push(delta);
  }
  return deltas;
}
