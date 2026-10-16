#!/usr/bin/env node

import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReferencePng } from '../../../shared/png-codec.mjs';
import { collectRhiDebugDraws, runRhiDebugBrowserAdmission } from '../../../shared/scripts/rhi-debug-browser-admission.mjs';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const packageName = '@forgeax/bevy-animated-material';
const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(appDir, '../../..');

if (process.env.ANIMATED_MATERIAL_PUBLIC === '1') {
  await verifyDemoCapture({
    pkg: packageName,
    label: 'bevy animated_material public captureFrame',
    mode: 'structural',
    capturePrepareHook: '__prepareAnimatedMaterialCapture',
    appDir,
    assertTape: ({ tape }) => assertAnimatedMaterialTape({ events: tape.events, blobPool: tape.blobPool }),
  });
} else {
  const publicCapture = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: repoRoot,
    env: { ...process.env, ANIMATED_MATERIAL_PUBLIC: '1' },
    stdio: 'inherit',
  });
  if (publicCapture.status !== 0) process.exit(publicCapture.status ?? 1);

  await runRhiDebugBrowserAdmission({
    pkg: packageName,
    label: 'bevy animated_material',
    readyHook: '__bevyAnimatedMaterialReady',
    capturePrepareHook: '__prepareAnimatedMaterialCapture',
    screenshotPath: resolve(appDir, 'artifacts', 'animated-material-rhi-debug.png'),
    triggerLabel: 'animated-material-public-trigger',
    assertTape: ({ events, blobPool }) => assertAnimatedMaterialTape({ events, blobPool }),
    formatCapture: ({ capture, selected, inspected }) => {
      const rt = assertFreshReplayRt(inspected.rt);
      return (
        `${capture.runId ?? 'remote'} drawOrdinal=${selected.drawOrdinal} ` +
        `cubeDraws=${selected.cubeDraws} indexCount=${inspected.drawCall.indexCount} ` +
        `materialOffsets=${selected.materialOffsets.join(',')} ` +
        `baseColors=${selected.baseColors.join('|')} rt=${rt}`
      );
    },
  });
}

function assertAnimatedMaterialTape({ events, blobPool }) {
  const { draws, groups, layouts, initialData } = collectRhiDebugDraws(events);
  const buffers = new Map(events.filter((event) => event.kind === 'createBuffer').map((event) => [event.handleId, event]));
  const textures = new Map(events.filter((event) => event.kind === 'createTexture').map((event) => [event.handleId, event]));
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
      hasMeshBinding(draw, groups, layouts) &&
      hasStandardMaterialBinding(draw, groups, layouts, buffers, textureViews),
  );
  if (candidates.length !== 9) {
    throw new Error(`expected nine animated-material color draws, got ${candidates.length} of ${indexed.length} indexed draws`);
  }

  const materialOffsets = dynamicOffsets(candidates, 1, 'material');
  const sceneOffsets = dynamicOffsets(candidates, 2, 'scene cube');
  const selected = candidates[0];
  assertNonEmptyBuffer(selected.vertexBuffer.bufferHandleId, initialData, events, blobPool, 'vertex');
  assertNonEmptyBuffer(selected.indexBuffer.bufferHandleId, initialData, events, blobPool, 'index');

  const materialGroup = groupAt(selected, 1, groups);
  const materialBuffer = resourceAt(materialGroup, 0);
  const baseColorSampler = resourceAt(materialGroup, 1);
  const baseColorTextureView = resourceAt(materialGroup, 2);
  if (
    materialBuffer?.resourceKind !== 'buffer' ||
    baseColorSampler?.resourceKind !== 'sampler' ||
    baseColorTextureView?.resourceKind !== 'textureView'
  ) {
    throw new Error('animated-material StandardMaterial is missing baseColor buffer/sampler/texture bindings');
  }
  const materialBytes = bytesFor(materialBuffer.resourceHandleId, initialData, events, blobPool);
  const baseColors = materialOffsets.map((offset) => readFloats(materialBytes, offset, 4));
  if (
    baseColors.some(
      (color) =>
        color === undefined ||
        color.some((value) => !Number.isFinite(value) || value < 0 || value > 1) ||
        color[3] <= 0,
    )
  ) {
    throw new Error(`animated-material baseColor slices are empty or invalid: ${JSON.stringify(baseColors)}`);
  }
  const baseColorIds = new Set(baseColors.map((color) => color.map((value) => value.toFixed(4)).join(',')));
  if (baseColorIds.size < 3) throw new Error(`animated-material baseColor slices are not dynamic: ${JSON.stringify(baseColors)}`);

  const materialTextureView = textureViews.get(baseColorTextureView.resourceHandleId);
  const baseColorTexture = materialTextureView === undefined ? undefined : textures.get(materialTextureView.sourceHandleId);
  if (baseColorTexture === undefined) throw new Error('animated-material baseColor binding has no captured texture');
  const textureBytes = bytesFor(baseColorTexture.handleId, initialData, events, blobPool);
  if (textureBytes === undefined || asBytes(textureBytes).every((value) => value === 0)) {
    throw new Error('animated-material baseColor texture upload is empty');
  }

  const shaderHandle = selected.pipeline?.fragmentShaderModuleHandleId;
  const shader = events.find((event) => event.kind === 'createShaderModule' && event.handleId === shaderHandle);
  if (typeof shader?.wgslCode !== 'string' || !shader.wgslCode.includes('struct Material') || !shader.wgslCode.includes('baseColor')) {
    throw new Error('animated-material draw is missing the StandardMaterial/baseColor shader contract');
  }
  const rhiErrors = events.filter((event) => typeof event.kind === 'string' && /error/i.test(event.kind));
  if (rhiErrors.length > 0) throw new Error(`animated-material tape contains RHI error events: ${JSON.stringify(rhiErrors)}`);

  const drawOrdinal = draws.indexOf(selected);
  const materialIds = baseColors.map((color, index) => `${materialOffsets[index]}:${color.map((value) => value.toFixed(4)).join(',')}`);
  console.log(
    `[bevy animated_material] semantic selector cubeDraws=${candidates.length} drawOrdinal=${drawOrdinal} ` +
      `sceneOffsets=${sceneOffsets.join(',')} materialOffsets=${materialOffsets.join(',')} ` +
      `materialTexture=${baseColorTexture.handleId}`,
  );
  return { drawOrdinal, cubeDraws: candidates.length, materialOffsets, sceneOffsets, baseColors: materialIds };
}

function hasCubePipeline(pipeline) {
  const buffers = pipeline?.desc?.vertex?.buffers ?? [];
  const attributes = buffers.flatMap((buffer) => buffer.attributes ?? []);
  const byLocation = new Map(attributes.map((attribute) => [attribute.shaderLocation, attribute.format]));
  return (
    buffers.length === 1 &&
    buffers[0].arrayStride === 48 &&
    byLocation.get(0) === 'float32x3' &&
    byLocation.get(1) === 'float32x3' &&
    byLocation.get(2) === 'float32x2' &&
    byLocation.get(3) === 'float32x4' &&
    pipeline?.desc?.primitive?.topology === 'triangle-list' &&
    pipeline?.desc?.fragment?.targets?.length === 1 &&
    pipeline.desc.fragment.targets[0].format === 'rgba16float'
  );
}

function hasMeshBinding(draw, groups, layouts) {
  const meshSet = draw.bindGroups.get(2);
  const meshGroup = meshSet === undefined ? undefined : groups.get(meshSet.bindGroupHandleId);
  const meshLayout = meshGroup === undefined ? undefined : layouts.get(meshGroup.layoutHandleId);
  return meshLayout?.desc?.label === 'pbr-mesh-array-bgl' && resourceAt(meshGroup, 0)?.resourceKind === 'buffer';
}

function hasStandardMaterialBinding(draw, groups, layouts, buffers, textureViews) {
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
  if (group === undefined) throw new Error(`animated-material draw is missing bind group ${groupIndex}`);
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
    throw new Error(`animated-material ${label} slices are not distinct and aligned: ${JSON.stringify(offsets)}`);
  }
  return offsets;
}

function bytesFor(handleId, initialData, events, blobPool) {
  if (handleId === undefined) return undefined;
  const write = [...events].reverse().find(
    (event) => (event.kind === 'writeBuffer' || event.kind === 'writeTexture') &&
      (event.handleId === handleId || event.destination?.textureHandleId === handleId) &&
      event.size !== 0,
  );
  const seed = initialData.get(handleId);
  const dataHash = write?.dataHash ?? seed?.dataHash;
  return dataHash === undefined ? undefined : blobPool.get(dataHash);
}

function assertNonEmptyBuffer(handleId, initialData, events, blobPool, label) {
  const bytes = bytesFor(handleId, initialData, events, blobPool);
  const view = bytes === undefined ? undefined : asBytes(bytes);
  if (view === undefined || view.byteLength === 0 || view.every((value) => value === 0)) {
    throw new Error(`selected animated-material ${label} buffer has no non-zero captured data`);
  }
}

function readFloats(blob, byteOffset, count) {
  if (blob === undefined) return undefined;
  const bytes = asBytes(blob);
  if (byteOffset < 0 || byteOffset + count * 4 > bytes.byteLength) return undefined;
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : Uint8Array.from(bytes);
  return Array.from(new Float32Array(aligned.buffer, aligned.byteOffset + byteOffset, count));
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
