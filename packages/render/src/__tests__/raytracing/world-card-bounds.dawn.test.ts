import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { packSdfScene } from '../../raytracing/sdf-query';
import {
  packWorldBoundsPool,
  WORLD_BOUNDS_HEADER_BYTES,
  WORLD_BOUNDS_ROW_BYTES,
} from '../../raytracing/world-bounds-pool';
import { worldTraversalWgsl } from '../../raytracing/world-traversal';
import recorded from './fixtures/world-card-recorded-rays.json' with { type: 'json' };
import { createProbeGlobalMesh } from './probe-global.fixture';

function canonicalWorldBounds(bounds: Float32Array, instances: Uint8Array) {
  const rows = bounds.byteLength / WORLD_BOUNDS_ROW_BYTES;
  return packWorldBoundsPool(new Uint8Array(bounds.buffer), instances, rows, {
    maxBytes: WORLD_BOUNDS_HEADER_BYTES + bounds.byteLength,
    rowCapacity: rows,
    index: false,
    candidateRadius: 0,
  }).unwrap().bytes;
}

it('admits Card sources only on the finite ray through transformed mesh bounds', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  expect(adapter).not.toBeNull();
  if (!adapter) throw new Error('Real WebGPU adapter required');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const cases = [
    {
      name: 'front-hit',
      id: 11,
      origin: [0, 0, 3],
      direction: [0, 0, -1],
      min: 0,
      max: 10,
      expected: 1,
    },
    {
      name: 'outside-silhouette',
      id: 11,
      origin: [1.1, 0, 3],
      direction: [0, 0, -1],
      min: 0,
      max: 10,
      expected: 0,
    },
    {
      name: 'parallel-on-boundary',
      id: 11,
      origin: [1, 0, 3],
      direction: [0, 0, -1],
      min: 0,
      max: 10,
      expected: 1,
    },
    {
      name: 'behind-ray',
      id: 11,
      origin: [0, 0, 3],
      direction: [0, 0, 1],
      min: 0,
      max: 10,
      expected: 0,
    },
    {
      name: 'before-entry',
      id: 11,
      origin: [0, 0, 3],
      direction: [0, 0, -1],
      min: 0,
      max: 1,
      expected: 0,
    },
    {
      name: 'after-exit',
      id: 11,
      origin: [0, 0, 3],
      direction: [0, 0, -1],
      min: 5,
      max: 10,
      expected: 0,
    },
    {
      name: 'inside-origin',
      id: 11,
      origin: [0, 0, 0],
      direction: [1, 0, 0],
      min: 0,
      max: 10,
      expected: 1,
    },
    {
      name: 'translated-rotated-scaled-hit',
      id: 22,
      origin: [4, 0, 3],
      direction: [0, 0, -1],
      min: 0,
      max: 10,
      expected: 1,
    },
    {
      name: 'scaled-narrow-axis-miss',
      id: 22,
      origin: [4.6, 0, 3],
      direction: [0, 0, -1],
      min: 0,
      max: 10,
      expected: 0,
    },
    {
      name: 'scaled-wide-axis-miss',
      id: 22,
      origin: [4, 2.1, 3],
      direction: [0, 0, -1],
      min: 0,
      max: 10,
      expected: 0,
    },
    {
      name: 'transformed-corner',
      id: 22,
      origin: [3.5, 2, 3],
      direction: [0, 0, -1],
      min: 0,
      max: 10,
      expected: 1,
    },
    {
      name: 'diagonal-hit',
      id: 22,
      origin: [2, 3, 3],
      direction: [1, -1, -1],
      min: 0,
      max: 10,
      expected: 1,
    },
    {
      name: 'unknown-instance',
      id: 99,
      origin: [0, 0, 3],
      direction: [0, 0, -1],
      min: 0,
      max: 10,
      expected: 0,
    },
    ...recorded.cases,
    {
      name: 'recorded-source-positive-control',
      id: 44,
      origin: [-1.2, 0, -2.875],
      direction: [-1.3, 0, 3.175],
      min: 0,
      max: 100,
      expected: 1,
    },
  ];
  const owned: GPUBuffer[] = [];
  const buffer = (bytes: Uint8Array, usage: number) => {
    const result = device.createBuffer({ size: bytes.byteLength, usage, mappedAtCreation: true });
    new Uint8Array(result.getMappedRange()).set(bytes);
    result.unmap();
    owned.push(result);
    return result;
  };
  try {
    const instances = new Uint8Array(3 * 144),
      f = new Float32Array(instances.buffer),
      u = new Uint32Array(instances.buffer);
    f.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    u[16] = 11;
    // Local x=worldY/2, local y=-2*(worldX-4), local z=worldZ.
    f.set([0, -2, 0, 0, 0.5, 0, 0, 0, 0, 0, 1, 0, 0, 8, 0, 1], 36);
    u[36 + 16] = 22;
    f.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 72);
    u[72 + 16] = 44;
    const bounds = Float32Array.from([
      -1, -1, -1, 0, 1, 1, 1, 0, 1, 1, 1, 1, -1, -1, -1, 0, 1, 1, 1, 0, 1, 1, 1, 1, -2.625, -1,
      -0.45, 0, -2.375, 1, 1.05, 0, 1, 1, 1, 1,
    ]);
    const grid = new Uint32Array(16);
    grid[7] = 3;
    const rays = new Uint8Array(cases.length * 48),
      rf = new Float32Array(rays.buffer),
      ru = new Uint32Array(rays.buffer);
    for (const [i, c] of cases.entries()) {
      rf.set(c.origin, i * 12);
      rf[i * 12 + 3] = c.min;
      rf.set(c.direction, i * 12 + 4);
      rf[i * 12 + 7] = c.max;
      ru[i * 12 + 8] = 255;
      ru[i * 12 + 9] = c.id;
    }
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const entries = [
      {
        binding: 1,
        resource: { buffer: buffer(new Uint8Array(grid.buffer), GPUBufferUsage.UNIFORM) },
      },
      { binding: 2, resource: { buffer: buffer(instances, storage) } },
      {
        binding: 4,
        resource: { buffer: buffer(canonicalWorldBounds(bounds, instances), storage) },
      },
      { binding: 7, resource: { buffer: buffer(rays, storage) } },
      {
        binding: 8,
        resource: {
          buffer: buffer(new Uint8Array(cases.length * 4), storage | GPUBufferUsage.COPY_SRC),
        },
      },
    ];
    const module = device.createShaderModule({
      code: `${worldTraversalWgsl('global-sdf')}
// This entry queries candidate bounds without tracing a World source.
fn worldSceneExpected()->vec4u{return vec4u(0u);}
@group(0) @binding(7) var<storage,read> tests: array<Ray>;
@group(0) @binding(8) var<storage,read_write> results: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
 if(gid.x<arrayLength(&tests)){let ray=tests[gid.x];results[gid.x]=u32(worldCandidateOnRay(ray.mask.y,ray));}
}`,
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    const read = buffer(
      new Uint8Array(cases.length * 4),
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    );
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    const output = entries[4]?.resource.buffer;
    if (!output) throw new Error('Output buffer required');
    encoder.copyBufferToBuffer(output, 0, read, 0, cases.length * 4);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const actual = [...new Uint32Array(read.getMappedRange())];
    read.unmap();
    const root = process.env.FORGEAX_GI_SCENE_ARTIFACTS;
    if (root) {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, 'card-bounds.json'),
        JSON.stringify(
          { cases: cases.map((c, i) => ({ ...c, actual: actual[i] })), errors },
          null,
          2,
        ),
      );
    }
    expect(actual).toEqual(cases.map((c) => c.expected));
    expect(errors).toEqual([]);
  } finally {
    for (const b of owned) b.destroy();
    device.destroy();
  }
});

// Cold software compilation of the complete world traversal crossed 30 seconds.
it('excludes a coarse hit only when every active mesh bound misses the finite ray', {
  timeout: 90_000,
}, async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Real WebGPU adapter required');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const cases = [
    {
      name: 'coarse-hit-outside-every-bound',
      x: 2,
      min: 0,
      max: 10,
      steps: 64,
      mask: 255,
      expected: 0,
    },
    {
      name: 'different-occluder-farther-on-ray',
      x: 0,
      min: 0,
      max: 10,
      steps: 64,
      mask: 255,
      expected: 1,
    },
    {
      name: 'finite-endpoint-before-occluder',
      x: 0,
      min: 0,
      max: 1.5,
      steps: 64,
      mask: 255,
      expected: 0,
    },
    { name: 'exhaustion-is-not-a-miss', x: 0, min: 0, max: 10, steps: 1, mask: 255, expected: 3 },
    {
      name: 'negative-coarse-start-resolves-the-mesh-hit',
      x: 0,
      min: 1.25,
      max: 3,
      steps: 64,
      mask: 255,
      expected: 1,
    },
    { name: 'zero-mask-stays-a-miss', x: 0, min: 0, max: 10, steps: 64, mask: 0, expected: 0 },
    {
      name: 'unavailable-field-is-not-a-miss',
      x: -1,
      min: 0,
      max: 10,
      steps: 64,
      mask: 255,
      expected: 4,
    },
    {
      name: 'outside-start-occluder-resolved-by-mesh-sdf',
      x: 0,
      z: 6,
      min: 0,
      max: 10,
      steps: 64,
      mask: 255,
      expected: 1,
    },
    {
      name: 'outside-start-complete-roster-clear',
      x: 2,
      z: 6,
      min: 0,
      max: 10,
      steps: 64,
      mask: 255,
      expected: 0,
    },
    {
      name: 'outside-finite-end-before-real-bound',
      x: 0,
      z: 6,
      min: 0,
      max: 4,
      steps: 64,
      mask: 255,
      expected: 0,
    },
    {
      name: 'outside-closed-endpoint-touches-bound',
      x: 0,
      z: 6,
      min: 0,
      max: 5,
      steps: 64,
      mask: 255,
      expected: 1,
    },
    {
      name: 'outside-start-real-bound-behind',
      x: 0,
      z: -5,
      min: 0,
      max: 2,
      steps: 64,
      mask: 255,
      expected: 0,
    },
  ];
  const owned: GPUBuffer[] = [];
  const buffer = (bytes: Uint8Array, usage: number) => {
    const value = device.createBuffer({ size: bytes.byteLength, usage, mappedAtCreation: true });
    new Uint8Array(value.getMappedRange()).set(bytes);
    value.unmap();
    owned.push(value);
    return value;
  };
  try {
    // A deliberately expanded coarse plane z=2 precedes the real unit-box bound.
    // This is an adversarial traversal input, not an authored-scene qualification.
    const voxels = new Uint8Array(12 ** 3 * 16);
    const vf = new Float32Array(voxels.buffer),
      vu = new Uint32Array(voxels.buffer);
    for (let z = 0; z < 12; z++)
      for (let y = 0; y < 12; y++)
        for (let x = 0; x < 12; x++) {
          const offset = ((z * 12 + y) * 12 + x) * 4;
          vf[offset] = z - 7;
          vf[offset + 1] = 1;
          vu[offset + 2] = 1;
        }
    // Only the unavailable-field ray starts at this otherwise independent sample.
    vu[((8 * 12 + 5) * 12 + 4) * 4 + 2] = 0;
    const grid = new Float32Array(16);
    grid.set([-5, -5, -5, 1]);
    new Uint32Array(grid.buffer).set([12, 12, 12, 1], 4);
    const mesh = await createProbeGlobalMesh(2, 2, 2);
    if (!mesh.distanceField) throw new Error('Real unit-box Mesh SDF required');
    const scene = packSdfScene(
      [
        {
          instanceId: 1,
          geometryId: 1,
          mask: 255,
          transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          field: mesh.distanceField,
        },
      ],
      64,
      1,
      1,
    ).unwrap();
    const expectedSource = Uint32Array.from([
      scene.instances.byteLength / 4,
      scene.fields.byteLength / 4,
      1,
      1,
    ]);
    new Uint32Array(grid.buffer).set(expectedSource, 12);
    const bounds = Float32Array.from([-1, -1, -1, 0, 1, 1, 1, 0, 1, 1, 1, 1]);
    const rays = new Uint8Array(cases.length * 48),
      rf = new Float32Array(rays.buffer),
      ru = new Uint32Array(rays.buffer);
    for (const [i, c] of cases.entries()) {
      rf.set([c.x, 0, c.z ?? 3, c.min, 0, 0, -1, c.max], i * 12);
      ru[i * 12 + 8] = c.mask;
      ru[i * 12 + 10] = c.steps;
    }
    const storage = GPUBufferUsage.STORAGE;
    const output = buffer(new Uint8Array(cases.length * 8), storage | GPUBufferUsage.COPY_SRC);
    const entries = [
      { binding: 0, resource: { buffer: buffer(voxels, storage) } },
      {
        binding: 1,
        resource: { buffer: buffer(new Uint8Array(grid.buffer), GPUBufferUsage.UNIFORM) },
      },
      { binding: 2, resource: { buffer: buffer(scene.instances, storage) } },
      { binding: 3, resource: { buffer: buffer(scene.fields, storage) } },
      {
        binding: 4,
        resource: { buffer: buffer(canonicalWorldBounds(bounds, scene.instances), storage) },
      },
      { binding: 7, resource: { buffer: buffer(rays, storage) } },
      { binding: 8, resource: { buffer: output } },
      {
        binding: 9,
        resource: { buffer: buffer(new Uint8Array(expectedSource.buffer), GPUBufferUsage.UNIFORM) },
      },
    ];
    const module = device.createShaderModule({
      code: `${worldTraversalWgsl('global-sdf')}
@group(0) @binding(9) var<uniform> expectedWorld:vec4u;
fn worldSceneExpected()->vec4u{return expectedWorld;}
@group(0) @binding(7) var<storage,read> tests: array<Ray>;
@group(0) @binding(8) var<storage,read_write> results: array<vec2u>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
 if(gid.x<arrayLength(&tests)){let ray=tests[gid.x];let hit=traceWorld(ray,ray.mask.z,1.0);results[gid.x]=vec2u(hit.state.x,bitcast<u32>(hit.metrics.x));}
}`,
    });
    // Explicit bindings also admit the unfixed shader, whose optimizer removes
    // unused instance/bounds slots. A red run must fail the oracle, not binding validation.
    const layout = device.createBindGroupLayout({
      entries: entries.map<GPUBindGroupLayoutEntry>(({ binding }) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type:
            binding === 1 || binding === 9
              ? 'uniform'
              : binding === 8
                ? 'storage'
                : 'read-only-storage',
        },
      })),
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: 'main' },
    });
    const group = device.createBindGroup({ layout, entries });
    const read = buffer(
      new Uint8Array(cases.length * 8),
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    );
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, read, 0, cases.length * 8);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const view = new DataView(read.getMappedRange());
    const actual = cases.map((_, index) => view.getUint32(index * 8, true));
    const distances = cases.map((_, index) => view.getFloat32(index * 8 + 4, true));
    read.unmap();
    const root = process.env.FORGEAX_GI_SCENE_ARTIFACTS;
    if (root) {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, 'traversal-bounds.json'),
        JSON.stringify(
          {
            fixture: 'Adversarial coarse plane z=2; actual author bound is unit box',
            cases: cases.map((c, i) => ({ ...c, actual: actual[i], distance: distances[i] })),
            errors,
          },
          null,
          2,
        ),
      );
    }
    expect(actual).toEqual(cases.map((c) => c.expected));
    const negativeStart = cases.findIndex(
      ({ name }) => name === 'negative-coarse-start-resolves-the-mesh-hit',
    );
    expect(Math.abs((distances[negativeStart] ?? NaN) - 2)).toBeLessThan(0.25);
    expect(errors).toEqual([]);
  } finally {
    for (const value of owned) value.destroy();
    device.destroy();
  }
});
