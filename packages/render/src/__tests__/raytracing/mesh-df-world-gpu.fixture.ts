import type { ReferenceRay } from '../../raytracing/scene';
import { packReferenceRays } from '../../raytracing/scene';
import { type MeshDfApproxPolicy, worldTraversalWgsl } from '../../raytracing/world-traversal';

/** Replay/scene callers supply original source-qualified data, never an expected
 * tuple reconstructed from the sampled pool. This fixture does not cook a scene,
 * replace missing resources, select an adapter or launch another device. */
export interface MeshDfWorldInputs {
  readonly settings: Uint8Array;
  readonly instances: Uint8Array;
  readonly fields: Uint8Array;
  readonly bounds: Uint8Array;
  readonly expected: readonly [number, number, number, number];
}

export interface MeshDfWorldCase {
  readonly ray: ReferenceRay;
  readonly originHi: readonly [number, number, number];
  readonly directionHi: readonly [number, number, number];
  readonly contact: readonly [number, number, number];
  readonly maxSteps: number;
}

export const MESH_DF_WORLD_CASE_BYTES = 112;
export const MESH_DF_WORLD_OBSERVATION_BYTES = 80;

export function packMeshDfWorldCases(cases: readonly MeshDfWorldCase[]) {
  const rays = packReferenceRays(cases.map((row) => row.ray)).unwrap();
  const bytes = new Uint8Array(cases.length * MESH_DF_WORLD_CASE_BYTES);
  const data = new DataView(bytes.buffer);
  for (const [index, row] of cases.entries()) {
    const offset = index * MESH_DF_WORLD_CASE_BYTES;
    bytes.set(rays.subarray(index * 48, index * 48 + 48), offset);
    for (const [slot, values] of [row.originHi, row.directionHi].entries())
      values.forEach((value, axis) => {
        data.setFloat32(offset + 48 + slot * 16 + axis * 4, value, true);
      });
    row.contact.forEach((word, axis) => {
      data.setUint32(offset + 80 + axis * 4, word, true);
    });
    if (!Number.isInteger(row.maxSteps) || row.maxSteps < 0 || row.maxSteps > 0xffff_ffff)
      throw Error('Actual profile work bound required');
    data.setUint32(offset + 96, row.maxSteps, true);
  }
  return bytes;
}

/** Actual selectable production factory; the entry preserves original t and
 * receiver intervals. Costs are raw reserved/observed words, not GPU timing. */
export function meshDfWorldGpuCode(policy: MeshDfApproxPolicy) {
  return `${worldTraversalWgsl('global-sdf', false, true, false, policy)}
struct DfCase { ray:Ray, originHi:vec4u, directionHi:vec4u, contact:vec4u, control:vec4u }
struct DfObservation { hit:Hit, cost:vec4u }
@group(1) @binding(0) var<storage,read> inputs:array<DfCase>;
@group(1) @binding(1) var<uniform> expected:vec4u;
@group(1) @binding(2) var<storage,read_write> observations:array<DfObservation>;
fn worldSceneExpected()->vec4u{return expected;}
@compute @workgroup_size(64) fn meshDfWorld(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&inputs)){return;}
 let value=inputs[id.x];
 let hit=traceWorld(value.ray,value.control.x,0.0,value.originHi.xyz,value.directionHi.xyz,
  SdfMeshDfReceiver(value.contact.x,value.contact.y,value.contact.z));
 observations[id.x]=DfObservation(hit,sdfMeshDfCost);
}`;
}

/** Uses the caller's existing device/lease and complete input tuple. Raw output
 * must be saved before assessing approximation, opacity and budget controls. */
export async function runMeshDfWorldGpuWork(
  device: GPUDevice,
  code: string,
  scene: MeshDfWorldInputs,
  cases: readonly MeshDfWorldCase[],
) {
  const owned: GPUBuffer[] = [];
  const buffer = (bytes: Uint8Array, usage: number) => {
    const value = device.createBuffer({ size: bytes.byteLength, usage, mappedAtCreation: true });
    new Uint8Array(value.getMappedRange()).set(bytes);
    value.unmap();
    owned.push(value);
    return value;
  };
  try {
    const module = device.createShaderModule({ code });
    const errors = (await module.getCompilationInfo()).messages.filter(
      (row) => row.type === 'error',
    );
    if (errors.length) throw Error(errors.map((row) => row.message).join('\n'));
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'meshDfWorld' },
    });
    const source = [
      [1, buffer(scene.settings, 64)],
      [2, buffer(scene.instances, 128)],
      [3, buffer(scene.fields, 128)],
      [4, buffer(scene.bounds, 128)],
    ] as const;
    const output = buffer(new Uint8Array(cases.length * MESH_DF_WORLD_OBSERVATION_BYTES), 128 | 4);
    const first = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: source.map(([binding, value]) => ({ binding, resource: { buffer: value } })),
    });
    const second = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer: buffer(packMeshDfWorldCases(cases), 128) } },
        {
          binding: 1,
          resource: { buffer: buffer(new Uint8Array(Uint32Array.from(scene.expected).buffer), 64) },
        },
        { binding: 2, resource: { buffer: output } },
      ],
    });
    const staging = buffer(new Uint8Array(output.size), 1 | 8);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, first);
    pass.setBindGroup(1, second);
    pass.dispatchWorkgroups(Math.ceil(cases.length / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(1);
    const raw = new Uint8Array(staging.getMappedRange()).slice();
    staging.unmap();
    return raw;
  } finally {
    for (const value of owned) value.destroy();
  }
}
