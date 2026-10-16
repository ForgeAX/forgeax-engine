#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';
import { collectRhiDebugDraws, runRhiDebugBrowserAdmission } from '../../../shared/scripts/rhi-debug-browser-admission.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(scriptsDir);
const root = resolve(scriptsDir, '..', '..', '..', '..');
const packageName = '@forgeax/bevy-shader-material-2d';

if (process.env.SHADER_MATERIAL_2D_PUBLIC === '1') {
  await verifyDemoCapture({
    pkg: packageName,
    label: 'bevy shader_material_2d public captureFrame',
    mode: 'structural',
    capturePrepareHook: '__prepareShaderMaterial2dCapture',
    appDir,
    assertTape: ({ tape }) => assertShaderMaterialTape({ events: tape.events, blobPool: tape.blobPool }),
  });
} else {
  const publicExit = await runPublicCaptureFrame();
  if (publicExit !== 0) process.exit(publicExit);
  await runRhiDebugBrowserAdmission({
    pkg: packageName,
    label: 'bevy shader_material_2d',
    readyHook: '__bevyShaderMaterial2dReady',
    capturePrepareHook: '__prepareShaderMaterial2dCapture',
    screenshotPath: resolve(appDir, 'artifacts', 'shader-material-2d-rhi-debug.png'),
    triggerLabel: 'shader-material-2d-public-trigger',
    assertTape: ({ events, blobPool }) => assertShaderMaterialTape({ events, blobPool }),
    formatCapture: ({ capture, selected, inspected }) =>
      `${capture.runId ?? 'remote'} drawOrdinal=${selected.drawOrdinal} indexCount=${inspected.drawCall.indexCount} ` +
      `bindings=${inspected.bindings.length} materialBuffer=${selected.materialBuffer} texture=${selected.texture} sampler=${selected.sampler}`,
  });
}

function runPublicCaptureFrame() {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: root,
      env: { ...process.env, SHADER_MATERIAL_2D_PUBLIC: '1' },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
}

function assertShaderMaterialTape({ events, blobPool }) {
  const { draws, groups, layouts, initialData } = collectRhiDebugDraws(events);
  const buffers = new Map(events.filter((event) => event.kind === 'createBuffer').map((event) => [event.handleId, event]));
  const textures = new Map(events.filter((event) => event.kind === 'createTexture').map((event) => [event.handleId, event]));
  const textureViews = new Map(events.filter((event) => event.kind === 'createTextureView').map((event) => [event.resultHandleId, event]));
  const samplers = new Map(events.filter((event) => event.kind === 'createSampler').map((event) => [event.handleId, event]));
  const shaderModules = events.filter((event) => event.kind === 'createShaderModule');
  const customShaders = shaderModules.filter(
    (event) =>
      typeof event.wgslCode === 'string' &&
      event.wgslCode.includes('baseColorTexture') &&
      event.wgslCode.includes('MaterialParameters') &&
      event.wgslCode.includes('discard'),
  );
  if (customShaders.length !== 1) throw new Error(`expected one captured shader_material_2d WGSL module, got ${customShaders.length}`);
  const customShaderHandles = new Set([customShaders[0].handleId]);
  const indexed = draws.filter(({ event }) => event.kind === 'drawIndexed');
  const candidates = indexed.filter(
    (draw) =>
      draw.pass?.colorAttachmentViewHandleIds?.length === 1 &&
      typeof draw.pass.depthStencilViewHandleId === 'string' &&
      draw.vertexBuffer !== undefined &&
      draw.indexBuffer !== undefined &&
      hasShaderMaterialPipeline(draw.pipeline, customShaderHandles) &&
      findMaterialBinding(draw, groups, layouts, buffers, textures, textureViews, samplers, initialData, events, blobPool) !== undefined,
  );
  if (candidates.length !== 1) {
    throw new Error(`expected one semantically selected shader_material_2d draw, got ${candidates.length} of ${indexed.length} indexed draws`);
  }
  const selected = candidates[0];
  if (selected.event.indexCount !== 6 || selected.event.instanceCount <= 0 || !['uint16', 'uint32'].includes(selected.indexBuffer.format)) {
    throw new Error(`selected shader_material_2d draw is not a non-empty indexed quad: ${JSON.stringify(selected.event)}`);
  }
  assertNonEmptyBuffer(selected.vertexBuffer.bufferHandleId, initialData, events, blobPool, 'vertex');
  assertNonEmptyBuffer(selected.indexBuffer.bufferHandleId, initialData, events, blobPool, 'index');

  const material = findMaterialBinding(selected, groups, layouts, buffers, textures, textureViews, samplers, initialData, events, blobPool);
  if (material === undefined) throw new Error('selected shader_material_2d draw has no material binding');
  const materialBuffer = resourceAt(material.group, 0);
  const materialSampler = resourceAt(material.group, 1);
  const materialTextureView = resourceAt(material.group, 2);
  if (materialBuffer?.resourceKind !== 'buffer' || materialSampler?.resourceKind !== 'sampler' || materialTextureView?.resourceKind !== 'textureView') {
    throw new Error(`selected shader_material_2d material bindings are incomplete: ${JSON.stringify(material.group.entries)}`);
  }
  const materialFloats = floatsFor(bufferBytes(materialBuffer.resourceHandleId, initialData, events, blobPool));
  if (materialFloats === undefined || !nearColor(materialFloats, [srgbToLinear(0.35), srgbToLinear(0.8), 1, 1])) {
    throw new Error(`selected shader_material_2d material uniform does not contain the authored baseColor: ${JSON.stringify(materialFloats?.slice(0, 4))}`);
  }
  const sampler = samplers.get(materialSampler.resourceHandleId);
  const textureView = textureViews.get(materialTextureView.resourceHandleId);
  const texture = textureView === undefined ? undefined : textures.get(textureView.sourceHandleId);
  if (sampler === undefined) throw new Error('selected shader_material_2d material has no sampler resource');
  if (texture === undefined || texture.desc?.size?.width !== 64 || texture.desc?.size?.height !== 64 || !['rgba8unorm', 'rgba8unorm-srgb'].includes(texture.desc?.format)) {
    throw new Error(`selected shader_material_2d material has no 64x64 rgba texture: ${JSON.stringify(texture?.desc)}`);
  }
  assertTextureMask(texture.handleId, initialData, events, blobPool);
  const drawOrdinal = draws.indexOf(selected);
  console.log(
    `[bevy shader_material_2d] semantic selector materialLayout=${material.layoutLabel} ` +
      `drawOrdinal=${drawOrdinal} materialBuffer=${materialBuffer.resourceHandleId} texture=${texture.handleId} sampler=${sampler.handleId}`,
  );
  return {
    drawOrdinal,
    materialBuffer: materialBuffer.resourceHandleId,
    texture: texture.handleId,
    sampler: sampler.handleId,
  };
}

function hasShaderMaterialPipeline(pipeline, shaderHandles) {
  const attributes = pipeline?.desc?.vertex?.buffers?.flatMap((buffer) => buffer.attributes ?? []) ?? [];
  const byLocation = new Map(attributes.map((attribute) => [attribute.shaderLocation, attribute.format]));
  return (
    shaderHandles.has(pipeline?.fragmentShaderModuleHandleId) &&
    byLocation.get(0) === 'float32x3' &&
    byLocation.get(1) === 'float32x3' &&
    byLocation.get(2) === 'float32x2' &&
    pipeline?.desc?.primitive?.topology === 'triangle-list' &&
    pipeline?.desc?.fragment?.targets?.length === 1
  );
}

function findMaterialBinding(draw, groups, layouts, buffers, textures, textureViews, samplers, initialData, events, blobPool) {
  for (const bindGroupSet of draw.bindGroups.values()) {
    const group = groups.get(bindGroupSet.bindGroupHandleId);
    if (group === undefined) continue;
    const layout = layouts.get(group.layoutHandleId);
    const kinds = new Set(group.entries.map((entry) => entry.resourceKind));
    if (layout?.desc?.label !== 'pbr-material-skylight-bgl' || !kinds.has('buffer') || !kinds.has('sampler') || !kinds.has('textureView')) continue;
    const buffer = resourceAt(group, 0);
    const sampler = resourceAt(group, 1);
    const textureView = resourceAt(group, 2);
    if (buffer?.resourceKind !== 'buffer' || sampler?.resourceKind !== 'sampler' || textureView?.resourceKind !== 'textureView') continue;
    if (!buffers.has(buffer.resourceHandleId) || !samplers.has(sampler.resourceHandleId) || !textureViews.has(textureView.resourceHandleId)) continue;
    if (floatsFor(bufferBytes(buffer.resourceHandleId, initialData, events, blobPool)) === undefined) continue;
    return { group, layoutLabel: layout.desc.label };
  }
  return undefined;
}

function resourceAt(group, binding) {
  const index = group.entries.findIndex((entry) => entry.binding === binding);
  if (index < 0) return undefined;
  const entry = group.entries[index];
  const resourceHandleId = group.resourceHandleIds[index];
  return resourceHandleId === undefined ? undefined : { ...entry, resourceHandleId };
}

function bufferBytes(handleId, initialData, events, blobPool) {
  const write = [...events].reverse().find((event) => event.kind === 'writeBuffer' && event.handleId === handleId && event.size >= 16);
  if (write !== undefined) return blobPool.get(write.dataHash);
  const seed = initialData.get(handleId);
  return seed === undefined ? undefined : blobPool.get(seed.dataHash);
}

function assertNonEmptyBuffer(handleId, initialData, events, blobPool, label) {
  const bytes = bufferBytes(handleId, initialData, events, blobPool);
  if (bytes === undefined || asBytes(bytes).byteLength === 0 || asBytes(bytes).every((value) => value === 0)) {
    throw new Error(`selected shader_material_2d ${label} buffer has no non-zero captured data`);
  }
}

function assertTextureMask(handleId, initialData, events, blobPool) {
  const seed = initialData.get(handleId);
  const write = [...events].reverse().find((event) => event.kind === 'writeTexture' && event.destination.textureHandleId === handleId);
  const bytes = write === undefined ? seed === undefined ? undefined : blobPool.get(seed.dataHash) : blobPool.get(write.dataHash);
  const view = bytes === undefined ? undefined : asBytes(bytes);
  if (view === undefined || view.byteLength < 16 || view.every((value) => value === 0)) throw new Error('selected shader_material_2d texture has no non-zero captured pixels');
  let hasTransparent = false;
  let hasOpaque = false;
  for (let index = 3; index < view.length; index += 4) {
    if (view[index] === 0) hasTransparent = true;
    if (view[index] > 0) hasOpaque = true;
  }
  if (!hasTransparent || !hasOpaque) throw new Error('selected shader_material_2d texture lacks the authored alpha mask');
}

function nearColor(values, expected) {
  return expected.every((value, index) => Number.isFinite(values[index]) && Math.abs(values[index] - value) < 0.001);
}

function srgbToLinear(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function floatsFor(blob) {
  if (blob === undefined || blob.byteLength < 4) return undefined;
  const bytes = asBytes(blob);
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : Uint8Array.from(bytes);
  return new Float32Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 4));
}

function asBytes(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
