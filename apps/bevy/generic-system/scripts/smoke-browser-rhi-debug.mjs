#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectRhiDebugDraws, runRhiDebugBrowserAdmission } from '../../../shared/scripts/rhi-debug-browser-admission.mjs';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const packageName = '@forgeax/bevy-generic-system';
const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(appDir, '../../..');

if (process.env.GENERIC_SYSTEM_PUBLIC === '1') {
  await verifyDemoCapture({
    pkg: packageName,
    label: 'bevy generic_system public captureFrame',
    mode: 'structural',
    capturePrepareHook: '__prepareGenericSystemCapture',
    appDir,
    assertTape: ({ tape }) => assertGenericSystemTape({ events: tape.events, blobPool: tape.blobPool }),
  });
} else {
  const publicCapture = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: repoRoot,
    env: { ...process.env, GENERIC_SYSTEM_PUBLIC: '1' },
    stdio: 'inherit',
  });
  if (publicCapture.status !== 0) process.exit(publicCapture.status ?? 1);
  await runRhiDebugBrowserAdmission({
    pkg: packageName,
    label: 'bevy generic_system',
    readyHook: '__bevyGenericSystemReady',
    capturePrepareHook: '__prepareGenericSystemCapture',
    screenshotPath: resolve(appDir, 'artifacts', 'generic-system-rhi-debug.png'),
    triggerLabel: 'generic-system-public-trigger',
    assertTape: ({ events, blobPool }) => assertGenericSystemTape({ events, blobPool }),
    formatCapture: ({ capture, selected, inspected }) =>
      `${capture.runId ?? 'remote'} drawOrdinal=${selected.drawOrdinal} indexCount=${inspected.drawCall.indexCount} ` +
      `markerDraws=${selected.markerDraws} sceneIds=${selected.sceneIds.join(',')}`,
  });
}

function assertGenericSystemTape({ events, blobPool }) {
  const state = collectRhiDebugDraws(events);
  const markerDraws = state.draws.filter((draw) => isMeshDraw(draw, state.groups) && draw.pass?.colorAttachmentViewHandleIds?.length === 1);
  if (markerDraws.length < 1 || markerDraws.length > 2) {
    throw new Error(`expected one or two generic-system marker draws, got ${markerDraws.length} of ${state.draws.length} draws`);
  }
  const sceneIds = markerDraws.map((marker) => {
    const materialOffset = marker.bindGroups.get(1)?.dynamicOffsets?.[0];
    const sceneBinding = marker.bindGroups.get(2);
    const sceneOffset = sceneBinding?.dynamicOffsets?.[0];
    assertAlignedOffset(materialOffset, 'material');
    assertAlignedOffset(sceneOffset, 'scene');
    const sceneGroup = state.groups.get(sceneBinding?.bindGroupHandleId);
    const sceneBytes = latestBytes(sceneGroup?.resourceHandleIds[0], events, blobPool);
    const matrix = readFloats(sceneBytes, sceneOffset, 16);
    if (matrix === undefined || matrix.some((value) => !Number.isFinite(value))) {
      throw new Error(`generic-system scene slot ${sceneOffset} is empty or invalid`);
    }
    const position = matrix.slice(12, 15).map((value) => Number(value.toFixed(3)));
    const [x, y, z] = position;
    if (Math.abs(y) > 1 || Math.abs(z) > 1 || ![0, 260].some((expectedX) => Math.abs(x - expectedX) <= 1)) {
      throw new Error(`generic-system scene position is outside the cleanup track: ${JSON.stringify(position)}`);
    }
    return `scene:${sceneOffset}:${position.join(',')}`;
  });
  // The public trigger can arrive after the state transition has settled while
  // the live render graph still exposes two geometry records; the durable
  // contract is the persistent marker and valid aligned slices, not a frame
  // boundary between the two cleanup systems.
  const hasPersistentMarker = sceneIds.some((sceneId) => sceneId.split(':').at(-1)?.startsWith('260,'));
  if (!hasPersistentMarker) throw new Error(`generic-system persistent marker is missing: ${JSON.stringify(sceneIds)}`);

  const marker = markerDraws[0];
  const drawOrdinal = state.draws.indexOf(marker);
  console.log(`[bevy generic_system] semantic selector markerDraws=${markerDraws.length} drawOrdinal=${drawOrdinal} sceneIds=${sceneIds.join(',')}`);
  return { drawOrdinal, markerDraws: markerDraws.length, sceneIds };
}

function isMeshDraw(draw, groups) {
  const view = draw.bindGroups.get(0);
  const material = draw.bindGroups.get(1);
  return (
    draw.event.kind === 'drawIndexed' &&
    draw.event.indexCount === 36 &&
    draw.event.instanceCount > 0 &&
    draw.vertexBuffer !== undefined &&
    draw.indexBuffer !== undefined &&
    ['uint16', 'uint32'].includes(draw.indexBuffer.format) &&
    draw.pipeline?.desc?.primitive?.topology === 'triangle-list' &&
    view !== undefined && material !== undefined &&
    groups.has(view.bindGroupHandleId) && groups.has(material.bindGroupHandleId)
  );
}

function assertAlignedOffset(offset, label) {
  if (!Number.isInteger(offset) || offset < 0 || offset % 256 !== 0) {
    throw new Error(`generic-system ${label} dynamic offset is not aligned: ${offset}`);
  }
}

function latestBytes(handleId, events, blobPool) {
  if (handleId === undefined) return undefined;
  const write = [...events].reverse().find((event) => event.kind === 'writeBuffer' && event.handleId === handleId && event.size > 0);
  return write === undefined ? undefined : asBytes(blobPool.get(write.dataHash));
}

function readFloats(bytes, byteOffset, count) {
  const raw = asBytes(bytes);
  if (raw === undefined || !Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset + count * 4 > raw.byteLength) return undefined;
  const aligned = raw.byteOffset % 4 === 0 ? raw : Uint8Array.from(raw);
  return Array.from(new Float32Array(aligned.buffer, aligned.byteOffset + byteOffset, count));
}

function asBytes(value) {
  if (value === undefined) return undefined;
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return undefined;
}
