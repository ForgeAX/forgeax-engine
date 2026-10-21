import type { VfxGpuEmitterProgram, VfxGpuInstanceComputeProgram } from '@forgeax/engine-vfx';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message ?? 'Unsupported batch ABI');
};
type Emitter = VfxGpuEmitterProgram;
/** Managed hooks cannot access the storage namespace. Each workgroup can then
 * execute the same authored hook over one independent arena range. */
function createBatchProgram(emitter: Emitter) {
  assert(emitter.capacity > 0 && emitter.capacity <= 256);
  assert(
    emitter.renderers.every(
      (renderer) => renderer.kind === 'mesh' || renderer.kind === 'billboard',
    ),
  );
  assert(
    (emitter.reflection.layout?.parameters.size ?? 0) === 0,
    'Parameter table not implemented',
  );
  assert((emitter.reflection.dataInterfaces?.length ?? 0) === 0 && !emitter.forceFields);
  assert(!emitter.reflection.entryPoints.includes('forgeax_vfx_event_main'));
  assert(emitter.reflection.bindings.length === 1);
  const customStride = emitter.reflection.layout?.customLayout?.stride ?? 0;
  assert(Number.isSafeInteger(customStride) && customStride > 0 && customStride % 4 === 0);
  const group = emitter.reflection.bindings[0];
  assert(group !== undefined);
  const buffers = group.entries;
  assert(buffers.map((e) => e.binding).join(',') === '0,1,2,3,4,5,6,11');
  let source = emitter.wgsl;
  assert(!source.includes('forgeax_vfx_batch_'));
  const originalRuntime =
    /@group\(0\)\s+@binding\(1\)\s+var<uniform> forgeax_vfx_runtime: ForgeaxVfxRuntime;/;
  assert(originalRuntime.test(source), 'Expected canonical cooked Runtime declaration');
  source = source.replace(originalRuntime, 'var<private> forgeax_vfx_runtime: ForgeaxVfxRuntime;');
  const counters = 'var<storage, read_write> forgeax_vfx_counters: ForgeaxVfxCounters;';
  assert(source.includes(counters));
  source = source.replace(
    counters,
    'var<storage, read_write> forgeax_vfx_counters: array<ForgeaxVfxCounters>;',
  );
  for (const [name, offset] of [
    ['forgeax_vfx_particles', 'forgeax_vfx_batch_bases0.x'],
    ['forgeax_vfx_alive_indices', 'forgeax_vfx_batch_bases0.y'],
    ['forgeax_vfx_indirect', 'forgeax_vfx_batch_bases0.w'],
    ['forgeax_vfx_scratch', 'forgeax_vfx_batch_bases1.x'],
    ['forgeax_vfx_billboard_instances', 'forgeax_vfx_batch_bases1.y'],
    ['forgeax_vfx_custom', 'forgeax_vfx_batch_bases1.z'],
  ]) {
    assert(
      !new RegExp(`arrayLength\\s*\\(\\s*&${name}\\s*\\)`).test(source),
      'Whole-array length requires an explicit bounded-job rewrite',
    );
    source = source.replace(new RegExp(`\\b${name}\\s*\\[`, 'g'), `${name}[${offset} + `);
  }
  source = source.replace(
    /\bforgeax_vfx_counters\./g,
    'forgeax_vfx_counters[forgeax_vfx_batch_bases0.z].',
  );
  const wrappers: string[] = [],
    entries: { name: string; workgroupSize: number[] }[] = [];
  const pattern = /@compute\s+@workgroup_size\((\d+)(?:,\s*(\d+),\s*(\d+))?\)\s*fn\s+(\w+)\(/g;
  let cursor = 0,
    rewritten = '';
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const [, x, y, z, name] = match;
    assert(x !== undefined && name !== undefined);
    assert(Number(y ?? 1) === 1 && Number(z ?? 1) === 1);
    let end = pattern.lastIndex,
      depth = 1;
    for (; end < source.length && depth > 0; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')') depth--;
    }
    assert(depth === 0, 'Unclosed entry parameters');
    const args = source.slice(pattern.lastIndex, end - 1);
    let bodyStart = end;
    while (/\s/.test(source[bodyStart] ?? '')) bodyStart++;
    assert(source[bodyStart] === '{', 'Missing entry body');
    // Canonical cooked signatures have only builtin scalar/vec3 arguments.
    const params = [...args.matchAll(/@builtin\((\w+)\)\s+(\w+):\s*([^,]+)/g)];
    const clean = args.replace(/@builtin\(\w+\)\s*/g, '');
    assert(
      params.length === clean.split(',').filter((v) => v.trim()).length,
      `Unknown parameters ${name}`,
    );
    const values: Record<string, string> = {
      global_invocation_id: 'vec3<u32>(batch_invocation.x,0u,0u)',
      workgroup_id: 'vec3<u32>(batch_group.x,0u,0u)',
      local_invocation_id: 'batch_local',
      local_invocation_index: 'batch_local.x',
    };
    const argumentsList = params.map((p) => {
      const builtin = p[1];
      assert(builtin !== undefined && values[builtin], `Unsupported builtin ${builtin}`);
      return values[builtin];
    });
    entries.push({ name, workgroupSize: [Number(x), Number(y ?? 1), Number(z ?? 1)] });
    wrappers.push(`@compute @workgroup_size(${x},${y ?? 1},${z ?? 1})
fn ${name}(@builtin(global_invocation_id) batch_invocation: vec3<u32>, @builtin(workgroup_id) batch_group: vec3<u32>, @builtin(local_invocation_id) batch_local: vec3<u32>) {
  if (all(batch_local == vec3<u32>(0u))) { forgeax_vfx_batch_shared = forgeax_vfx_batch_jobs[batch_group.y + forgeax_vfx_batch_control.x]; }
  workgroupBarrier();
  let batch_job = workgroupUniformLoad(&forgeax_vfx_batch_shared);
  if (batch_job.bases1.w == 0u) { return; }
  forgeax_vfx_runtime = batch_job.runtime;
  forgeax_vfx_batch_bases0 = batch_job.bases0;
  forgeax_vfx_batch_bases1 = batch_job.bases1;
  ${name}_batch_impl(${argumentsList.join(',')});
}`);
    rewritten += `${source.slice(cursor, match.index)}fn ${name}_batch_impl(${clean}) {`;
    cursor = bodyStart + 1;
    pattern.lastIndex = cursor;
  }
  source = rewritten + source.slice(cursor);
  assert(entries.length > 0, 'No cooked compute entries');
  const abi = `
struct ForgeaxVfxBatchJob { runtime: ForgeaxVfxRuntime, bases0: vec4<u32>, bases1: vec4<u32>, }
@group(0) @binding(1) var<storage,read> forgeax_vfx_batch_jobs: array<ForgeaxVfxBatchJob>;
@group(0) @binding(12) var<uniform> forgeax_vfx_batch_control: vec4<u32>;
var<workgroup> forgeax_vfx_batch_shared: ForgeaxVfxBatchJob;
var<private> forgeax_vfx_batch_bases0: vec4<u32>;
var<private> forgeax_vfx_batch_bases1: vec4<u32>;
`;
  return {
    source: source + abi + wrappers.join('\n'),
    entries,
    jobBytes: 336,
    maxWaves: 4,
    bindings: buffers.map((e) => e.binding).concat(12),
    storageBufferCount: 8,
  };
}

/** Only the managed compiler calls this after reserved-surface and source checks.
 * No runtime inference of arbitrary cooked WGSL authorizes this ABI. */
export function createVfxInstanceComputeProgram(
  emitter: VfxGpuEmitterProgram,
): VfxGpuInstanceComputeProgram | undefined {
  try {
    const batch = createBatchProgram(emitter);
    return {
      format: 'forgeax-vfx-instance-compute-1',
      jobBytes: 336,
      wgsl: batch.source,
      bindings: emitter.reflection.bindings.map((group) => ({
        ...group,
        entries: [
          ...group.entries.map((entry) =>
            entry.binding === 1
              ? { ...entry, buffer: { ...entry.buffer, type: 'read-only-storage' as const } }
              : entry,
          ),
          {
            binding: 12,
            visibility: 4,
            buffer: { type: 'uniform' as const, hasDynamicOffset: false, minBindingSize: 0 },
          },
        ],
      })),
    };
  } catch {
    return undefined;
  }
}

export const VFX_INSTANCE_COMPUTE_COMPILER_SOURCE = createBatchProgram.toString();
