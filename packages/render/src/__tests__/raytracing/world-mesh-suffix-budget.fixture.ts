import { mkdirSync, writeFileSync } from 'node:fs';
import { buildVisibilityDistanceField, createBoxGeometry } from '@forgeax/engine-geometry';
import { encodePng } from '@forgeax/engine-image/png';
import { GLOBAL_SDF_COMPOSE_WGSL, packGlobalSdfComposition } from '../../raytracing/global-sdf';
import {
  WORLD_LOCAL_BOUNDS_INTERVAL_WGSL,
  WORLD_SDF_CLEARANCE_WGSL,
} from '../../raytracing/world-clearance';
import { worldTraversalWgsl } from '../../raytracing/world-traversal';

const SLAB_Z = 0.35;
const SLAB_DEPTH = 0.1;
const MESH_SPACING = 0.025;
const FRONT = SLAB_Z - SLAB_DEPTH / 2;
const BACK = SLAB_Z + SLAB_DEPTH / 2;
const RESULT_FLOATS = 24;

interface IntervalCase {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly originZ: number;
  readonly speed: number;
  readonly end: number;
  readonly steps: number;
  readonly mask: number;
  readonly expected: number;
  readonly firstSurface: number | null;
}

function intervalCases(): IntervalCase[] {
  const cases: IntervalCase[] = [];
  for (const speed of [0.5, 1, 2])
    for (const x of [-0.75, 0, 0.75])
      for (const steps of [1, 3, 4])
        cases.push({
          name: `finite-budget-${speed}-${x}-${steps}`,
          x,
          y: 0,
          originZ: 0,
          speed,
          end: 2 / speed,
          steps,
          mask: 255,
          // The first positive Mesh sample advances to the front; a second sample is required.
          expected: steps === 1 ? 3 : 1,
          firstSurface: FRONT / speed,
        });
  for (const speed of [0.5, 1, 2])
    cases.push({
      name: `boundary-after-unproved-prefix-${speed}`,
      x: 0,
      y: 0,
      originZ: 0,
      speed,
      end: 8 / speed,
      steps: 128,
      mask: 255,
      expected: 1,
      firstSurface: FRONT / speed,
    });
  const controls = [
    { name: 'finite-empty-before-slab', x: 0, originZ: 0, end: 0.2, mask: 255, expected: 0 },
    { name: 'bounds-empty-budget', x: 1.5, originZ: 0, end: 2, mask: 255, expected: 0 },
    { name: 'unavailable-global-field', x: 4, originZ: 0, end: 2, mask: 255, expected: 4 },
    { name: 'unavailable-outside-field', x: 4, originZ: 6, end: -1, mask: 255, expected: 4 },
    { name: 'disabled-unavailable-field', x: 4, originZ: 0, end: 2, mask: 0, expected: 0 },
  ];
  for (const control of controls) {
    const speed = control.end < control.originZ ? -1 : 1;
    cases.push({
      ...control,
      y: 0,
      speed,
      end: (control.end - control.originZ) / speed,
      steps: control.name === 'bounds-empty-budget' ? 1 : 128,
      firstSurface: null,
    });
  }
  return cases;
}

const QUERY_WGSL = `
@group(0) @binding(9) var<uniform> expectedWorld:vec4u;
fn worldSceneExpected()->vec4u{return expectedWorld;}
@group(0) @binding(7) var<storage,read> tests:array<Ray>;
@group(0) @binding(8) var<storage,read_write> results:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&tests)){return;}
 let r=tests[id.x];let coarse=traceGlobal(r,r.mask.z,1.0);
 let actual=traceWorld(r,r.mask.z,1.0);
 // Deliberately wrong: a last Global sample is not an empty-prefix proof.
 var shortened=r;shortened.tMin=max(r.tMin,coarse.metrics.x);
 let partial=traceSdf(shortened,grid.dimensionsCount.w,r.mask.z,false);
 // Retired diagnostic only: never the production empty-prefix certificate.
 let legacyClearanceDiagnostic=worldRayClearance(r,coarse.metrics.x);
 let base=id.x*6u;
 results[base]=vec4f(f32(actual.state.x),actual.metrics.x,actual.position.z,actual.normal.z);
 results[base+1u]=vec4f(f32(coarse.state.x),coarse.metrics.x,f32(coarse.state.z),coarse.position.z);
 results[base+2u]=vec4f(f32(partial.state.x),partial.metrics.x,partial.position.z,partial.normal.z);
 results[base+3u]=vec4f(select(0.0,1.0,legacyClearanceDiagnostic.originalEmpty),select(0.0,1.0,legacyClearanceDiagnostic.remainingEmpty),legacyClearanceDiagnostic.advance,f32(actual.state.z));
 // Deliberately wrong: promoting incomplete work to an environment miss.
 results[base+4u]=vec4f(f32(select(coarse.state.x,0u,coarse.state.x==3u)),0,0,0);
 // Observe the first authored slab sample without changing trace budgets.
 let m=sdfInstanceAt(0u);let o=(m.inverse*vec4f(r.origin,1)).xyz;
 let d=(m.inverse*vec4f(r.direction,0)).xyz;
 let first=max(r.tMin,(m.origin.z+m.origin.w-o.z)/d.z);
 let initial=sdfValue(m,o+d*first);
 let expansion=m.error.x*clamp(max(0.0,initial)/(2.0*m.error.x),0.0,1.0);
 let next=first+max(initial,m.error.z)/length(d);
 results[base+5u]=vec4f(first,initial,expansion,next);
}`;

/** Preserve the historical diagnostic columns without restoring their retired
 * ordinary-f32 hint to the production World module or treating it as proof. */
export function worldBudgetIntervalCode() {
  if (!WORLD_SDF_CLEARANCE_WGSL.startsWith(WORLD_LOCAL_BOUNDS_INTERVAL_WGSL))
    throw Error('The legacy diagnostic must share exactly one local-bounds helper');
  const legacyDiagnostic = WORLD_SDF_CLEARANCE_WGSL.slice(WORLD_LOCAL_BOUNDS_INTERVAL_WGSL.length);
  return worldTraversalWgsl('global-sdf') + legacyDiagnostic + QUERY_WGSL;
}

export async function runBudgetIntervalCases() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error('Real GPU required');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const make = (data: Uint8Array, usage: number) => {
    const buffer = device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    owned.push(buffer);
    return buffer;
  };
  try {
    const mesh = createBoxGeometry(2, 2, SLAB_DEPTH).unwrap();
    if (!mesh.indices) throw Error('Indexed authored box required');
    const field = (
      await buildVisibilityDistanceField(mesh.attributes.position as Float32Array, mesh.indices, {
        voxelSize: MESH_SPACING,
        triangleSidedness: new Uint8Array(mesh.indices.length / 3),
      })
    ).unwrap();
    const transform = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, SLAB_Z, 1];
    const composition = packGlobalSdfComposition(
      [
        {
          instanceId: 1,
          geometryId: 1,
          mask: 255,
          transform: transform(0),
          field,
        },
        {
          instanceId: 2,
          geometryId: 2,
          mask: 255,
          transform: transform(4),
          field: { missing: true, bounds: { min: [-1, -1, -0.05], max: [1, 1, 0.05] } },
        },
      ],
      {
        origin: [-2, -2, -2],
        dimensions: [17, 17, 17],
        spacing: 0.5,
        maxDistance: 1,
        coverageDistance: 0.5,
      },
      { sourceEpoch: 1 },
    ).unwrap();
    const storage = GPUBufferUsage.STORAGE;
    const instances = make(composition.data.instances, storage);
    const fields = make(composition.data.fields, storage);
    const bounds = make(composition.data.bounds, storage);
    const grid = make(composition.data.settings, GPUBufferUsage.UNIFORM);
    if (!composition.sourceExpected) throw Error('An accepted source tuple is required');
    const expected = make(
      new Uint8Array(Uint32Array.from(composition.sourceExpected).buffer),
      GPUBufferUsage.UNIFORM,
    );
    const voxels = make(composition.data.voxels, storage | GPUBufferUsage.COPY_SRC);
    const cases = intervalCases();
    const rays = new Uint8Array(cases.length * 48),
      rayView = new DataView(rays.buffer);
    for (const [i, row] of cases.entries()) {
      // Independent physical ABI writes: expected geometry does not unpack these bytes.
      [row.x, row.y, row.originZ, 0, 0, 0, row.speed, row.end].forEach((v, k) => {
        rayView.setFloat32(i * 48 + k * 4, v, true);
      });
      rayView.setUint32(i * 48 + 32, row.mask, true);
      rayView.setUint32(i * 48 + 40, row.steps, true);
    }
    const rayBuffer = make(rays, storage);
    const output = make(
      new Uint8Array(cases.length * RESULT_FLOATS * 4),
      storage | GPUBufferUsage.COPY_SRC,
    );
    const staging = make(
      new Uint8Array(output.size),
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    );
    const voxelStaging = make(
      new Uint8Array(voxels.size),
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    );
    const compose = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: GLOBAL_SDF_COMPOSE_WGSL }),
        entryPoint: 'main',
      },
    });
    const composeGroup = device.createBindGroup({
      layout: compose.getBindGroupLayout(0),
      entries: [instances, fields, bounds, grid, voxels].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const code = worldBudgetIntervalCode();
    const query = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
    });
    const queryGroup = device.createBindGroup({
      layout: query.getBindGroupLayout(0),
      entries: [
        ...[voxels, grid, instances, fields, bounds].map((buffer, binding) => ({
          binding,
          resource: { buffer },
        })),
        { binding: 7, resource: { buffer: rayBuffer } },
        { binding: 8, resource: { buffer: output } },
        { binding: 9, resource: { buffer: expected } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const composePass = encoder.beginComputePass({
      label: 'world-budget.actual-global-composition',
    });
    composePass.setPipeline(compose);
    composePass.setBindGroup(0, composeGroup);
    composePass.dispatchWorkgroups(Math.ceil(composition.voxelCount / 64));
    composePass.end();
    const pass = encoder.beginComputePass({
      label: 'world-budget.production-and-negative-controls',
    });
    pass.setPipeline(query);
    pass.setBindGroup(0, queryGroup);
    pass.dispatchWorkgroups(Math.ceil(cases.length / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
    encoder.copyBufferToBuffer(voxels, 0, voxelStaging, 0, voxels.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const actual = Array.from(new Float32Array(staging.getMappedRange()));
    staging.unmap();
    await voxelStaging.mapAsync(GPUMapMode.READ);
    const voxelBytes = new Uint8Array(voxelStaging.getMappedRange()).slice();
    voxelStaging.unmap();
    await device.queue.onSubmittedWorkDone();
    const rows = cases.map((row, i) => ({
      ...row,
      actual: actual.slice(i * RESULT_FLOATS, (i + 1) * RESULT_FLOATS),
    }));
    const result = {
      scope:
        'Real production Global SDF composition and world trace over an authored box. Independent analytic box front; two deliberately wrong GPU controls. Legacy clearance columns are retired diagnostics, not current empty-prefix certificates. No Card, final Native frame or timing qualification.',
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      },
      slab: { min: [-1, -1, FRONT], max: [1, 1, BACK] },
      meshSpacing: MESH_SPACING,
      meshPolicy: field.policy,
      grid: composition.grid,
      errors,
      cases: rows,
    };
    const directory = process.env.FORGEAX_GI_SCENE_ARTIFACTS;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(`${directory}/budget-interval.json`, JSON.stringify(result, null, 2));
      writeFileSync(
        `${directory}/budget-interval-results.f32`,
        new Uint8Array(Float32Array.from(actual).buffer),
      );
      writeFileSync(`${directory}/budget-interval-global-voxels.bin`, voxelBytes);
      writeFileSync(`${directory}/budget-interval-production.wgsl`, code);
      saveIntervalImage(directory, rows);
    }
    return result;
  } finally {
    for (const buffer of owned) buffer.destroy();
    device.destroy();
  }
}

function saveIntervalImage(
  directory: string,
  rows: readonly (IntervalCase & { readonly actual: readonly number[] })[],
) {
  // Columns: expected, actual world, coarse Global, shortened-prefix mutant, unknown-as-miss mutant.
  const width = 320,
    height = rows.length * 12,
    image = new Uint8Array(width * height * 4);
  const palette = [
    [18, 43, 71],
    [115, 209, 151],
    [210, 145, 88],
    [240, 190, 76],
    [200, 92, 165],
    [115, 209, 151],
  ];
  for (const [i, row] of rows.entries()) {
    const states = [row.expected, row.actual[0], row.actual[4], row.actual[8], row.actual[16]];
    for (let y = i * 12; y < (i + 1) * 12; y++)
      for (let x = 0; x < width; x++) {
        const state = states[Math.floor(x / 64)] ?? 0;
        const color = palette[state] ?? [255, 0, 0];
        const pixel = (y * width + x) * 4;
        image.set([color[0] ?? 0, color[1] ?? 0, color[2] ?? 0, 255], pixel);
      }
  }
  writeFileSync(`${directory}/budget-interval-status.png`, encodePng(width, height, image));
}
