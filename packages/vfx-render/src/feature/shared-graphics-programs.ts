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

type Descriptor = Program['program'];

/** Descriptors whose producer guarantees they are never mutated after registration. */
const ownedPrograms = new WeakSet<object>();
/** Sharing key per owned descriptor, computed at most once per descriptor object. */
const programKeys = new WeakMap<object, string>();

/**
 * Register a producer-owned graphics program descriptor. The descriptor and
 * its color format list are frozen, and its render state must already be
 * immutable plain data; its sharing key is then computed once instead of on
 * every frame that declares it.
 */
export function ownVfxGraphicsProgram<T extends Descriptor>(program: T): T {
  Object.freeze(program.colorFormats);
  Object.freeze(program);
  if (program.renderState === undefined || deepFrozenPlainData(program.renderState))
    ownedPrograms.add(program);
  return program;
}

const frozenStates = new WeakSet<object>();
function deepFrozenPlainData(value: object): boolean {
  if (frozenStates.has(value)) return true;
  if (!Object.isFrozen(value) || !plainData(value)) return false;
  for (const key of Object.keys(value)) {
    const property = (value as Record<string, unknown>)[key];
    if (property !== null && typeof property === 'object' && !deepFrozenPlainData(property))
      return false;
  }
  frozenStates.add(value);
  return true;
}

/** Exact structural equality of two plain-data values: same keys, order and values. */
function samePlainData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index++) {
    const key = leftKeys[index] as string | symbol;
    if (key !== rightKeys[index]) return false;
    const leftProperty = Object.getOwnPropertyDescriptor(left, key);
    const rightProperty = Object.getOwnPropertyDescriptor(right, key);
    if (
      leftProperty === undefined ||
      rightProperty === undefined ||
      !('value' in leftProperty) ||
      !('value' in rightProperty) ||
      leftProperty.enumerable !== rightProperty.enumerable ||
      !samePlainData(leftProperty.value, rightProperty.value)
    )
      return false;
  }
  return true;
}

function deepFreeze<T extends object>(value: T): T {
  for (const property of Object.values(value))
    if (property !== null && typeof property === 'object') deepFreeze(property);
  return Object.freeze(value);
}

/** Interned immutable copies by JSON bucket; exact equality decides within a bucket. */
const internedStates = new Map<string, object[]>();
/** Last interned copy per source object, revalidated by content on every use. */
const internedSources = new WeakMap<object, object>();
const INTERNED_STATE_LIMIT = 256;

/**
 * One deep-frozen render state per exact content. A material publication that
 * crosses a Worker arrives as a new object every frame; its content-identical
 * state then keeps one identity, so a steady view reuses its graphics program
 * descriptor and sharing key instead of rebuilding both every frame. A source
 * is always compared by content, never trusted by identity alone, so a changed
 * state always yields its own copy. Non-plain states are returned unchanged.
 */
export function internVfxRenderState<T extends object>(state: T): T {
  if (frozenStates.has(state)) return state;
  const prior = internedSources.get(state);
  if (prior !== undefined && samePlainData(prior, state)) return prior as T;
  if (deepFrozenPlainData(state) || !plainData(state)) return state;
  const key = JSON.stringify(state);
  let bucket = internedStates.get(key);
  let interned = bucket?.find((candidate) => samePlainData(candidate, state));
  if (interned === undefined) {
    const copy = structuredClone(state);
    // Only a lossless copy may stand in for the source.
    if (!samePlainData(copy, state)) return state;
    interned = deepFreeze(copy);
    deepFrozenPlainData(interned);
    if (bucket === undefined) {
      if (internedStates.size >= INTERNED_STATE_LIMIT) internedStates.clear();
      bucket = [];
      internedStates.set(key, bucket);
    }
    bucket.push(interned);
  }
  internedSources.set(state, interned);
  return interned as T;
}

function programKey(program: Descriptor, state: string | undefined): string {
  return JSON.stringify([
    program.shader,
    program.preparePipelines,
    program.vertexLayout,
    program.particleInputLanes,
    program.colorFormats,
    program.depthFormat,
    program.sampleCount,
    program.topology,
    program.indexFormat,
    state ?? null,
  ]);
}

/**
 * Content key of one producer-owned descriptor, identical to the key that
 * names its shared declaration below; undefined when its render state is not
 * plain data (such a descriptor keeps its private declaration).
 */
export function vfxGraphicsProgramKey(program: Descriptor): string | undefined {
  const state = program.renderState;
  if (state !== undefined && !plainData(state)) return undefined;
  return programKey(program, state === undefined ? undefined : JSON.stringify(state));
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
    // An owned descriptor's state was proven immutable plain data at registration.
    if (programKeys.has(resource.program)) continue;
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
    let key = programKeys.get(program);
    if (key === undefined) {
      key = programKey(
        program,
        program.renderState === undefined ? undefined : states.get(program.renderState),
      );
      if (ownedPrograms.has(program)) programKeys.set(program, key);
    }
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
