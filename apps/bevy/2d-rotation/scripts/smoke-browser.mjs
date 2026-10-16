#!/usr/bin/env node

import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReferencePng } from '../../../shared/png-codec.mjs';
import { collectRhiDebugDraws, runRhiDebugBrowserAdmission } from '../../../shared/scripts/rhi-debug-browser-admission.mjs';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const packageName = '@forgeax/bevy-2d-rotation';
const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(appDir, '../../..');

if (process.env.ROTATION_PUBLIC === '1') {
  await verifyDemoCapture({
    pkg: packageName,
    label: 'bevy 2d rotation public captureFrame',
    mode: 'structural',
    capturePrepareHook: '__prepareRotationCapture',
    appDir,
    assertTape: ({ tape }) => assertRotationTape({ events: tape.events, blobPool: tape.blobPool }),
  });
} else {
  const publicCapture = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: repoRoot,
    env: { ...process.env, ROTATION_PUBLIC: '1' },
    stdio: 'inherit',
  });
  if (publicCapture.status !== 0) process.exit(publicCapture.status ?? 1);

  await runRhiDebugBrowserAdmission({
    pkg: packageName,
    label: 'bevy 2d rotation',
    readyHook: '__bevy2dRotationReady',
    capturePrepareHook: '__prepareRotationCapture',
    screenshotPath: resolve(appDir, 'artifacts', 'rotation-rhi-debug.png'),
    triggerLabel: '2d-rotation-public-trigger',
    assertTape: ({ events, blobPool }) => assertRotationTape({ events, blobPool }),
    formatCapture: ({ capture, selected, inspected }) => {
      const rt = assertFreshReplayRt(inspected.rt);
      return (
        `${capture.runId ?? 'remote'} drawOrdinal=${selected.drawOrdinal} ` +
        `actor=${selected.actor} scene=${selected.position.join(',')} ` +
        `actorDraws=${selected.actorDraws} indexCount=${inspected.drawCall.indexCount} rt=${rt}`
      );
    },
  });
}

function assertRotationTape({ events, blobPool }) {
  const { draws, groups, layouts, initialData } = collectRhiDebugDraws(events);
  const buffers = new Map(events.filter((event) => event.kind === 'createBuffer').map((event) => [event.handleId, event]));
  const textureViews = new Map(events.filter((event) => event.kind === 'createTextureView').map((event) => [event.resultHandleId, event]));
  const indexed = draws.filter(({ event }) => event.kind === 'drawIndexed');
  const candidates = indexed.filter(
    (draw) =>
      draw.pass?.colorAttachmentViewHandleIds?.length === 1 &&
      typeof draw.pass.depthStencilViewHandleId === 'string' &&
      draw.event.indexCount === 36 &&
      draw.event.instanceCount > 0 &&
      draw.vertexBuffer !== undefined &&
      draw.indexBuffer !== undefined &&
      ['uint16', 'uint32'].includes(draw.indexBuffer.format) &&
      hasCubePipeline(draw.pipeline) &&
      hasTransformBinding(draw, groups, layouts, buffers) &&
      hasMaterialBinding(draw, groups, layouts, buffers, textureViews),
  );
  if (candidates.length !== 5) {
    throw new Error(`expected five indexed rotation actor draws, got ${candidates.length} of ${indexed.length} indexed draws`);
  }

  const sceneOffsets = dynamicOffsets(candidates, 2, 'scene');
  const materialOffsets = dynamicOffsets(candidates, 1, 'material');
  const sceneGroup = groupAt(candidates[0], 2, groups);
  const materialGroup = groupAt(candidates[0], 1, groups);
  const sceneResource = resourceAt(sceneGroup, 0);
  const materialResource = resourceAt(materialGroup, 0);
  if (sceneResource?.resourceKind !== 'buffer' || materialResource?.resourceKind !== 'buffer') {
    throw new Error('rotation actor transform/material bindings are not buffers');
  }

  const sceneBytes = bytesFor(sceneResource.resourceHandleId, initialData, events, blobPool);
  const materialBytes = bytesFor(materialResource.resourceHandleId, initialData, events, blobPool);
  if (sceneBytes === undefined || materialBytes === undefined) {
    throw new Error('rotation actor transform/material uploads are missing');
  }

  const actorStates = candidates.map((draw, index) => {
    const position = readFloats(sceneBytes, sceneOffsets[index], 16)?.slice(12, 15);
    const color = readFloats(materialBytes, materialOffsets[index], 4);
    if (
      position === undefined ||
      position.some((value) => !Number.isFinite(value)) ||
      color === undefined ||
      color.some((value) => !Number.isFinite(value)) ||
      color[3] <= 0
    ) {
      throw new Error(`rotation actor ${index} has invalid transform/material data`);
    }
    return { draw, position, color };
  });
  const fixedActors = [
    [-320, 0, 1],
    [0, -180, 1],
    [320, 0, 1],
    [0, 180, 1],
  ];
  for (const expected of fixedActors) {
    if (!actorStates.some(({ position }) => nearPosition(position, expected, 1))) {
      throw new Error(`rotation five-actor scene is missing fixed actor ${expected.join(',')}: ${JSON.stringify(actorStates.map((actor) => actor.position))}`);
    }
  }
  const players = actorStates.filter(({ position }) => Math.abs(position[2] - 2) <= 0.1 && Math.abs(position[0]) <= 600 && Math.abs(position[1]) <= 320);
  if (players.length !== 1) throw new Error(`rotation player transform is not uniquely bounded: ${JSON.stringify(actorStates.map((actor) => actor.position))}`);
  if (new Set(actorStates.map(({ color }) => color.map((value) => value.toFixed(4)).join(','))).size !== 5) {
    throw new Error('rotation five-actor material colors are not distinct');
  }

  const selectedActors = actorStates.filter(({ position }) => nearPosition(position, [320, 0, 1], 1));
  if (selectedActors.length !== 1) throw new Error('rotation semantic selector could not identify the right rotate-to-player actor');
  const selected = selectedActors[0];
  assertValidCubeBuffers(selected.draw, buffers, initialData, events, blobPool);

  const rhiErrors = events.filter((event) => typeof event.kind === 'string' && /error/i.test(event.kind));
  if (rhiErrors.length > 0) throw new Error(`rotation tape contains RHI error events: ${JSON.stringify(rhiErrors)}`);

  const drawOrdinal = draws.indexOf(selected.draw);
  console.log(
    `[bevy 2d rotation] semantic selector actorDraws=${candidates.length} drawOrdinal=${drawOrdinal} ` +
      `sceneOffsets=${sceneOffsets.join(',')} materialOffsets=${materialOffsets.join(',')} ` +
      `actor=rotate-to-player-right position=${selected.position.join(',')}`,
  );
  return {
    drawOrdinal,
    actor: 'rotate-to-player-right',
    actorDraws: candidates.length,
    position: selected.position.map((value) => Number(value.toFixed(3))),
  };
}

function hasCubePipeline(pipeline) {
  const vertexBuffers = pipeline?.desc?.vertex?.buffers ?? [];
  const attributes = vertexBuffers.flatMap((buffer) => buffer.attributes ?? []);
  const byLocation = new Map(attributes.map((attribute) => [attribute.shaderLocation, attribute]));
  return (
    vertexBuffers.length === 1 &&
    vertexBuffers[0].arrayStride === 48 &&
    byLocation.get(0)?.offset === 0 &&
    byLocation.get(0)?.format === 'float32x3' &&
    byLocation.get(1)?.offset === 12 &&
    byLocation.get(1)?.format === 'float32x3' &&
    byLocation.get(2)?.offset === 24 &&
    byLocation.get(2)?.format === 'float32x2' &&
    byLocation.get(3)?.offset === 32 &&
    byLocation.get(3)?.format === 'float32x4' &&
    pipeline?.desc?.primitive?.topology === 'triangle-list' &&
    pipeline?.desc?.fragment?.targets?.length === 1 &&
    pipeline.desc.fragment.targets[0].format === 'rgba16float'
  );
}

function hasTransformBinding(draw, groups, layouts, buffers) {
  const meshSet = draw.bindGroups.get(2);
  const meshGroup = meshSet === undefined ? undefined : groups.get(meshSet.bindGroupHandleId);
  const meshLayout = meshGroup === undefined ? undefined : layouts.get(meshGroup.layoutHandleId);
  const meshResource = resourceAt(meshGroup, 0);
  const instanceSet = draw.bindGroups.get(3);
  const instanceGroup = instanceSet === undefined ? undefined : groups.get(instanceSet.bindGroupHandleId);
  const instanceLayout = instanceGroup === undefined ? undefined : layouts.get(instanceGroup.layoutHandleId);
  const instanceResource = resourceAt(instanceGroup, 0);
  return (
    meshLayout?.desc?.label === 'pbr-mesh-array-bgl' &&
    meshResource?.resourceKind === 'buffer' &&
    buffers.has(meshResource.resourceHandleId) &&
    instanceLayout?.desc?.label === 'pbr-instances-bgl' &&
    instanceResource?.resourceKind === 'buffer' &&
    buffers.has(instanceResource.resourceHandleId)
  );
}

function hasMaterialBinding(draw, groups, layouts, buffers, textureViews) {
  const materialSet = draw.bindGroups.get(1);
  const materialGroup = materialSet === undefined ? undefined : groups.get(materialSet.bindGroupHandleId);
  const materialLayout = materialGroup === undefined ? undefined : layouts.get(materialGroup.layoutHandleId);
  const materialBuffer = resourceAt(materialGroup, 0);
  const sampler = resourceAt(materialGroup, 1);
  const textureView = resourceAt(materialGroup, 2);
  return (
    materialLayout?.desc?.label === 'pbr-material-skylight-bgl' &&
    materialBuffer?.resourceKind === 'buffer' &&
    sampler?.resourceKind === 'sampler' &&
    textureView?.resourceKind === 'textureView' &&
    buffers.has(materialBuffer.resourceHandleId) &&
    textureViews.has(textureView.resourceHandleId)
  );
}

function groupAt(draw, groupIndex, groups) {
  const set = draw.bindGroups.get(groupIndex);
  const group = set === undefined ? undefined : groups.get(set.bindGroupHandleId);
  if (group === undefined) throw new Error(`rotation draw is missing bind group ${groupIndex}`);
  return group;
}

function resourceAt(group, binding) {
  if (group === undefined) return undefined;
  const index = group.entries.findIndex((entry) => entry.binding === binding);
  if (index < 0) return undefined;
  const entry = group.entries[index];
  const resourceHandleId = group.resourceHandleIds[index];
  return resourceHandleId === undefined ? undefined : { ...entry, resourceHandleId };
}

function dynamicOffsets(draws, groupIndex, label) {
  const offsets = draws.map((draw) => draw.bindGroups.get(groupIndex)?.dynamicOffsets?.[0]);
  if (
    offsets.some((offset) => !Number.isInteger(offset) || offset < 0 || offset % 256 !== 0) ||
    new Set(offsets).size !== draws.length
  ) {
    throw new Error(`rotation ${label} slices are not distinct and aligned: ${JSON.stringify(offsets)}`);
  }
  return offsets;
}

function bytesFor(handleId, initialData, events, blobPool) {
  const write = [...events].reverse().find((event) => event.kind === 'writeBuffer' && event.handleId === handleId && event.size > 0);
  const seed = initialData.get(handleId);
  const dataHash = write?.dataHash ?? seed?.dataHash;
  return dataHash === undefined ? undefined : blobPool.get(dataHash);
}

function assertValidCubeBuffers(draw, buffers, initialData, events, blobPool) {
  const vertexBuffer = buffers.get(draw.vertexBuffer.bufferHandleId);
  const indexBuffer = buffers.get(draw.indexBuffer.bufferHandleId);
  const vertexBytes = bytesFor(draw.vertexBuffer.bufferHandleId, initialData, events, blobPool);
  const indexBytes = bytesFor(draw.indexBuffer.bufferHandleId, initialData, events, blobPool);
  const vertex = vertexBytes === undefined ? undefined : asBytes(vertexBytes);
  const index = indexBytes === undefined ? undefined : asBytes(indexBytes);
  if (vertexBuffer === undefined || indexBuffer === undefined || vertex === undefined || index === undefined) {
    throw new Error('rotation selected actor is missing captured vertex/index buffers');
  }
  if (vertex.byteLength < 48 || !vertex.some((value) => value !== 0)) throw new Error('rotation selected actor vertex buffer is empty');
  const bytesPerIndex = draw.indexBuffer.format === 'uint16' ? 2 : 4;
  if (index.byteLength < draw.event.indexCount * bytesPerIndex || !index.some((value) => value !== 0)) {
    throw new Error('rotation selected actor index buffer is empty');
  }
  const vertexCount = Math.floor(vertex.byteLength / 48);
  const view = new DataView(index.buffer, index.byteOffset, index.byteLength);
  for (let indexNumber = 0; indexNumber < draw.event.indexCount; indexNumber += 1) {
    const value = bytesPerIndex === 2 ? view.getUint16(indexNumber * 2, true) : view.getUint32(indexNumber * 4, true);
    if (value >= vertexCount) throw new Error(`rotation cube index ${value} exceeds vertex count ${vertexCount}`);
  }
}

function readFloats(blob, byteOffset, count) {
  if (blob === undefined || !Number.isInteger(byteOffset) || byteOffset < 0) return undefined;
  const bytes = asBytes(blob);
  if (byteOffset + count * 4 > bytes.byteLength) return undefined;
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : Uint8Array.from(bytes);
  return Array.from(new Float32Array(aligned.buffer, aligned.byteOffset + byteOffset, count));
}

function nearPosition(actual, expected, epsilon) {
  return actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]) <= epsilon);
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value);
}

function assertFreshReplayRt(rtPath) {
  if (typeof rtPath !== 'string') throw new Error('fresh replay did not return an RT PNG path');
  const absolute = resolve(repoRoot, rtPath);
  if (!existsSync(absolute) || statSync(absolute).size === 0) throw new Error(`fresh replay RT PNG is missing or empty: ${absolute}`);
  const png = readReferencePng(absolute);
  let nonZeroPixels = 0;
  for (let index = 0; index < png.pixels.length; index += 4) {
    if ((png.pixels[index] ?? 0) !== 0 || (png.pixels[index + 1] ?? 0) !== 0 || (png.pixels[index + 2] ?? 0) !== 0) nonZeroPixels += 1;
  }
  if (nonZeroPixels === 0) throw new Error(`fresh replay RT PNG is all zero: ${absolute}`);
  return `${png.width}x${png.height},nonZeroPixels=${nonZeroPixels}`;
}
