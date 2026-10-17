import type { RenderFeatureWork } from '@forgeax/engine-render';

type Resource = RenderFeatureWork['resources'][number];
type Program = Extract<Resource, { kind: 'graphics-program' }>;

function plainData(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object')
    return typeof value !== 'function' && typeof value !== 'symbol';
  if (ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) return false;
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || property === undefined || !('value' in property)) return false;
    if (!plainData(property.value, ancestors)) return false;
  }
  ancestors.delete(value);
  return true;
}

/** The stock native producer has finished every current source read. Collapse
 * identical pipeline declarations in this scope before Host prepares them.
 * Accessor-bearing states keep the complete original normalization order.
 * transferDraws consumes stock per-frame draw/binding records, including on
 * failure; borrowed callers retain the default copy path. */
export function shareVfxGraphicsPrograms(
  work: RenderFeatureWork,
  transferDraws = false,
): RenderFeatureWork {
  const states = new Map<object, string>();
  for (const resource of work.resources) {
    if (resource.kind !== 'graphics-program') continue;
    const state = resource.program.renderState;
    if (state === undefined || states.has(state)) continue;
    if (!plainData(state)) return work;
    states.set(state, JSON.stringify(state));
  }
  const programs = new Map<string, Program>();
  const aliases = new Map<string, string>();
  const resources: Resource[] = [];
  for (const resource of work.resources) {
    if (resource.kind !== 'graphics-program') continue;
    const program = resource.program;
    const key = JSON.stringify([
      program.shader,
      program.preparePipelines,
      program.vertexLayout,
      program.particleInputLanes,
      program.colorFormats,
      program.depthFormat,
      program.sampleCount,
      program.topology,
      program.indexFormat,
      program.renderState === undefined ? null : states.get(program.renderState),
    ]);
    let shared = programs.get(key);
    if (shared === undefined) {
      // Full state, not a roster ordinal or lossy hash. Player birth/retirement
      // cannot rename another live pipeline; changed ABI names a new resource.
      shared = { ...resource, name: `vfx.graphics-program.${key}` };
      programs.set(key, shared);
    }
    aliases.set(resource.name, shared.name);
  }
  if (programs.size === 0) return work;
  const emitted = new Set<string>();
  for (const resource of work.resources) {
    if (resource.kind === 'graphics-program') {
      const name = aliases.get(resource.name);
      if (name === undefined) throw new Error('Missing shared VFX graphics program');
      if (!emitted.has(name)) {
        emitted.add(name);
        resources.push({ ...resource, name });
      }
    } else if (resource.kind === 'graphics-bindings') {
      const program = aliases.get(resource.program) ?? resource.program;
      if (transferDraws) {
        (resource as { program: string }).program = program;
        resources.push(resource);
      } else resources.push({ ...resource, program });
    } else resources.push(resource);
  }
  const passes = transferDraws
    ? work.passes
    : work.passes.map((pass) =>
        pass.kind === 'raster' || pass.kind === 'shadow-caster'
          ? {
              ...pass,
              draws: pass.draws.map((draw) => ({
                ...draw,
                program: aliases.get(draw.program) ?? draw.program,
              })),
            }
          : pass,
      );
  if (transferDraws)
    for (const pass of passes)
      if (pass.kind === 'raster' || pass.kind === 'shadow-caster')
        for (const draw of pass.draws)
          (draw as { program: string }).program = aliases.get(draw.program) ?? draw.program;
  return { ...work, resources, passes };
}
