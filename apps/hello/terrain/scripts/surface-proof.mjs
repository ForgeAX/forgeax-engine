import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as backend from '@forgeax/engine-rhi-webgpu';
import { querySubmittedTerrainHeight } from '@forgeax/engine-render';
import { Terrain } from '@forgeax/engine-terrain';
import { derive, projectMaterialParameterSchema } from '@forgeax/engine-types';
import { terrainHarness } from './harness.mjs';

const dir = resolve(import.meta.dirname, '../.forgeax-debug/surface-proof');
mkdirSync(dir, { recursive: true });
const recorder = attachRecorder(backend).unwrap();
const h = await terrainHarness({ backendArgs: ['backend=metal'], appOptions: { rhi: recorder.backend.rhi } });
try {
  h.app.world.set(h.subjects.terrain, Terrain, { forcedLod: -1, lod0Diameter: 1.2 }).unwrap();
  for (let i = 0; i < 60; i++) await h.frame();
  const pending = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  const { receipt } = await h.frame();
  (await recorder.frameBoundary()).unwrap();
  const captured = (await pending).unwrap();
  writeFileSync(resolve(dir, 'display.rhitape'), captured.bytes);
  const tape = decodeTape(captured.bytes).unwrap(), model = buildFrameModel(tape);
  const blobs = new Map(tape.blobs.map((blob) => [blob.hash, blob.bytes]));
  const resource = (id) => { const value = tape.bootstrap.find((row) => row.handleId === id); assert(value, String(id)); return value; };
  const bufferAt = (id, work) => {
    const row = resource(id), bytes = new Uint8Array(row.create.desc.size);
    for (const data of row.initialData ?? []) bytes.set(blobs.get(data.hash).subarray(0, data.byteLength), data.byteOffset);
    for (const event of tape.events.slice(0, work.eventIndex + 1))
      if (event.kind === 'writeBuffer' && event.handleId === id)
        bytes.set(blobs.get(event.dataHash).subarray(0, event.size), event.bufferOffset);
    return bytes;
  };
  const rootHandle = h.app.world.get(h.subjects.terrain, Terrain).unwrap().asset;
  const root = h.app.world.sharedRefs.resolve(rootHandle).unwrap();
  const material = h.app.assets.lookup(root.sections[0].material);
  assert.equal(material.kind, 'material');
  const abi = derive(projectMaterialParameterSchema(material.parameters, root.sections[0].material, 'runtime').unwrap());
  const fields = new Map(abi.uboLayout.entries.map((field) => [field.name, field.offset]));
  const binding = abi.resourceBindings.find((slot) => slot.name === 'terrainHeightTexture');
  assert(binding, 'height binding must derive from the actual material ABI');
  const kernel = readFileSync(resolve(import.meta.dirname, '../../../../packages/shader/src/terrain-vertex.wgsl'), 'utf8').replace(/^#define_import_path.*\n/, '');
  const device = h.shim.sharedDevice;
  const rows = [];
  const works = model.works.filter((work) => work.pipeline.shaders.some((shader) => shader.source?.includes('fn terrainDecodeHeight')));
  const ibos = new Set();
  for (const work of works) {
    // Read captured uniform, texture, VBO and IBO facts at this exact raster work.
    const uniform = work.bindings.find((slot) => slot.groupIndex === 1 && slot.binding === 0);
    const bytes = bufferAt(uniform.resourceId, work);
    const base = (uniform.bufferOffset ?? 0) + (uniform.dynamicOffset ?? 0);
    const field = (name) => Array.from(new Float32Array(bytes.buffer, base + fields.get(name), 4));
    const section = field('terrainSection'), lod = field('terrainLod'), neighbors = field('terrainNeighbors');
    const heightView = work.bindings.find((slot) => slot.groupIndex === 1 && slot.binding === binding.binding);
    const textureRow = resource(resource(heightView.resourceId).create.sourceHandleId);
    const n = section[3], count = n * n;
    const heightData = new Uint8Array(textureRow.initialData.reduce((sum, entry) => sum + entry.byteLength, 0));
    let at = 0;
    for (const entry of textureRow.initialData) { heightData.set(blobs.get(entry.hash).subarray(0, entry.byteLength), at); at += entry.byteLength; }
    const vbo = work.vertexBuffers.find((slot) => slot.slot === 0);
    const vertexBytes = bufferAt(vbo.bufferHandleId, work);
    const positions = new Float32Array(count * 4);
    // Canonical engine grid layout has 12 f32 values; read actual captured bytes.
    const vertex = new Float32Array(vertexBytes.buffer);
    for (let i = 0; i < count; i++) positions.set([vertex[i * 12], vertex[i * 12 + 1], vertex[i * 12 + 2], 1], i * 4);
    assert.equal(work.indexBuffer.format, 'uint32');
    const indexBytes = bufferAt(work.indexBuffer.bufferHandleId, work);
    const indices = new Uint32Array(indexBytes.buffer, work.indexBuffer.offset ?? 0);
    ibos.add(work.indexBuffer.bufferHandleId);
    const texture = device.createTexture({ size: [n, n], format: 'rgba8unorm', mipLevelCount: Math.log2(n) + 1, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    let offset = 0;
    for (let mip = 0, size = n; size >= 1; mip++, size /= 2) {
      device.queue.writeTexture({ texture, mipLevel: mip }, heightData.subarray(offset, offset + size * size * 4), { bytesPerRow: size * 4 }, [size, size]);
      offset += size * size * 4;
    }
    const makeBuffer = (data, usage) => {
      const buffer = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(buffer, 0, data); return buffer;
    };
    const input = makeBuffer(positions, GPUBufferUsage.STORAGE);
    const params = makeBuffer(new Float32Array([...section, ...lod, ...neighbors]), GPUBufferUsage.UNIFORM);
    const output = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const shader = device.createShaderModule({ code: kernel + `\nstruct Params { section:vec4<f32>, lod:vec4<f32>, neighbors:vec4<f32> }; @group(0) @binding(0) var height:texture_2d<f32>; @group(0) @binding(1) var<storage,read> input:array<vec4<f32>>; @group(0) @binding(2) var<uniform> params:Params; @group(0) @binding(3) var<storage,read_write> output:array<vec4<f32>>; @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3<u32>) { if(id.x<${count}u){ output[id.x]=vec4<f32>(terrainVertex(input[id.x].xyz,height,params.section,params.lod,params.neighbors),1.0); } }` });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: shader, entryPoint: 'main' } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [ { binding: 0, resource: texture.createView() }, { binding: 1, resource: { buffer: input } }, { binding: 2, resource: { buffer: params } }, { binding: 3, resource: { buffer: output } } ] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(count / 64)); pass.end();
    encoder.copyBufferToBuffer(output, 0, read, 0, count * 16); device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(read.getMappedRange().slice(0)); read.unmap();
    let peak = 0, tested = 0;
    // Interior and edge-adjacent triangle samples use actual captured indices.
    const triangles = new Set([0, 1, indices.length / 3 - 2, indices.length / 3 - 1]);
    for (let t = 0; t < indices.length / 3; t += Math.max(1, Math.floor(indices.length / 3 / 32))) triangles.add(t);
    for (const t of triangles) {
      const ids = Array.from(indices.subarray(t * 3, t * 3 + 3));
      const x = ids.reduce((sum, id) => sum + result[id * 4], 0) / 3;
      const y = ids.reduce((sum, id) => sum + result[id * 4 + 1], 0) / 3;
      const z = ids.reduce((sum, id) => sum + result[id * 4 + 2], 0) / 3;
      const answer = (await querySubmittedTerrainHeight(receipt, { worldId: 0, entity: h.subjects.terrain, x, z, expectedAsset: Number(rootHandle) })).unwrap();
      assert.equal(typeof answer, 'number');
      const delta = Math.abs(answer - y); peak = Math.max(peak, delta); tested++;
      assert(delta <= 1e-5, `work ${work.workIndex}, triangle ${t}: ${delta} > 1e-5m`);
    }
    rows.push({ workIndex: work.workIndex, section, lod, neighbors, heightTexture: textureRow.handleId, vertexBuffer: vbo.bufferHandleId, indexBuffer: work.indexBuffer.bufferHandleId, triangles: tested, peakHeightErrorMetres: peak });
    texture.destroy(); for (const buffer of [input, params, output, read]) buffer.destroy();
  }
  assert(ibos.size >= 2, 'mixed integer LODs must exercise distinct actual draw indices');
  assert.deepEqual(h.errors, []);
  const report = { status: 'PASS', receipt: { frameId: receipt.frameId, deviceGeneration: receipt.deviceGeneration }, digest: captured.digest, heightToleranceMetres: 1e-5, boundary: 'Actual raster tape uniforms, all mip bytes, VBO and IBO feed the shared Landscape WGSL kernel on the native GPU. GPU triangle interiors are compared with the public completed-picture query. This is kernel recomputation, not hardware vertex-stage transform feedback.', rows };
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await h.dispose(); (await recorder.dispose()).unwrap(); }
process.exit(0);
