import { writeFileSync } from 'node:fs';
import { buildVisibilityDistanceField, createBoxGeometry } from '@forgeax/engine-geometry';
import { expect, it } from 'vitest';
import { packSdfScene, type SdfMeshInstance } from '../../raytracing/sdf-query';
import { packWorldBoundsPool, WORLD_BOUNDS_HEADER_BYTES } from '../../raytracing/world-bounds-pool';
import { worldTraversalWgsl } from '../../raytracing/world-traversal';
import { createProbeGlobalMesh } from './probe-global.fixture';

type V = readonly [number, number, number];
interface Box {
  readonly min: V;
  readonly max: V;
}
interface ClearanceCase {
  name: string;
  origin: V;
  direction: V;
  first: number;
  last: number;
  positive?: boolean;
  zero?: boolean;
}
const bars: readonly Box[] = [
  { min: [-2, -2, -1.2], max: [-0.75, 2, -0.8] },
  { min: [0.75, -2, -1.2], max: [2, 2, -0.8] },
  { min: [-0.75, -2, -1.2], max: [0.75, -0.75, -0.8] },
  { min: [-0.75, 0.75, -1.2], max: [0.75, 2, -0.8] },
];
function pose(tx: number, yaw = 0, scale: V = [1, 1, 1], shear = 0) {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  const direction = ([x, y, z]: V): V => {
    const u = x * scale[0] + shear * y * scale[1],
      v = y * scale[1],
      w = z * scale[2];
    return [c * u + s * w, v, -s * u + c * w];
  };
  const point = (p: V): V => {
    const d = direction(p);
    return [d[0] + tx, d[1], d[2]];
  };
  const inverse = ([x, y, z]: V, vector = false): V => {
    const u = c * (x - (vector ? 0 : tx)) - s * z,
      w = s * (x - (vector ? 0 : tx)) + c * z;
    return [(u - shear * y) / scale[0], y / scale[1], w / scale[2]];
  };
  const x = direction([1, 0, 0]),
    y = direction([0, 1, 0]),
    z = direction([0, 0, 1]);
  return {
    point,
    direction,
    inverse,
    matrix: Float32Array.from([...x, 0, ...y, 0, ...z, 0, tx, 0, 0, 1]),
  };
}
/** Independent slab geometry of the authored boxes; never reads an SDF sample. */
function firstSurface(origin: V, direction: V, box: Box, first: number, last: number): number {
  let near = -Infinity,
    far = Infinity;
  for (const axis of [0, 1, 2] as const) {
    if (direction[axis] === 0) {
      if (origin[axis] < box.min[axis] || origin[axis] > box.max[axis]) return Infinity;
    } else {
      const a = (box.min[axis] - origin[axis]) / direction[axis],
        b = (box.max[axis] - origin[axis]) / direction[axis];
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
  }
  if (near > far || far < first || near > last) return Infinity;
  const t = near >= first ? near : far;
  return t <= last ? t : Infinity;
}

async function frameField() {
  const positions: number[] = [],
    indices: number[] = [];
  for (const box of bars) {
    const mesh = createBoxGeometry(
      box.max[0] - box.min[0],
      box.max[1] - box.min[1],
      box.max[2] - box.min[2],
    ).unwrap();
    if (!mesh.indices) throw new Error('Indexed authored geometry required');
    const offset = positions.length / 3,
      p = mesh.attributes.position as Float32Array;
    for (let i = 0; i < p.length; i++)
      positions.push(
        (p[i] ?? Number.NaN) +
          (box.min[i % 3] ?? Number.NaN) * 0.5 +
          (box.max[i % 3] ?? Number.NaN) * 0.5,
      );
    for (const index of mesh.indices) indices.push(offset + index);
  }
  const topology = Uint32Array.from(indices);
  return (
    await buildVisibilityDistanceField(Float32Array.from(positions), topology, {
      voxelSize: 0.125,
      triangleSidedness: new Uint8Array(indices.length / 3),
    })
  ).unwrap();
}
function clearanceCases(poses: readonly ReturnType<typeof pose>[]): ClearanceCase[] {
  const cases: ClearanceCase[] = [];
  for (const [i, p] of poses.slice(0, 2).entries()) {
    for (const x of [-0.7, -0.25, 0, 0.25, 0.7])
      for (const y of [-0.7, 0, 0.7])
        for (const tilt of [-0.2, 0, 0.2])
          for (const speed of [0.25, 1, 2])
            for (const start of [0, 1, 1.75])
              cases.push({
                name: `hole-${i}-${x}-${y}-${tilt}-${speed}-${start}`,
                origin: p.point([x, y, -2.75]),
                direction: p.direction([tilt * speed, -tilt * speed, speed]),
                first: start / speed,
                last: 4 / speed,
              });
    cases.push({
      name: `wide-hole-${i}`,
      origin: p.point([0, 0, -2.75]),
      direction: p.direction([0, 0, 1]),
      first: 1.75,
      last: 4,
      positive: true,
    });
  }
  for (const x of [-0.75, 0, 0.75])
    for (const speed of [0.25, 1, 2])
      for (const start of [0, 2.7, 2.75])
        cases.push({
          name: `thin-${x}-${speed}-${start}`,
          origin: [-8 + x, 0, -2.75],
          direction: [0, 0, speed],
          first: start / speed,
          last: 4 / speed,
          zero: start === 2.75,
        });
  cases.push({
    name: 'missing-interior',
    origin: [16, 0, -1],
    direction: [0, 0, 1],
    first: 1,
    last: 2,
    zero: true,
  });
  cases.push({
    name: 'finite-before-missing',
    origin: [16, 0, -1],
    direction: [0, 0, 1],
    first: 0,
    last: 0.5,
  });
  return cases;
}

it('never certifies past authored geometry across hole phases, transforms, thin walls and missing fields', {
  timeout: 120_000,
}, async () => {
  const frame = await frameField();
  const thin = (await createProbeGlobalMesh(2, 2, 0.04)).distanceField;
  if (!thin) throw new Error('Real thin-wall field required');
  const poses = [pose(0), pose(8, 0.4, [1.4, 0.7, 1.1], 0.25), pose(-8), pose(16)];
  const missing: Box = { min: [-1, -1, -0.1], max: [1, 1, 0.1] };
  const source: SdfMeshInstance[] = poses.map((p, i) => ({
    instanceId: i + 1,
    geometryId: i + 1,
    mask: 255,
    transform: p.matrix,
    field: i < 2 ? frame : i === 2 ? thin : { missing: true as const, bounds: missing },
  }));
  const scene = packSdfScene(source).unwrap();
  const thinBox: Box = { min: [-1, -1, -0.02], max: [1, 1, 0.02] };
  const shapes = [bars, bars, [thinBox], [missing]];
  const cases = clearanceCases(poses);
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
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
  try {
    const grid = new Uint32Array(16);
    grid[7] = source.length;
    const bounds = new Float32Array(source.length * 12);
    for (const [i, item] of source.entries())
      bounds.set([...item.field.bounds.min, 0, ...item.field.bounds.max, 0, 1, 1, 1, 1], i * 12);
    const rayBytes = new Uint8Array(cases.length * 48),
      f = new Float32Array(rayBytes.buffer),
      u = new Uint32Array(rayBytes.buffer);
    for (const [i, c] of cases.entries()) {
      f.set(c.origin, i * 12);
      f[i * 12 + 3] = c.first;
      f.set(c.direction, i * 12 + 4);
      f[i * 12 + 7] = c.last;
      u[i * 12 + 8] = 255;
    }
    const result = buffer(new Uint8Array(cases.length * 8), 128 | 8 | 4);
    const module = device.createShaderModule({
      code:
        worldTraversalWgsl('global-sdf') +
        `
@group(0) @binding(7) var<storage,read> tests: array<Ray>;
// The clearance diagnostic does not invoke the software World trace.
fn worldSceneExpected()->vec4u{return vec4u(0u);}
@group(0) @binding(8) var<storage,read_write> results: array<vec2f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u){if(id.x<arrayLength(&tests)){let ray=tests[id.x];let certificate=worldRayClearance(ray,ray.tMin);results[id.x]=vec2f(certificate.advance,select(0.0,1.0,certificate.originalEmpty));}}
`,
    });
    const compilation = await module.getCompilationInfo();
    const compilationErrors = compilation.messages
      .filter((message) => message.type === 'error')
      .map((message) => `${message.lineNum}:${message.linePos} ${message.message}`);
    if (compilationErrors.length) throw new Error(compilationErrors.join('\n'));
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const entries = [
      { binding: 1, resource: { buffer: buffer(new Uint8Array(grid.buffer), 64 | 8) } },
      { binding: 2, resource: { buffer: buffer(scene.instances) } },
      { binding: 3, resource: { buffer: buffer(scene.fields) } },
      {
        binding: 4,
        resource: {
          buffer: buffer(
            packWorldBoundsPool(new Uint8Array(bounds.buffer), scene.instances, source.length, {
              maxBytes: WORLD_BOUNDS_HEADER_BYTES + bounds.byteLength,
              rowCapacity: source.length,
              index: false,
              candidateRadius: 0.75,
            }).unwrap().bytes,
          ),
        },
      },
      { binding: 7, resource: { buffer: buffer(rayBytes) } },
      { binding: 8, resource: { buffer: result } },
    ];
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(cases.length / 64));
    pass.end();
    const readback = device.createBuffer({ size: result.size, usage: 1 | 8 });
    owned.push(readback);
    encoder.copyBufferToBuffer(result, 0, readback, 0, result.size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const values = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    const records = cases.map((c, i) => {
      const origin: V = [f[i * 12] ?? NaN, f[i * 12 + 1] ?? NaN, f[i * 12 + 2] ?? NaN],
        direction: V = [f[i * 12 + 4] ?? NaN, f[i * 12 + 5] ?? NaN, f[i * 12 + 6] ?? NaN];
      const first = f[i * 12 + 3] ?? NaN,
        last = f[i * 12 + 7] ?? NaN;
      const surface = Math.min(
        ...poses.flatMap((p, j) =>
          (shapes[j] ?? []).map((box) =>
            firstSurface(p.inverse(origin), p.inverse(direction, true), box, first, last),
          ),
        ),
      );
      const maximum = Number.isFinite(surface) ? surface - first : last - first;
      return {
        name: c.name,
        first,
        last,
        actualAdvance: values[i * 2] ?? NaN,
        fullEmpty: values[i * 2 + 1] ?? NaN,
        maximum,
        surface: Number.isFinite(surface) ? surface : null,
      };
    });
    if (process.env.FORGEAX_GI_CLEARANCE_RESULT)
      writeFileSync(
        process.env.FORGEAX_GI_CLEARANCE_RESULT,
        JSON.stringify({ cases: cases.length, errors, records }, null, 2),
      );
    expect(errors).toEqual([]);
    expect(records.filter((r) => r.actualAdvance > 0).length).toBeGreaterThan(100);
    for (const [i, r] of records.entries()) {
      expect(r.actualAdvance, r.name).toBeGreaterThanOrEqual(0);
      expect(r.actualAdvance, r.name).toBeLessThanOrEqual(Math.max(r.maximum, 0) + 1e-5);
      if (r.fullEmpty === 1) expect(r.surface, r.name).toBeNull();
      if (cases[i]?.positive) expect(r.actualAdvance, r.name).toBeGreaterThan(0.1);
      if (cases[i]?.zero) expect(r.actualAdvance, r.name).toBe(0);
    }
  } finally {
    for (const b of owned) b.destroy();
    device.destroy();
  }
});
