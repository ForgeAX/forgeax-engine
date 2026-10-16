#!/usr/bin/env node

import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReferencePng } from '../../../shared/png-codec.mjs';
import { collectRhiDebugDraws, runRhiDebugBrowserAdmission } from '../../../shared/scripts/rhi-debug-browser-admission.mjs';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const packageName = '@forgeax/bevy-2d-shapes';
const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(appDir, '../../..');

if (process.env.SHAPES_PUBLIC === '1') {
  await verifyDemoCapture({
    pkg: packageName,
    label: 'bevy 2d shapes public captureFrame',
    mode: 'structural',
    capturePrepareHook: '__prepare2dShapesCapture',
    appDir,
    assertTape: ({ tape }) => assertShapesTape({ events: tape.events, blobPool: tape.blobPool }),
  });
} else {
  const publicCapture = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: repoRoot,
    env: { ...process.env, SHAPES_PUBLIC: '1' },
    stdio: 'inherit',
  });
  if (publicCapture.status !== 0) process.exit(publicCapture.status ?? 1);

  await runRhiDebugBrowserAdmission({
    pkg: packageName,
    label: 'bevy 2d shapes',
    readyHook: '__bevy2dShapesReady',
    capturePrepareHook: '__prepare2dShapesCapture',
    screenshotPath: resolve(appDir, 'artifacts', '2d-shapes-rhi-debug.png'),
    triggerLabel: '2d-shapes-public-trigger',
    assertTape: ({ events, blobPool }) => assertShapesTape({ events, blobPool }),
    formatCapture: ({ capture, selected, inspected }) => {
      if (inspected.drawCall?.indexCount !== 4 || inspected.drawCall?.instanceCount !== 1) {
        throw new Error(`selected polyline drawCall is incomplete: ${JSON.stringify(inspected.drawCall)}`);
      }
      if (!Array.isArray(inspected.bindings) || inspected.bindings.length < 4) {
        throw new Error(`selected polyline bindings are incomplete: ${JSON.stringify(inspected.bindings)}`);
      }
      const rt = assertFreshReplayRt(inspected.rt);
      return (
        `${capture.runId ?? 'remote'} drawOrdinal=${selected.drawOrdinal} ` +
        `topology=${selected.topology} shapeDraws=${selected.shapeDraws} ` +
        `position=${selected.position.join(',')} indexCount=${inspected.drawCall.indexCount} ` +
        `bindings=${inspected.bindings.length} rt=${rt}`
      );
    },
  });
}

function assertShapesTape({ events, blobPool }) {
  const { draws, groups, layouts, initialData } = collectRhiDebugDraws(events);
  const buffers = new Map(events.filter((event) => event.kind === 'createBuffer').map((event) => [event.handleId, event]));
  const textureViews = new Map(events.filter((event) => event.kind === 'createTextureView').map((event) => [event.resultHandleId, event]));
  const indexed = draws.filter(({ event }) => event.kind === 'drawIndexed');
  const shapeDraws = indexed.filter((draw) => hasShapeDraw(draw, groups, layouts, buffers, textureViews));
  if (shapeDraws.length !== 22) {
    throw new Error(`expected 22 indexed 2d-shapes draws, got ${shapeDraws.length} of ${indexed.length} indexed draws`);
  }

  const polylineCandidates = shapeDraws.filter(
    (draw) => draw.event.indexCount === 4 && draw.pipeline?.desc?.primitive?.topology === 'line-list',
  );
  if (polylineCandidates.length !== 1) {
    throw new Error(`expected one top-row polyline color draw, got ${polylineCandidates.length}`);
  }
  const selected = polylineCandidates[0];
  const sceneGroup = groupAt(selected, 2, groups);
  const materialGroup = groupAt(selected, 1, groups);
  const sceneResource = resourceAt(sceneGroup, 0);
  const materialResource = resourceAt(materialGroup, 0);
  if (sceneResource?.resourceKind !== 'buffer' || materialResource?.resourceKind !== 'buffer') {
    throw new Error('2d-shapes polyline transform/material bindings are not buffers');
  }

  const sceneBytes = bytesFor(sceneResource.resourceHandleId, initialData, events, blobPool);
  const materialBytes = bytesFor(materialResource.resourceHandleId, initialData, events, blobPool);
  if (sceneBytes === undefined || materialBytes === undefined) {
    throw new Error('2d-shapes polyline transform/material uploads are missing');
  }
  const sceneOffset = dynamicOffset(selected, 2, 'scene');
  const materialOffset = dynamicOffset(selected, 1, 'material');
  const position = readFloats(sceneBytes, sceneOffset, 16)?.slice(12, 15);
  const color = readFloats(materialBytes, materialOffset, 4);
  if (
    position === undefined ||
    position.some((value) => !Number.isFinite(value)) ||
    color === undefined ||
    color.some((value) => !Number.isFinite(value)) ||
    color[3] <= 0
  ) {
    throw new Error('2d-shapes polyline transform/material data is invalid');
  }
  if (!nearPosition(position, [500, 75, 1], 1)) {
    throw new Error(`2d-shapes polyline translation is not [500,75,1]: ${JSON.stringify(position)}`);
  }

  assertValidShapeBuffers(selected, buffers, initialData, events, blobPool);
  const rhiErrors = events.filter((event) => typeof event.kind === 'string' && /error/i.test(event.kind));
  if (rhiErrors.length > 0) throw new Error(`2d-shapes tape contains RHI error events: ${JSON.stringify(rhiErrors)}`);

  const drawOrdinal = draws.indexOf(selected);
  if (drawOrdinal < 0) throw new Error('2d-shapes semantic selector lost its captured draw');
  console.log(
    `[bevy 2d shapes] semantic selector shapeDraws=${shapeDraws.length} drawOrdinal=${drawOrdinal} ` +
      `topology=line-list sceneOffset=${sceneOffset} materialOffset=${materialOffset} ` +
      `position=${position.join(',')}`,
  );
  return {
    drawOrdinal,
    shapeDraws: shapeDraws.length,
    topology: 'line-list',
    position: position.map((value) => Number(value.toFixed(3))),
  };
}

function hasShapeDraw(draw, groups, layouts, buffers, textureViews) {
  return (
    draw.pass?.colorAttachmentViewHandleIds?.length === 1 &&
    typeof draw.pass.depthStencilViewHandleId === 'string' &&
    draw.event.instanceCount > 0 &&
    draw.vertexBuffer !== undefined &&
    draw.indexBuffer !== undefined &&
    ['uint16', 'uint32'].includes(draw.indexBuffer.format) &&
    hasShapePipeline(draw.pipeline) &&
    hasViewBinding(draw, groups, layouts) &&
    hasTransformBinding(draw, groups, layouts, buffers) &&
    hasMaterialBinding(draw, groups, layouts, buffers, textureViews)
  );
}

function hasShapePipeline(pipeline) {
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
    ['triangle-list', 'line-list'].includes(pipeline?.desc?.primitive?.topology) &&
    pipeline?.desc?.fragment?.targets?.length === 1 &&
    pipeline.desc.fragment.targets[0].format === 'rgba16float'
  );
}

function hasViewBinding(draw, groups, layouts) {
  const viewSet = draw.bindGroups.get(0);
  const viewGroup = viewSet === undefined ? undefined : groups.get(viewSet.bindGroupHandleId);
  const viewLayout = viewGroup === undefined ? undefined : layouts.get(viewGroup.layoutHandleId);
  return viewLayout?.desc?.label === 'pbr-view-bgl' && viewGroup.entries.length >= 9;
}

function hasTransformBinding(draw, groups, layouts, buffers) {
  return (
    hasCapturedBufferBinding(draw.bindGroups.get(2), groups, layouts, buffers, 'pbr-mesh-array-bgl') &&
    hasCapturedBufferBinding(draw.bindGroups.get(3), groups, layouts, buffers, 'pbr-instances-bgl')
  );
}

function hasCapturedBufferBinding(set, groups, layouts, buffers, layoutLabel) {
  const group = set === undefined ? undefined : groups.get(set.bindGroupHandleId);
  const layout = group === undefined ? undefined : layouts.get(group.layoutHandleId);
  const resource = resourceAt(group, 0);
  return (
    layout?.desc?.label === layoutLabel &&
    resource?.resourceKind === 'buffer' &&
    buffers.has(resource.resourceHandleId)
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
  if (group === undefined) throw new Error(`2d-shapes draw is missing bind group ${groupIndex}`);
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

function dynamicOffset(draw, groupIndex, label) {
  const offset = draw.bindGroups.get(groupIndex)?.dynamicOffsets?.[0];
  if (!Number.isInteger(offset) || offset < 0 || offset % 256 !== 0) {
    throw new Error(`2d-shapes ${label} dynamic offset is invalid: ${offset}`);
  }
  return offset;
}

function bytesFor(handleId, initialData, events, blobPool) {
  const write = [...events].reverse().find((event) => event.kind === 'writeBuffer' && event.handleId === handleId && event.size > 0);
  const seed = initialData.get(handleId);
  const dataHash = write?.dataHash ?? seed?.dataHash;
  return dataHash === undefined ? undefined : blobPool.get(dataHash);
}

function assertValidShapeBuffers(draw, buffers, initialData, events, blobPool) {
  const vertexBuffer = buffers.get(draw.vertexBuffer.bufferHandleId);
  const indexBuffer = buffers.get(draw.indexBuffer.bufferHandleId);
  const vertexBytes = bytesFor(draw.vertexBuffer.bufferHandleId, initialData, events, blobPool);
  const indexBytes = bytesFor(draw.indexBuffer.bufferHandleId, initialData, events, blobPool);
  const vertex = vertexBytes === undefined ? undefined : asBytes(vertexBytes);
  const index = indexBytes === undefined ? undefined : asBytes(indexBytes);
  if (vertexBuffer === undefined || indexBuffer === undefined || vertex === undefined || index === undefined) {
    throw new Error('2d-shapes selected polyline is missing captured vertex/index buffers');
  }
  if (vertex.byteLength < 48 || !vertex.some((value) => value !== 0)) {
    throw new Error('2d-shapes selected polyline vertex buffer is empty');
  }
  const bytesPerIndex = draw.indexBuffer.format === 'uint16' ? 2 : 4;
  const firstIndex = draw.event.firstIndex * bytesPerIndex;
  if (firstIndex < 0 || firstIndex + draw.event.indexCount * bytesPerIndex > index.byteLength) {
    throw new Error('2d-shapes selected polyline index range is outside the captured index buffer');
  }
  if (!index.some((value) => value !== 0)) throw new Error('2d-shapes selected polyline index buffer is empty');
  const vertexCount = Math.floor(vertex.byteLength / 48);
  const view = new DataView(index.buffer, index.byteOffset, index.byteLength);
  for (let indexNumber = 0; indexNumber < draw.event.indexCount; indexNumber += 1) {
    const byteOffset = firstIndex + indexNumber * bytesPerIndex;
    const value = bytesPerIndex === 2 ? view.getUint16(byteOffset, true) : view.getUint32(byteOffset, true);
    const vertexIndex = value + draw.event.baseVertex;
    if (vertexIndex < 0 || vertexIndex >= vertexCount) {
      throw new Error(`2d-shapes selected polyline index ${vertexIndex} exceeds vertex count ${vertexCount}`);
    }
  }
}

function readFloats(blob, byteOffset, count) {
  if (blob === undefined || !Number.isInteger(byteOffset) || byteOffset < 0) return undefined;
  const bytes = asBytes(blob);
  if (byteOffset + count * 4 > bytes.byteLength) return undefined;
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset + byteOffset, count));
}

function nearPosition(actual, expected, epsilon) {
  return actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]) <= epsilon);
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength ? value : value.slice();
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
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
