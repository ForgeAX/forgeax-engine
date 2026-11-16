import { describe, expect, it } from 'vitest';
import { precomputePipelineLibrary } from '../pipeline-library.js';

type Manifest = Parameters<typeof precomputePipelineLibrary>[0];

// Particle-shaped programs: each effect is one whole-program module with its
// own constants and an authored update hook, plus a generic scan stage whose
// closure is identical across effects. A previous writer pass gave each
// program different collision suffixes.
function effect(index: number, runtime = 'delta: f32, capacity: u32,'): string {
  const s = `_${index + 10}_`;
  return `struct ForgeaxVfxRuntime { ${runtime} }
const TG_EFFECT${s}SCALE: f32 = ${index + 1}.5;
@group(0) @binding(0) var<storage, read_write> forgeax_vfx_particles: array<f32>;
@group(0) @binding(1) var<uniform> forgeax_vfx_runtime: ForgeaxVfxRuntime;
@group(0) @binding(5) var<storage, read_write> forgeax_vfx_scratch: array<u32>;
@compute @workgroup_size(64) fn forgeax_vfx_update_main(@builtin(global_invocation_id) id${s}: vec3<u32>) {
  let index${s} = id${s}.x;
  if (index${s} < forgeax_vfx_runtime.capacity) {
    forgeax_vfx_particles[index${s}] += forgeax_vfx_runtime.delta * TG_EFFECT${s}SCALE;
  }
}
@compute @workgroup_size(64) fn forgeax_vfx_scan_blocks_main(@builtin(global_invocation_id) id${s}: vec3<u32>) {
  let index${s} = id${s}.x;
  var flag${s}: u32 = 0u;
  if (index${s} < forgeax_vfx_runtime.capacity) { flag${s} = forgeax_vfx_scratch[index${s}]; }
  forgeax_vfx_scratch[forgeax_vfx_runtime.capacity + index${s}] = flag${s};
}
`;
}

function library(codes: readonly string[]): Manifest {
  return {
    version: 1,
    backend: 'webgpu',
    shaders: codes.map((code) => ({ code })),
    bindGroupLayouts: [],
    pipelineLayouts: [],
    renderPipelines: [],
    computePipelines: codes.flatMap((_, module) =>
      ['forgeax_vfx_update_main', 'forgeax_vfx_scan_blocks_main'].map((entryPoint) => ({
        layout: 'auto' as const,
        compute: { module, entryPoint },
      })),
    ),
  };
}

/** Distinct (module after projection, entry, layout) programs the player compiles. */
function programs(manifest: Manifest): number {
  const projected = new Map(
    (manifest.computeEntryModules ?? []).map((row) => [
      `${row.module}:${row.entryPoint}`,
      row.specializedModule,
    ]),
  );
  const keys = manifest.computePipelines.map(({ layout, compute }) => {
    const module = projected.get(`${compute.module}:${compute.entryPoint}`) ?? compute.module;
    return JSON.stringify([manifest.shaders[module]?.code, compute.entryPoint, layout]);
  });
  return new Set(keys).size;
}

function modules(manifest: Manifest): number {
  const projected = new Map(
    (manifest.computeEntryModules ?? []).map((row) => [
      `${row.module}:${row.entryPoint}`,
      row.specializedModule,
    ]),
  );
  return new Set(
    manifest.computePipelines.map(
      ({ compute }) => projected.get(`${compute.module}:${compute.entryPoint}`) ?? compute.module,
    ),
  ).size;
}

describe('compute entry sharing with the real compiler', () => {
  const effects = 6;

  it('folds identical generic stages of differently named programs', async () => {
    const original = library(Array.from({ length: effects }, (_, i) => effect(i)));
    expect(programs(original)).toBe(effects * 2);
    const result = await precomputePipelineLibrary(original);
    // Every effect keeps its own update hook; the scan stage is one program.
    expect(programs(result)).toBe(effects + 1);
    expect(modules(result)).toBe(effects + 1);
    expect(result.computeEntryModules).toHaveLength(effects);
  });

  it('keeps programs with different runtime layouts distinct', async () => {
    const codes = Array.from({ length: effects }, (_, i) =>
      effect(
        i,
        i % 2 === 0 ? 'delta: f32, capacity: u32,' : 'delta: f32, capacity: u32, tick: u32,',
      ),
    );
    const result = await precomputePipelineLibrary(library(codes));
    expect(programs(result)).toBe(effects + 2);
  });

  it('round-trips an exported library without recomputing or losing sharing', async () => {
    const first = await precomputePipelineLibrary(
      library(Array.from({ length: effects }, (_, i) => effect(i))),
    );
    const imported = JSON.parse(JSON.stringify(first)) as Manifest;
    const second = await precomputePipelineLibrary(imported);
    expect(second.computeEntryModules).toEqual(first.computeEntryModules);
    expect(second.shaders).toEqual(first.shaders);
    expect(programs(second)).toBe(programs(first));
    expect(modules(second)).toBe(modules(first));
  });
});
