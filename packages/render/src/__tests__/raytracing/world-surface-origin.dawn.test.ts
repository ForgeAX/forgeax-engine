import { writeFileSync } from 'node:fs';
import { buildVisibilityDistanceField, createSphereGeometry } from '@forgeax/engine-geometry';
import { expect, it } from 'vitest';
import { packSdfScene } from '../../raytracing/sdf-query';
import { packWorldBoundsPool, WORLD_BOUNDS_HEADER_BYTES } from '../../raytracing/world-bounds-pool';
import { worldTraversalWgsl } from '../../raytracing/world-traversal';
import recorded from './fixtures/world-precision-origins.json' with { type: 'json' };
import { observeSurfaceOriginIntervals } from './world-surface-origin-interval.fixture';

it('preserves nearby closed blockers before the software surface-origin displacement', async () => {
  const result = await observeSurfaceOriginIntervals();
  expect(result.errors).toEqual([]);
  expect(result.records).toHaveLength(24);
  for (const row of result.records) {
    expect(
      row.actualReferenceOrigin,
      `${row.name}: actual independently authored control origin`,
    ).toEqual([row.position[0], row.position[1], Math.fround(row.position[2] + 1 / 65536), 1]);
    expect(
      row.exactReference?.correct,
      `${row.name}: original exact authored triangle oracle`,
    ).toBe(true);
    expect(row.exactShifted?.correct, `${row.name}: shifted exact authored triangle oracle`).toBe(
      true,
    );
    const status = row.expectedOwner === 0 ? 0 : 1;
    expect(row.reference.state[0], `${row.name}: original finite interval status`).toBe(status);
    if (row.expectedOwner !== 0) {
      expect(row.reference.state[3], `${row.name}: original nearest owner`).toBe(row.expectedOwner);
      expect(
        (row.reference.state[1] ?? 0) >>> 31,
        `${row.name}: original triangle certificate`,
      ).toBe(1);
    }
  }
  const changed = result.records
    .filter(
      (row) =>
        row.shifted.state[0] !== (row.expectedOwner === 0 ? 0 : 1) ||
        (row.expectedOwner !== 0 && row.shifted.state[3] !== row.expectedOwner),
    )
    .map((row) => row.name);
  expect(
    changed,
    'The production origin must preserve the nearest closed blocker before its displacement',
  ).toEqual([]);
}, 120_000);

it('retains software field clearance at recorded grazing receivers despite positive coarse samples', async () => {
  const mesh = createSphereGeometry(1, 32, 24).unwrap();
  if (!mesh.indices) throw new Error('Actual sphere triangles required');
  const field = (
    await buildVisibilityDistanceField(mesh.attributes.position as Float32Array, mesh.indices, {
      voxelSize: 0.15,
      triangleSidedness: new Uint8Array(mesh.indices.length / 3),
    })
  ).unwrap();
  const scene = packSdfScene([
    {
      instanceId: 1,
      geometryId: 1,
      mask: 255,
      field,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -3, 1],
    },
  ]).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Real GPU adapter required');
  const device = await adapter.requestDevice(),
    owned: GPUBuffer[] = [],
    errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const buffer = (data: Uint8Array, usage = 128 | 8) => {
    const b = device.createBuffer({ size: data.byteLength, usage });
    device.queue.writeBuffer(b, 0, data);
    owned.push(b);
    return b;
  };
  const bytes = (data: Float32Array | Uint32Array) => new Uint8Array(data.buffer);
  try {
    const grid = new Uint32Array(16);
    new Float32Array(grid.buffer).set([-4, -4, -6, 0.5]);
    grid.set([17, 17, 17, 1], 4);
    const voxels = new Uint32Array(17 ** 3 * 4),
      vf = new Float32Array(voxels.buffer);
    for (let i = 0; i < 17 ** 3; i++) {
      vf[i * 4] = 0.02;
      vf[i * 4 + 1] = 1;
      voxels[i * 4 + 2] = 1;
    }
    const bounds = Float32Array.from([...field.bounds.min, 0, ...field.bounds.max, 0, 1, 1, 1, 1]);
    const canonicalBounds = bytes(bounds);
    const packedBounds = packWorldBoundsPool(canonicalBounds, scene.instances, 1, {
      maxBytes: WORLD_BOUNDS_HEADER_BYTES + canonicalBounds.byteLength,
      rowCapacity: 1,
      index: false,
      candidateRadius: 0,
    }).unwrap().bytes;
    // Check byte units independently; the original canonical row is unchanged.
    const header = new DataView(
      packedBounds.buffer,
      packedBounds.byteOffset,
      packedBounds.byteLength,
    );
    expect(packedBounds.byteLength).toBe(96 + 48);
    expect(header.getUint32(8, true)).toBe(1);
    expect(header.getUint32(16, true)).toBe(6);
    expect(packedBounds.slice(96)).toEqual(canonicalBounds);
    const inputs = new Float32Array(recorded.cases.length * 8);
    for (const [i, c] of recorded.cases.entries())
      inputs.set([...c.position, c.bias, ...c.normal, Number(c.exact)], i * 8);
    const result = buffer(new Uint8Array(recorded.cases.length * 16), 128 | 8 | 4);
    const code =
      worldTraversalWgsl('global-sdf') +
      `
struct TestReceiver { position: vec4f, normal: vec4f }
// The receiver diagnostic does not invoke the software World trace.
fn worldSceneExpected()->vec4u{return vec4u(0u);}
@group(0) @binding(7) var<storage, read> tests: array<TestReceiver>;
@group(0) @binding(8) var<storage, read_write> results: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
 if(gid.x>=arrayLength(&tests)){return;}
 let test=tests[gid.x];let p=test.position.xyz;let n=test.normal.xyz;let bias=test.position.w;
 let receiverBias=min(bias,max(1e-4,max(max(abs(p.x),abs(p.y)),abs(p.z))*1e-5));
 let origin=p+n*receiverBias;
 let coarse=sampleGlobal(origin);
 if(coarse.status!=1u||coarse.distance<0.0){results[gid.x]=vec4f(0.0,0.0,0.0,-1.0);return;}
 let proof=worldRayClearance(Ray(origin,0.0,n,bias,vec4u(255u,0u,0u,0u)),0.0);
 results[gid.x]=vec4f(worldSurfaceOrigin(p,n,bias),proof.advance);
}`;
    const module = device.createShaderModule({ code });
    const messages = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error');
    if (messages.length)
      throw new Error(messages.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: buffer(bytes(voxels)) } },
        { binding: 1, resource: { buffer: buffer(bytes(grid), 64 | 8) } },
        { binding: 2, resource: { buffer: buffer(scene.instances) } },
        { binding: 3, resource: { buffer: buffer(scene.fields) } },
        { binding: 4, resource: { buffer: buffer(packedBounds) } },
        { binding: 7, resource: { buffer: buffer(bytes(inputs)) } },
        { binding: 8, resource: { buffer: result } },
      ],
    });
    const readback = device.createBuffer({ size: result.size, usage: 1 | 8 });
    owned.push(readback);
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(result, 0, readback, 0, result.size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const actual = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    const records = recorded.cases.map((c, i) => ({
      ...c,
      actual: Array.from(actual.slice(i * 4, i * 4 + 4)),
    }));
    if (process.env.FORGEAX_GI_ORIGIN_RESULT)
      writeFileSync(
        process.env.FORGEAX_GI_ORIGIN_RESULT,
        JSON.stringify({ records, errors }, null, 2),
      );
    expect(errors).toEqual([]);
    for (const [i, c] of recorded.cases.entries()) {
      const precision = Math.min(
        c.bias,
        Math.max(1e-4, ...c.position.map((v) => Math.abs(v) * 1e-5)),
      );
      const bias = c.precision ? precision : c.bias;
      if (c.fineClear) expect(actual[i * 4 + 3], c.name).toBeGreaterThan(0);
      else if (c.exact) expect(actual[i * 4 + 3], c.name).toBe(0);
      for (let axis = 0; axis < 3; axis++)
        expect(actual[i * 4 + axis], `${c.name}:${axis}`).toBeCloseTo(
          (c.position[axis] ?? NaN) + (c.normal[axis] ?? NaN) * bias,
          5,
        );
    }
  } finally {
    for (const b of owned) b.destroy();
    device.destroy();
  }
}, 120_000);
