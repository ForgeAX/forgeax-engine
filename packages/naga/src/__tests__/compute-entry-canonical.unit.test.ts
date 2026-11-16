import { describe, expect, it } from 'vitest';
import {
  emit_reflection,
  parse,
  parseReflectionWire,
  specializeComputeEntries,
  validate,
} from '../index.js';

// Programs shaped like the cooked particle runtime: one whole-program module
// with several compute entries, effect constants and names that a previous
// writer pass suffixed differently in each program.
interface ProgramShape {
  readonly timeFields: boolean;
  readonly singleBlock: boolean;
  readonly batched?: { readonly parameterBytes: number };
  readonly effectConstant: string;
  readonly suffix: string;
}

function runtimeStruct(timeFields: boolean): string {
  const time = timeFields
    ? 'timeFract: f32, timeWhole: u32, worldTimeFract: f32, worldTimeWhole: u32,'
    : '';
  return `struct ForgeaxVfxRuntime { delta: f32, tick: u32, capacity: u32, spawnCount: u32, ${time} }`;
}

function runtimeBinding(shape: ProgramShape): string {
  if (shape.batched === undefined) {
    return '@group(0) @binding(1) var<uniform> forgeax_vfx_runtime: ForgeaxVfxRuntime;';
  }
  const parameters = Array.from(
    { length: shape.batched.parameterBytes / 4 },
    (_, i) => `p${String.fromCharCode(97 + i)}: f32,`,
  ).join(' ');
  return `struct VfxParameters { ${parameters} }
struct ForgeaxVfxBatchJob { runtime: ForgeaxVfxRuntime, parameters: VfxParameters, }
@group(0) @binding(12) var<storage, read> forgeax_vfx_batch_jobs: array<ForgeaxVfxBatchJob>;
var<private> forgeax_vfx_runtime: ForgeaxVfxRuntime;`;
}

function scanEntry(shape: ProgramShape): string {
  const s = shape.suffix;
  const body = `
  let index${s} = invocation${s}.x;
  let lane${s} = local${s}.x;
  var flag${s}: u32 = 0u;
  if (index${s} < forgeax_vfx_runtime.capacity) { flag${s} = forgeax_vfx_scratch[index${s}]; }
  forgeax_vfx_scan_scratch[lane${s}] = flag${s};
  workgroupBarrier();
  var offset${s}: u32 = 1u;
  loop {
    if (offset${s} >= 256u) { break; }
    var addend${s}: u32 = 0u;
    if (lane${s} >= offset${s}) { addend${s} = forgeax_vfx_scan_scratch[lane${s} - offset${s}]; }
    workgroupBarrier();
    forgeax_vfx_scan_scratch[lane${s}] = forgeax_vfx_scan_scratch[lane${s}] + addend${s};
    workgroupBarrier();
    offset${s} = offset${s} * 2u;
  }
  if (index${s} < forgeax_vfx_runtime.capacity) {
    forgeax_vfx_scratch[forgeax_vfx_runtime.capacity + index${s}] = forgeax_vfx_scan_scratch[lane${s}] - flag${s};
  }
  if (lane${s} == 255u) {
    forgeax_vfx_scratch[forgeax_vfx_runtime.capacity * 2u + group${s}.x] = forgeax_vfx_scan_scratch[lane${s}];
  }`;
  const params = `@builtin(global_invocation_id) invocation${s}: vec3<u32>, @builtin(local_invocation_id) local${s}: vec3<u32>, @builtin(workgroup_id) group${s}: vec3<u32>`;
  const load =
    shape.batched === undefined ? '' : 'forgeax_vfx_runtime = forgeax_vfx_batch_jobs[0].runtime;';
  if (!shape.singleBlock) {
    return `@compute @workgroup_size(256) fn forgeax_vfx_scan_blocks_main(${params}) { ${load} ${body} }`;
  }
  return `fn forgeax_vfx_scan_block(${params.replace(/@builtin\([a-z_]+\) /g, '')}) { ${body} }
@compute @workgroup_size(256) fn forgeax_vfx_scan_blocks_main(${params}) {
  ${load}
  forgeax_vfx_scan_block(invocation${s}, local${s}, group${s});
}`;
}

function program(shape: ProgramShape): string {
  const s = shape.suffix;
  return `${runtimeStruct(shape.timeFields)}
struct VfxParticle { position: vec3<f32>, age: f32, }
const ${shape.effectConstant}: f32 = 0.25;
const FORGEAX_VFX_SORT_KEY_CAPACITY: u32 = 32u;
@group(0) @binding(0) var<storage, read_write> forgeax_vfx_particles: array<VfxParticle>;
${runtimeBinding(shape)}
@group(0) @binding(5) var<storage, read_write> forgeax_vfx_scratch: array<u32>;
var<workgroup> forgeax_vfx_scan_scratch: array<u32, 256>;
fn vfx_update(index${s}: u32) {
  forgeax_vfx_particles[index${s}].age += forgeax_vfx_runtime.delta * ${shape.effectConstant};
}
@compute @workgroup_size(256) fn forgeax_vfx_update_main(@builtin(global_invocation_id) invocation${s}: vec3<u32>) {
  if (invocation${s}.x < forgeax_vfx_runtime.capacity) { vfx_update(invocation${s}.x); }
}
${scanEntry(shape)}
`;
}

const scan = 'forgeax_vfx_scan_blocks_main';
const update = 'forgeax_vfx_update_main';
const base: ProgramShape = {
  timeFields: true,
  singleBlock: false,
  effectConstant: 'TG_FIRE_DELAY',
  suffix: '',
};

async function closure(source: string, entry: string): Promise<string> {
  const projected = await specializeComputeEntries(source, [entry]);
  if (!projected.ok) throw projected.error;
  const selected = projected.value[0];
  expect(selected?.entryPoint).toBe(entry);
  return selected?.source ?? '';
}

async function reflect(source: string) {
  const parsed = await parse(source);
  if (!parsed.ok) throw parsed.error;
  const checked = await validate(parsed.value);
  if (!checked.ok) throw checked.error;
  try {
    const reflected = await emit_reflection(checked.value, '{}');
    if (!reflected.ok) throw reflected.error;
    return parseReflectionWire(reflected.value);
  } finally {
    checked.value.free();
  }
}

/** The closure's reflected interface must match the original program's view
 * of the same entry: every binding it reads, with identical layouts. */
// Synthetic names avoid a trailing digit: the WGSL writer appends `_` to those
// in every projection, which predates canonicalisation.
async function expectSameInterface(original: string, canonical: string, entry: string) {
  const whole = await reflect(original);
  const projected = await reflect(canonical);
  const reads = whole.entryPoints?.find((candidate) => candidate.name === entry);
  expect(projected.entryPoints).toEqual([reads]);
  const used = new Set(reads?.bindings.map((b) => `${b.group}:${b.binding}`));
  const layout = (globals: typeof whole.boundGlobals) =>
    globals
      .filter((g) => used.has(`${g.group}:${g.binding}`))
      .map(({ visibility: _visibility, ...global }) => global);
  expect(layout(projected.boundGlobals)).toEqual(layout(whole.boundGlobals));
  const workgroup = (source: string) => {
    const match = new RegExp(`@workgroup_size\\(([^)]*)\\)\\s*fn ${entry}\\b`).exec(source);
    return match?.[1]?.split(',').map((size) => Number(size.trim()) || 1);
  };
  const size = workgroup(original);
  expect(size).toBeDefined();
  expect(workgroup(canonical)).toEqual([...(size ?? []), 1, 1].slice(0, 3));
}

describe('canonical compute entry closures', () => {
  const variants: readonly [string, ProgramShape][] = [
    ['multi-block', base],
    ['single-block', { ...base, singleBlock: true }],
    ['runtime without time fields', { ...base, timeFields: false }],
    ['batched', { ...base, batched: { parameterBytes: 16 } }],
  ];

  it.each(variants)('%s: identical generic stages produce identical text', async (_, shape) => {
    const first = program(shape);
    // Another effect: other constants and the suffixes a previous writer gave it.
    const second = program({ ...shape, effectConstant: 'TG_GRAVITY', suffix: '_19_' });
    expect(second).not.toBe(first);
    const a = await closure(first, scan);
    const b = await closure(second, scan);
    expect(b).toBe(a);
    expect(a).not.toContain('TG_FIRE_DELAY');
    expect(a).not.toContain('FORGEAX_VFX_SORT_KEY_CAPACITY');
    await expectSameInterface(first, a, scan);
    await expectSameInterface(second, b, scan);
  });

  it('keeps referenced constants and distinguishes entries that use different ones', async () => {
    const a = await closure(program(base), update);
    const b = await closure(program({ ...base, effectConstant: 'TG_GRAVITY' }), update);
    expect(a).toContain('const TG_FIRE_DELAY: f32 = 0.25f;');
    expect(b).toContain('const TG_GRAVITY');
    expect(b).not.toBe(a);
    await expectSameInterface(program(base), a, update);
  });

  it('keeps distinct layouts and helper shapes as distinct closures', async () => {
    const texts = await Promise.all(variants.map(([, shape]) => closure(program(shape), scan)));
    expect(new Set(texts).size).toBe(variants.length);
    const batched = await Promise.all(
      [16, 32].map((parameterBytes) =>
        closure(program({ ...base, batched: { parameterBytes } }), scan),
      ),
    );
    expect(batched[1]).not.toBe(batched[0]);
  });

  it('never merges distinct identifiers or renames retained module names', async () => {
    // Retained names that equal or extend the fresh bases stay intact.
    const source = `
      @group(0) @binding(0) var<storage, read_write> param: array<u32>;
      @group(0) @binding(1) var<storage, read_write> local_store: array<u32>;
      fn value(a: u32, b: u32) -> u32 { let d = a - b; let e = b - a; return d * 3u + e; }
      @compute @workgroup_size(8) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        var x: u32 = id.x; var y: u32 = id.y;
        param[x] = value(x, y); local_store[y] = value(y, x);
      }`;
    const swapped = source.replace(
      'let d = a - b; let e = b - a;',
      'let d = b - a; let e = a - b;',
    );
    const a = await closure(source, 'main');
    const b = await closure(swapped, 'main');
    expect(b).not.toBe(a);
    for (const name of ['var<storage, read_write> param:', 'local_store:', 'fn value(']) {
      expect(a).toContain(name);
    }
    await expectSameInterface(source, a, 'main');
  });
});
