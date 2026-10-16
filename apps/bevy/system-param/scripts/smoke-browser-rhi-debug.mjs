#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectRhiDebugDraws, runRhiDebugBrowserAdmission } from '../../../shared/scripts/rhi-debug-browser-admission.mjs';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const packageName = '@forgeax/bevy-system-param';
const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(appDir, '../../..');

if (process.env.SYSTEM_PARAM_PUBLIC === '1') {
  await verifyDemoCapture({
    pkg: packageName,
    label: 'bevy system_param public captureFrame',
    mode: 'structural',
    capturePrepareHook: '__prepareSystemParamCapture',
    appDir,
    assertTape: ({ tape }) => assertSystemParamTape({ events: tape.events, blobPool: tape.blobPool }),
  });
} else {
  const publicCapture = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: repoRoot,
    env: { ...process.env, SYSTEM_PARAM_PUBLIC: '1' },
    stdio: 'inherit',
  });
  if (publicCapture.status !== 0) process.exit(publicCapture.status ?? 1);
  await runRhiDebugBrowserAdmission({
    pkg: packageName,
    label: 'bevy system_param',
    readyHook: '__bevySystemParamReady',
    capturePrepareHook: '__prepareSystemParamCapture',
    screenshotPath: resolve(appDir, 'artifacts', 'system-param-rhi-debug.png'),
    triggerLabel: 'system-param-public-trigger',
    assertTape: ({ events, blobPool }) => assertSystemParamTape({ events, blobPool }),
    formatCapture: ({ capture, selected, inspected }) =>
      `${capture.runId ?? 'remote'} drawOrdinal=${selected.drawOrdinal} indexCount=${inspected.drawCall.indexCount} ` +
      `markerDraws=${selected.markerDraws} sceneIds=${selected.sceneIds.join(',')} materialIds=${selected.materialIds.join(',')}`,
  });
}

function assertSystemParamTape({ events, blobPool }) {
  const state = collectRhiDebugDraws(events);
  const markerDraws = state.draws.filter((draw) => isMeshDraw(draw, state.groups) && draw.pass?.colorAttachmentViewHandleIds?.length === 1);
  requireCount(markerDraws, 4, 'three player draws plus one counter draw');
  const materialOffsets = dynamicOffsets(markerDraws, 1, 4, 'material');
  const materialGroup = state.groups.get(markerDraws[0].bindGroups.get(1).bindGroupHandleId);
  if (state.layouts.get(materialGroup?.layoutHandleId)?.desc?.label !== 'pbr-material-skylight-bgl') {
    throw new Error('system-param marker draws are missing the canonical material bind group');
  }
  const materialBytes = latestBytes(materialGroup?.resourceHandleIds[0], events, blobPool);
  if (materialBytes === undefined) throw new Error('system-param material uniform upload is missing');
  const materialIds = materialOffsets.map((offset) => {
    const rgba = readFloats(materialBytes, offset, 4);
    if (rgba === undefined || rgba.some((value) => !Number.isFinite(value)) || rgba[3] <= 0) {
      throw new Error(`system-param material slice ${offset} is empty or invalid`);
    }
    return `material:${offset}:${rgba.map((value) => Number(value.toFixed(4))).join(',')}`;
  });
  if (new Set(materialIds.map((value) => value.slice(value.lastIndexOf(':') + 1))).size < 2) {
    throw new Error(`system-param materials do not distinguish players from counter: ${JSON.stringify(materialIds)}`);
  }

  const sceneDraws = state.draws.filter((draw) => isMeshDraw(draw, state.groups) && draw.pass?.colorAttachmentViewHandleIds?.length === 0);
  requireCount(sceneDraws, 4, 'four scene draws');
  const sceneOffsets = dynamicOffsets(sceneDraws, 2, 4, 'scene');
  const meshGroup = state.groups.get(sceneDraws[0].bindGroups.get(2).bindGroupHandleId);
  const meshBytes = latestBytes(meshGroup?.resourceHandleIds[0], events, blobPool);
  if (meshBytes === undefined) throw new Error('system-param mesh scene upload is missing');
  const sceneIds = sceneOffsets.map((offset) => {
    const matrix = readFloats(meshBytes, offset, 16);
    if (matrix === undefined || matrix.some((value) => !Number.isFinite(value))) {
      throw new Error(`system-param scene slot ${offset} is empty or invalid`);
    }
    return { offset, position: matrix.slice(12, 15).map((value) => Number(value.toFixed(3))) };
  });
  const players = sceneIds.filter(({ position: [x, y, z] }) => Math.abs(y - 120) <= 1 && z === 0 && [-260, -130, 0].some((v) => Math.abs(x - v) <= 1));
  const counter = sceneIds.filter(({ position: [x, y, z] }) => y > -140 && y < -100 && z === 0 && x >= 190 && x <= 330);
  if (players.length !== 3 || counter.length !== 1) {
    throw new Error(`system-param scene positions do not match players plus moving counter: ${JSON.stringify(sceneIds)}`);
  }
  const sceneLabels = sceneIds.map(({ offset, position }) => `scene:${offset}:${position.join(',')}`);
  console.log(`[bevy system_param] semantic selector markerDraws=4 drawOrdinal=${state.draws.indexOf(markerDraws[0])} sceneIds=${sceneLabels.join(',')} materialIds=${materialIds.join(',')}`);
  return {
    drawOrdinal: state.draws.indexOf(markerDraws[0]),
    markerDraws: markerDraws.length,
    sceneIds: sceneLabels,
    materialIds,
  };
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

function requireCount(draws, expected, label) {
  if (draws.length !== expected) throw new Error(`expected ${label}, got ${draws.length}`);
}

function dynamicOffsets(draws, groupIndex, expected, label) {
  const offsets = draws.map((draw) => draw.bindGroups.get(groupIndex)?.dynamicOffsets?.[0]);
  if (offsets.some((offset) => !Number.isInteger(offset) || offset < 0 || offset % 256 !== 0) || new Set(offsets).size !== expected) {
    throw new Error(`system-param ${label} slices are not distinct and aligned: ${JSON.stringify(offsets)}`);
  }
  return offsets;
}

function latestBytes(handleId, events, blobPool) {
  if (handleId === undefined) return undefined;
  const write = [...events].reverse().find((event) => event.kind === 'writeBuffer' && event.handleId === handleId && event.size > 0);
  return write === undefined ? undefined : asBytes(blobPool.get(write.dataHash));
}

function readFloats(bytes, byteOffset, count) {
  const raw = asBytes(bytes);
  if (raw === undefined || byteOffset < 0 || byteOffset + count * 4 > raw.byteLength) return undefined;
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
