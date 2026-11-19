import type { RenderFeatureWorkPlan } from '@forgeax/engine-render';
import { ownRenderFeatureProgramData } from '@forgeax/engine-render/internal';
import type { ShaderEntryPointReads } from '@forgeax/engine-types';
import type { RenderFeatureGpuProgramDescriptor } from '../../../render/src/features/prepared-gpu-work';

type Resource = RenderFeatureWorkPlan['resources'][number];
type Pass = RenderFeatureWorkPlan['passes'][number];
type Program = Extract<Resource, { kind: 'compute-program' }>;
type Bindings = Extract<Resource, { kind: 'compute-bindings' }>;
type Compute = Extract<Pass, { kind: 'compute' }>;
const proofs = new WeakMap<RenderFeatureGpuProgramDescriptor, readonly ShaderEntryPointReads[]>();
const descriptors = new WeakMap<
  RenderFeatureGpuProgramDescriptor,
  Map<string, RenderFeatureGpuProgramDescriptor>
>();
/** Proofs stay on the receiver-owned program built from the published emitter reflection. */
export function registerVfxEntryPointBindings(
  program: RenderFeatureGpuProgramDescriptor,
  entries: readonly ShaderEntryPointReads[] | undefined,
): void {
  if (entries !== undefined) proofs.set(program, entries);
}
function entryLayout(
  program: Program,
  entry: string,
): RenderFeatureGpuProgramDescriptor | undefined {
  const proof = proofs
    .get(program.program)
    ?.find((row) => row.name === entry && row.stage === 'compute');
  const group = program.program.bindings?.[0];
  if (!proof || !group) return undefined;
  let cache = descriptors.get(program.program);
  if (!cache) {
    cache = new Map();
    descriptors.set(program.program, cache);
  }
  const prior = cache.get(entry);
  if (prior) return prior;
  const reads = new Set(proof.bindings.filter((row) => row.group === 0).map((row) => row.binding));
  const projected = ownRenderFeatureProgramData({
    ...program.program,
    entryPoints: [entry],
    bindings: [{ ...group, entries: group.entries.filter((row) => reads.has(row.binding)) }],
  });
  cache.set(entry, projected);
  return projected;
}
interface Work {
  resources: Resource[];
  passes: Pass[];
}
/** Emit native single-entry programs instead of an invalid all-entry BGL union.
 * Every dispatch remains in author order; neither WGSL nor its resource operations change. */
export function projectVfxEntryPointLayouts(work: readonly Work[]): void {
  const resources = new Map<string, Resource>();
  for (const row of work)
    for (const resource of row.resources) resources.set(resource.name, resource);
  const programs = new Map<string, Map<string, Program>>();
  for (const resource of resources.values()) {
    if (resource.kind !== 'compute-program' || !proofs.has(resource.program)) continue;
    const entries = new Map<string, Program>();
    for (const [index, entry] of resource.program.entryPoints.entries()) {
      const descriptor = entryLayout(resource, entry);
      if (!descriptor) throw new Error(`VFX entry layout proof missing: ${resource.name}/${entry}`);
      entries.set(entry, { ...resource, name: `${resource.name}.e${index}`, program: descriptor });
    }
    programs.set(resource.name, entries);
  }
  if (programs.size === 0) return;
  for (const row of work) projectWork(row, resources, programs);
}
function projectWork(
  work: Work,
  resources: ReadonlyMap<string, Resource>,
  programs: ReadonlyMap<string, Map<string, Program>>,
): void {
  const output: Resource[] = [];
  for (const resource of work.resources) {
    if (resource.kind === 'compute-program' && programs.has(resource.name))
      output.push(...(programs.get(resource.name)?.values() ?? []));
    else if (resource.kind !== 'compute-bindings' || !programs.has(resource.program))
      output.push(resource);
  }
  const bindingCache = new Map<string, string>();
  const binding = (name: string, program: Program): string => {
    const key = `${name}|${program.name}`;
    const prior = bindingCache.get(key);
    if (prior) return prior;
    const original = resources.get(name);
    if (original?.kind !== 'compute-bindings')
      throw new Error(`VFX compute bindings missing: ${name}`);
    const entries = new Set(program.program.bindings?.[0]?.entries.map((row) => row.binding) ?? []);
    const projected: Bindings = {
      ...original,
      name: `${name}.${program.name.slice(program.name.lastIndexOf('.') + 1)}`,
      program: program.name,
      entries: original.entries.filter((row) => entries.has(row.binding)),
    };
    output.push(projected);
    bindingCache.set(key, projected.name);
    return projected.name;
  };
  const passes: Pass[] = [];
  for (const pass of work.passes) {
    const entries = pass.kind === 'compute' ? programs.get(pass.program) : undefined;
    if (pass.kind !== 'compute' || !entries) {
      passes.push(pass);
      continue;
    }
    appendComputeRuns(pass, entries, binding, passes);
  }
  work.resources.length = 0;
  work.resources.push(...output);
  work.passes.length = 0;
  work.passes.push(...passes);
}
function appendComputeRuns(
  pass: Compute,
  entries: ReadonlyMap<string, Program>,
  binding: (name: string, program: Program) => string,
  output: Pass[],
): void {
  let run: Compute | undefined;
  for (const [index, dispatch] of pass.dispatches.entries()) {
    const program = entries.get(dispatch.entryPoint);
    if (!program) throw new Error(`VFX undeclared entry: ${dispatch.entryPoint}`);
    const selected = binding(dispatch.bindings ?? pass.bindings, program);
    const projected = { ...dispatch, bindings: selected };
    if (run?.program === program.name) {
      run = { ...run, dispatches: [...run.dispatches, projected] };
      output[output.length - 1] = run;
    } else {
      run = {
        ...pass,
        name: `${pass.name}.e${index}`,
        program: program.name,
        bindings: selected,
        dispatches: [projected],
      };
      output.push(run);
    }
  }
}
