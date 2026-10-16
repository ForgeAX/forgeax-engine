#!/usr/bin/env node

// Materialise one v7 .rhitape for local Viewer debugging. The generated file is
// intentionally outside the repository's tracked fixture directory. Preview
// evidence treats this artifact as immutable and records its digest before and
// after every viewer interaction.

import { encodeTape } from '@forgeax/engine-rhi-debug';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const outDir = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(resolve(tmpdir(), 'forgeax-rhi-viewer-v7-'));
mkdirSync(outDir, { recursive: true });
const colorBytes = new Uint8Array([
  255, 32, 32, 255,
  32, 255, 32, 255,
  32, 32, 255, 255,
  255, 255, 32, 255,
]);

const bufferBytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
const vertexShader = `
@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(vec2<f32>(0.0, 0.7), vec2<f32>(-0.7, -0.7), vec2<f32>(0.7, -0.7));
  return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
}`;
const fragmentShader = `
@fragment
fn main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}`;
const tape = {
  header: { formatVersion: 7, rhiCaps: {}, eventCount: 22, blobCount: 2 },
  bootstrap: [
    { handleId: 'encoder:1', kind: 'encoder', create: { kind: 'createCommandEncoder', cmdHandleId: 'encoder:1' }, initialData: [] },
    { handleId: 'texture:color', kind: 'texture', create: { kind: 'createTexture', handleId: 'texture:color', desc: { size: [2, 2, 1], format: 'rgba8unorm', usage: 19, dimension: '2d', mipLevelCount: 1, sampleCount: 1 } }, initialData: [{ hash: 'fixture-color', byteOffset: 0, byteLength: colorBytes.byteLength }] },
    { handleId: 'buffer:known', kind: 'buffer', create: { kind: 'createBuffer', handleId: 'buffer:known', desc: { size: bufferBytes.byteLength, usage: 164 } }, initialData: [{ hash: 'fixture-buffer', byteOffset: 0, byteLength: bufferBytes.byteLength }] },
    { handleId: 'view:color', kind: 'texture-view', create: { kind: 'createTextureView', sourceHandleId: 'texture:color', resultHandleId: 'view:color', desc: {} }, initialData: [] },
  ],
  events: [
    { kind: 'frameMark', frameIdx: 0 },
    { kind: 'createShaderModule', handleId: 'shader:vertex', wgslCode: vertexShader },
    { kind: 'createShaderModule', handleId: 'shader:fragment', wgslCode: fragmentShader },
    { kind: 'createBindGroupLayout', handleId: 'layout:empty', desc: { entries: [] } },
    { kind: 'createPipelineLayout', handleId: 'pipeline-layout:empty', bglHandleIds: ['layout:empty'] },
    { kind: 'createRenderPipeline', handleId: 'pipeline:fixture', desc: { vertex: { entryPoint: 'main', buffers: [] }, fragment: { entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'triangle-list' } }, layoutHandleId: 'pipeline-layout:empty', vertexShaderModuleHandleId: 'shader:vertex', fragmentShaderModuleHandleId: 'shader:fragment' },
    { kind: 'pushDebugGroup', cmdHandleId: 'encoder:1', groupLabel: 'main-pass' },
    { kind: 'beginRenderPass', cmdHandleId: 'encoder:1', passHandleId: 'pass:1', desc: { colorAttachments: [{ loadOp: 'load', storeOp: 'store' }] }, colorAttachmentViewHandleIds: ['view:color'] },
    { kind: 'setPipeline', passHandleId: 'pass:1', pipelineHandleId: 'pipeline:fixture' },
    { kind: 'passPushDebugGroup', passHandleId: 'pass:1', groupLabel: 'color-pass' },
    { kind: 'passInsertDebugMarker', passHandleId: 'pass:1', markerLabel: 'first draw' },
    { kind: 'setVertexBuffer', passHandleId: 'pass:1', slot: 0, bufferHandleId: 'buffer:known', offset: 0, size: bufferBytes.byteLength },
    { kind: 'draw', passHandleId: 'pass:1', vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
    { kind: 'passPopDebugGroup', passHandleId: 'pass:1' },
    { kind: 'endRenderPass', passHandleId: 'pass:1' },
    { kind: 'popDebugGroup', cmdHandleId: 'encoder:1' },
    { kind: 'beginRenderPass', cmdHandleId: 'encoder:1', passHandleId: 'pass:2', desc: { colorAttachments: [{ loadOp: 'load', storeOp: 'store' }] }, colorAttachmentViewHandleIds: ['view:color'] },
    { kind: 'setPipeline', passHandleId: 'pass:2', pipelineHandleId: 'pipeline:fixture' },
    { kind: 'passInsertDebugMarker', passHandleId: 'pass:2', markerLabel: 'second pass' },
    { kind: 'draw', passHandleId: 'pass:2', vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
    { kind: 'endRenderPass', passHandleId: 'pass:2' },
    { kind: 'submit', cmdHandleIds: ['encoder:1'] },
  ],
  blobs: [
    { hash: 'fixture-color', bytes: colorBytes, compression: 'none' },
    { hash: 'fixture-buffer', bytes: bufferBytes, compression: 'none' },
  ],
};

const encoded = encodeTape(tape);
if (!encoded.ok) throw new Error('fixture encode failed: ' + encoded.error.code);
const path = resolve(outDir, 'frame-0.rhitape');
writeFileSync(path, encoded.value);
console.log('Wrote ' + path + ' (' + encoded.value.byteLength + ' bytes)');
console.log('Fixture is v7 single-file .rhitape; no second artifact is produced.');
