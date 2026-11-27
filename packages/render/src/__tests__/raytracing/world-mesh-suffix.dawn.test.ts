import { mkdirSync, writeFileSync } from 'node:fs';
import { buildVisibilityDistanceField, createSphereGeometry } from '@forgeax/engine-geometry';
import { expect, it } from 'vitest';
import { packSdfScene } from '../../raytracing/sdf-query';
import { packWorldBoundsPool, WORLD_BOUNDS_HEADER_BYTES } from '../../raytracing/world-bounds-pool';
import { worldTraversalWgsl } from '../../raytracing/world-traversal';
import { createProbeGlobalMesh } from './probe-global.fixture';
import { runBudgetIntervalCases } from './world-mesh-suffix-budget.fixture';

it('continues outside the Global SDF through the complete Mesh SDF roster', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Real GPU required');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const owned: GPUBuffer[] = [];
  const buffer = (bytes: Uint8Array, usage: number) => {
    const b = device.createBuffer({ size: bytes.byteLength, usage, mappedAtCreation: true });
    new Uint8Array(b.getMappedRange()).set(bytes);
    b.unmap();
    owned.push(b);
    return b;
  };
  try {
    const mesh = await createProbeGlobalMesh(2, 2, 0.25);
    if (!mesh.distanceField) throw new Error('Authored Mesh SDF required');
    // The authored slab at z=3 lies entirely beyond the grid's z=1.5 border.
    // A second unavailable slab at x=4 must never become environment light.
    const transform = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 3, 1];
    const sphere = createSphereGeometry(1, 24, 16).unwrap();
    if (!sphere.indices) throw Error('Indexed authored sphere required');
    const sphereField = (
      await buildVisibilityDistanceField(
        sphere.attributes.position as Float32Array,
        sphere.indices,
        { voxelSize: 0.2, triangleSidedness: new Uint8Array(sphere.indices.length / 3) },
      )
    ).unwrap();
    const scene = packSdfScene(
      [
        {
          instanceId: 1,
          geometryId: 1,
          mask: 255,
          transform: transform(0),
          field: mesh.distanceField,
        },
        {
          instanceId: 2,
          geometryId: 2,
          mask: 255,
          transform: transform(4),
          field: {
            missing: true,
            bounds: { min: [-1, -1, -0.125], max: [1, 1, 0.125] },
          },
        },
        { instanceId: 3, geometryId: 3, mask: 255, transform: transform(8), field: sphereField },
      ],
      1024,
      3,
      1,
    ).unwrap();
    const cases = [];
    for (const start of [0, 2])
      for (const speed of [0.5, 1, 2])
        for (const y of [-0.75, 0, 0.75])
          for (const x of [-0.75, 0, 0.75])
            cases.push({
              name: `hit-${start}-${speed}-${x}-${y}`,
              x,
              y,
              start,
              speed,
              end: 8 / speed,
              mask: 255,
              steps: 128,
              expected: 1,
            });
    cases.push(
      {
        name: 'finite-end-before-slab',
        x: 0,
        y: 0,
        start: 0,
        speed: 1,
        end: 2,
        mask: 255,
        steps: 128,
        expected: 0,
      },
      {
        name: 'misses-authored-silhouette',
        x: 1.5,
        y: 0,
        start: 0,
        speed: 1,
        end: 8,
        mask: 255,
        steps: 128,
        expected: 0,
      },
      {
        name: 'outside-missing-field',
        x: 4,
        y: 0,
        start: 2,
        speed: 1,
        end: 8,
        mask: 255,
        steps: 128,
        expected: 4,
      },
      {
        name: 'outside-disabled-ray',
        x: 4,
        y: 0,
        start: 2,
        speed: 1,
        end: 8,
        mask: 0,
        steps: 128,
        expected: 0,
      },
      {
        name: 'outside-behind-slab',
        x: 0,
        y: 0,
        start: 4,
        speed: 1,
        end: 8,
        mask: 255,
        steps: 128,
        expected: 0,
      },
      {
        name: 'outside-budget-exhaustion',
        x: 8.5,
        y: 0.5,
        start: 1.5,
        speed: 1,
        end: 8,
        mask: 255,
        steps: 1,
        expected: 3,
      },
    );
    const voxels = new Uint8Array(9 ** 3 * 16),
      vf = new Float32Array(voxels.buffer),
      vu = new Uint32Array(voxels.buffer);
    for (let i = 0; i < 9 ** 3; i++) {
      vf[i * 4] = 1;
      vf[i * 4 + 1] = 1;
      vu[i * 4 + 2] = 1;
    }
    const grid = Float32Array.from([-2, -2, -2, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    new Uint32Array(grid.buffer).set([9, 9, 9, 3], 4);
    const expectedSource = Uint32Array.from([
      scene.instances.byteLength / 4,
      scene.fields.byteLength / 4,
      3,
      1,
    ]);
    new Uint32Array(grid.buffer).set(expectedSource, 12);
    const bounds = Float32Array.from([
      -1, -1, -0.125, 0, 1, 1, 0.125, 0, 1, 1, 1, 1, -1, -1, -0.125, 0, 1, 1, 0.125, 0, 1, 1, 1, 1,
      -1, -1, -1, 0, 1, 1, 1, 0, 1, 1, 1, 1,
    ]);
    const rays = new Uint8Array(cases.length * 48),
      rf = new Float32Array(rays.buffer),
      ru = new Uint32Array(rays.buffer);
    for (const [i, c] of cases.entries()) {
      rf.set([c.x, c.y, c.start, 0, 0, 0, c.speed, c.end], i * 12);
      ru[i * 12 + 8] = c.mask;
      ru[i * 12 + 10] = c.steps;
    }
    const storage = GPUBufferUsage.STORAGE;
    const output = buffer(new Uint8Array(cases.length * 16), storage | GPUBufferUsage.COPY_SRC);
    const entries = [
      voxels,
      new Uint8Array(grid.buffer),
      scene.instances,
      scene.fields,
      packWorldBoundsPool(new Uint8Array(bounds.buffer), scene.instances, 3, {
        maxBytes: WORLD_BOUNDS_HEADER_BYTES + bounds.byteLength,
        rowCapacity: 3,
        index: false,
        candidateRadius: 0.75,
      }).unwrap().bytes,
    ].map((bytes, binding) => ({
      binding,
      resource: { buffer: buffer(bytes, binding === 1 ? GPUBufferUsage.UNIFORM : storage) },
    }));
    entries.push(
      { binding: 7, resource: { buffer: buffer(rays, storage) } },
      { binding: 8, resource: { buffer: output } },
      {
        binding: 9,
        resource: { buffer: buffer(new Uint8Array(expectedSource.buffer), GPUBufferUsage.UNIFORM) },
      },
    );
    const module = device.createShaderModule({
      code: `${worldTraversalWgsl('global-sdf')}
@group(0) @binding(9) var<uniform> expectedWorld:vec4u;
fn worldSceneExpected()->vec4u{return expectedWorld;}
@group(0) @binding(7) var<storage,read> tests:array<Ray>;
@group(0) @binding(8) var<storage,read_write> results:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&tests)){return;}let r=tests[id.x];let h=traceWorld(r,r.mask.z,1.0);results[id.x]=vec4f(f32(h.state.x),h.metrics.x,h.position.z,h.normal.z);
}`,
    });
    const layout = device.createBindGroupLayout({
      entries: entries.map(({ binding }) => ({
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
    const staging = buffer(
      new Uint8Array(output.size),
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    );
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(cases.length / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const actual = Array.from(new Float32Array(staging.getMappedRange()));
    staging.unmap();
    const directory = process.env.FORGEAX_GI_SCENE_ARTIFACTS;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        `${directory}/mesh-suffix.json`,
        JSON.stringify(
          {
            packedInstanceWords: Array.from(
              new Uint32Array(
                scene.instances.buffer,
                scene.instances.byteOffset,
                scene.instances.byteLength / 4,
              ),
            ),
            fieldPolicy: mesh.distanceField.policy,
            fieldOrigin: mesh.distanceField.origin,
            fieldDimensions: mesh.distanceField.dimensions,
            scope:
              'Actual GPU traversal of an authored slab entirely outside the Global SDF; analytical slab intersections, finite intervals, nonunit directions, missing data and budget controls.',
            cases: cases.map((c, i) => ({
              ...c,
              actual: actual.slice(i * 4, i * 4 + 4),
              firstSurface: c.name.startsWith('hit-') ? (2.875 - c.start) / c.speed : null,
            })),
            errors,
          },
          null,
          2,
        ),
      );
    }
    for (const [i, c] of cases.entries()) {
      expect(actual[i * 4], c.name).toBe(c.expected);
      if (c.expected === 1) {
        expect(Math.abs((actual[i * 4 + 2] ?? NaN) - 2.875), c.name).toBeLessThan(0.26);
        expect(actual[i * 4 + 3], c.name).toBeLessThan(-0.5);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    for (const b of owned) b.destroy();
    device.destroy();
  }
});

it('completes exhausted Global rays without discarding an unproved prefix', async () => {
  const result = await runBudgetIntervalCases();
  // The independent geometry is an axis-aligned authored slab; it is not
  // reconstructed from the packed SDF, composed voxels or actual hit records.
  for (const row of result.cases) {
    expect(row.actual[0], row.name).toBe(row.expected);
    if (row.expected === 3 && row.firstSurface !== null) {
      // A geometric intersection does not guarantee completion in one sample.
      // Read back its positive first value, smaller expansion, and next t.
      expect(row.steps, row.name).toBe(1);
      expect(row.actual[20], row.name).toBeLessThanOrEqual(row.firstSurface);
      expect(row.actual[21], row.name).toBeGreaterThan(row.actual[22] ?? Infinity);
      expect(row.actual[22], row.name).toBeGreaterThanOrEqual(0);
      expect(row.actual[23], row.name).toBeGreaterThan(row.firstSurface);
    }
    if (row.expected === 1 && row.firstSurface !== null) {
      expect(
        Math.abs((row.actual[1] ?? NaN) - row.firstSurface) * Math.abs(row.speed),
        row.name,
      ).toBeLessThan(0.02);
      expect(row.actual[3], row.name).toBeLessThan(-0.5);
    }
  }
  const exhausted = result.cases.filter((row) => row.firstSurface !== null && row.actual[4] === 3);
  expect(exhausted.length).toBeGreaterThan(0);
  // Reject the plausible but wrong repair that resumes at the last coarse t.
  const skipped = exhausted.filter(
    (row) => (row.actual[5] ?? 0) > (row.firstSurface ?? Infinity) && row.actual[8] === 0,
  );
  expect(skipped.length).toBeGreaterThan(0);
  // Reject turning exhaustion directly into a supported environment sample.
  for (const row of exhausted) expect(row.actual[16], row.name).not.toBe(row.expected);
  expect(result.cases.find((row) => row.name === 'disabled-unavailable-field')?.actual[0]).toBe(0);
  expect(result.cases.find((row) => row.name === 'unavailable-global-field')?.actual[0]).toBe(4);
  expect(result.cases.find((row) => row.name === 'unavailable-outside-field')?.actual[0]).toBe(4);
  expect(
    result.cases
      .filter((row) => row.name.startsWith('boundary-'))
      .every((row) => row.actual[4] === 5),
  ).toBe(true);
  expect(result.errors).toEqual([]);
});
