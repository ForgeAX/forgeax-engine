import { writeFileSync } from 'node:fs';
import { compileShader } from '@forgeax/engine-shader-compiler';
import { expect, it } from 'vitest';
import { rebuildCardOwnerIndex } from '../../raytracing/card-owner-index';
import { WORLD_CARD_RADIANCE_WGSL } from '../../raytracing/world-traversal';
import {
  type CardLightingGpuProgram,
  cardLightingGpuPrograms,
} from './card-light-readiness-gpu.fixture';

it('keeps unavailable Card lighting distinct from supported black in point and bilinear world sampling', async () => {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('Real GPU adapter required');
  const device = await adapter.requestDevice(),
    buffers: GPUBuffer[] = [],
    textures: GPUTexture[] = [],
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const buffer = (values: Float32Array | Uint32Array, usage = 128) => {
    const b = device.createBuffer({ size: values.byteLength, usage: usage | 8 });
    device.queue.writeBuffer(b, 0, values);
    buffers.push(b);
    return b;
  };
  const texture = (value: readonly number[]) => {
    const t = device.createTexture({ size: [2, 2], format: 'rgba32float', usage: 4 | 2 });
    device.queue.writeTexture(
      { texture: t },
      Float32Array.from([...value, ...value, ...value, ...value]),
      { bytesPerRow: 32 },
      [2, 2],
    );
    textures.push(t);
    return t.createView();
  };
  try {
    // Freeze only query association: real Card projection, atlas validity and
    // worldCardRadiance execute against the same four lighting texels.
    const code = `
// Match the software traversal seam: this frozen hit has an SDF-style normal.
const WORLD_HIT_NORMAL_EXACT: bool = false;
struct Ray { origin: vec3f,tMin:f32,direction:vec3f,tMax:f32,mask:vec4u }
struct Hit { state:vec4u,metrics:vec4f,position:vec4f,normal:vec4f }
struct Candidates { state:vec4u,ids:vec4u }
fn worldHitCandidates(hit:Hit)->Candidates{return Candidates(vec4u(1,0,0,0),vec4u(7,0,0,0));}
fn worldCandidateOnRay(id:u32,ray:Ray)->bool{return true;}
${WORLD_CARD_RADIANCE_WGSL}
@group(0) @binding(0) var<storage,read> cardLit:array<vec4f>;
@group(0) @binding(1) var<storage,read> cards:array<Card>;
@group(0) @binding(2) var<uniform> settings:vec4u;
@group(0) @binding(3) var albedo:texture_2d<f32>;
@group(0) @binding(4) var normal:texture_2d<f32>;
@group(0) @binding(5) var emission:texture_2d<f32>;
@group(0) @binding(6) var f0:texture_2d<f32>;
@group(0) @binding(7) var cardDepth:texture_depth_2d;
@group(0) @binding(8) var<storage,read_write> output:array<vec4f>;
@group(0) @binding(9) var<uniform> testCase:vec4u;
@compute @workgroup_size(1) fn main(){
 let hit=Hit(vec4u(1,0,0,0),vec4f(1,0,0,0),vec4f(0,0,0,1),vec4f(0,0,1,0));
 output[0]=worldCardRadiance(hit,.25,testCase.x!=0u,Ray(vec3f(0,0,1),0,vec3f(0,0,-1),2,vec4u(255,0,0,0)));
}`;
    const module = device.createShaderModule({ code });
    const messages = (await module.getCompilationInfo()).messages
      .filter((m) => m.type === 'error')
      .map((m) => m.message);
    if (messages.length) throw new Error(messages.join('\n'));
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const card = new Float32Array([-1, -1, 0, 0, 1, 0, 0, 2, 0, 1, 0, 2, 0, 0, 1, 1, 0, 0, 0, 0]);
    new Uint32Array(card.buffer).set([7, 1, 0, 0], 16);
    rebuildCardOwnerIndex(new Uint8Array(card.buffer, card.byteOffset, card.byteLength), 1);
    const output = buffer(new Float32Array(4), 128 | 4);
    const depth = device.createTexture({ size: [2, 2], format: 'depth32float', usage: 16 | 4 });
    textures.push(depth);
    const common: GPUBindGroupEntry[] = [
      { binding: 1, resource: { buffer: buffer(card) } },
      { binding: 2, resource: { buffer: buffer(Uint32Array.of(1, 2, 0, 0), 64) } },
      { binding: 3, resource: texture([1, 1, 1, 1]) },
      { binding: 4, resource: texture([0, 0, 0, 0]) },
      { binding: 5, resource: texture([0, 0, 0, 0]) },
      { binding: 6, resource: texture([0, 0, 0, 1]) },
      { binding: 7, resource: depth.createView() },
      { binding: 8, resource: { buffer: output } },
    ];
    const valid = [2, 2, 2, 1],
      absent = [999, 999, 999, 0],
      black = [0, 0, 0, 1];
    const cases = [
      {
        name: 'point-missing-selected',
        point: 1,
        values: [absent, valid, valid, valid],
        expected: [0, 0, 0, -1],
      },
      {
        name: 'point-known-unselected-missing',
        point: 1,
        values: [valid, absent, absent, absent],
        expected: valid,
      },
      {
        name: 'bilinear-missing-positive-weight',
        point: 0,
        values: [valid, absent, valid, valid],
        expected: [0, 0, 0, -1],
      },
      {
        name: 'point-supported-black',
        point: 1,
        values: [black, black, black, black],
        expected: black,
      },
      {
        name: 'bilinear-supported-black',
        point: 0,
        values: [black, black, black, black],
        expected: black,
      },
      {
        name: 'bilinear-constant',
        point: 0,
        values: [valid, valid, valid, valid],
        expected: valid,
      },
    ];
    const read = device.createBuffer({ size: cases.length * 16, usage: 1 | 8 });
    buffers.push(read);
    const encoder = device.createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView(),
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      })
      .end();
    for (const [i, c] of cases.entries()) {
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          ...common,
          { binding: 0, resource: { buffer: buffer(Float32Array.from(c.values.flat())) } },
          { binding: 9, resource: { buffer: buffer(Uint32Array.of(c.point, 0, 0, 0), 64) } },
        ],
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, read, i * 16, 16);
    }
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(1);
    const values = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    const records = cases.map((c, i) => ({
      ...c,
      actual: Array.from(values.slice(i * 4, i * 4 + 4)),
    }));
    if (process.env.FORGEAX_GI_CARD_SUPPORT_RESULT)
      writeFileSync(
        process.env.FORGEAX_GI_CARD_SUPPORT_RESULT,
        JSON.stringify({ records, errors }, null, 2),
      );
    expect(errors).toEqual([]);
    for (const c of records) expect(c.actual, c.name).toEqual(c.expected);
  } finally {
    for (const b of buffers) b.destroy();
    for (const t of textures) t.destroy();
    device.destroy();
  }
});

function expectLightingWords(program: CardLightingGpuProgram, binding: number, bytes: ArrayBuffer) {
  const output = program.outputs.find((row) => row.binding === binding);
  if (!output) throw new Error('Expected lighting output is missing');
  const actual = new DataView(bytes),
    expected = new DataView(
      output.expected.buffer,
      output.expected.byteOffset,
      output.expected.byteLength,
    );
  const rowBytes = output.expected.length / program.cases.length;
  for (let offset = 0; offset < output.expected.length; offset += 4) {
    const row = Math.floor(offset / rowBytes);
    const label = `${program.name}/${program.cases[row]}/binding${binding}/word${offset / 4}`;
    if (offset % 16 !== 12 && output.tolerantRows.includes(row)) {
      expect(
        Math.abs(actual.getFloat32(offset, true) - expected.getFloat32(offset, true)),
        label,
      ).toBeLessThanOrEqual(1e-6);
    } else expect(actual.getUint32(offset, true), label).toBe(expected.getUint32(offset, true));
  }
}
async function runLightingProducer(program: CardLightingGpuProgram) {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('Real GPU adapter required');
  const device = await adapter.requestDevice(),
    buffers: GPUBuffer[] = [],
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  try {
    const compiled = (await compileShader(program.source, { computeEntry: program.name })).unwrap();
    const module = device.createShaderModule({ code: compiled.wgsl });
    const diagnostics = (await module.getCompilationInfo()).messages.filter(
      (m) => m.type === 'error',
    );
    expect(diagnostics).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: program.name },
    });
    const entries = program.bindings.map((row) => {
      const buffer = device.createBuffer({
        size: row.bytes.length,
        usage: (row.uniform ? 64 : 128) | 8 | (row.output ? 4 : 0),
      });
      buffers.push(buffer);
      device.queue.writeBuffer(buffer, 0, row.bytes);
      return { binding: row.binding, resource: { buffer } };
    });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(program.cases.length / 64));
    pass.end();
    const reads = program.outputs.map((row) => {
      const source = entries.find((entry) => entry.binding === row.binding)?.resource.buffer;
      if (!source) throw new Error('Actual lighting output is missing');
      const buffer = device.createBuffer({ size: row.expected.length, usage: 1 | 8 });
      buffers.push(buffer);
      encoder.copyBufferToBuffer(source, 0, buffer, 0, row.expected.length);
      return { binding: row.binding, buffer };
    });
    device.queue.submit([encoder.finish()]);
    for (const row of reads) {
      await row.buffer.mapAsync(1);
      expectLightingWords(program, row.binding, row.buffer.getMappedRange());
      row.buffer.unmap();
    }
    expect(errors).toEqual([]);
  } finally {
    for (const buffer of buffers) buffer.destroy();
    device.destroy();
  }
}
// Authored receiver/material data exercises actual producers, not HW intersection or a scene.
// Keep the ordinary Dawn test deadline; local cold-PSO diagnostic budgets are not inherited.
for (const program of cardLightingGpuPrograms()) {
  it(`preserves ready direct and qualified history in actual ${program.name}`, async () => {
    await runLightingProducer(program);
  });
}
