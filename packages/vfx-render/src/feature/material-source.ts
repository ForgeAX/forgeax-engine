import { type MaterialRenderProjection, sameMaterialContext } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { RenderFeaturePlanContext } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-types';
import type { ParticleRendererSourceV3 } from '@forgeax/engine-vfx';

type Context = RenderFeaturePlanContext['materialContext'];
export interface ParticleMaterialSource {
  read(world: World, reference: ParticleRendererSourceV3['material']): MaterialAsset | undefined;
  projection?(world: World, material: MaterialAsset): MaterialRenderProjection | undefined;
  captureFrame?(world: World): boolean;
}

// Only the runtime host constructs this provider. Raw providers keep the original
// two-argument callback and its receiver/getter/exception observation boundary.
class HostMaterialSource implements ParticleMaterialSource {
  readonly #project: (
    world: World,
    material: MaterialAsset,
    context: Context,
  ) => MaterialRenderProjection | undefined;
  constructor(
    readonly read: ParticleMaterialSource['read'],
    readonly captureFrame: NonNullable<ParticleMaterialSource['captureFrame']>,
    project: (
      world: World,
      material: MaterialAsset,
      context: Context,
    ) => MaterialRenderProjection | undefined,
  ) {
    this.#project = project;
  }
  projection(world: World, material: MaterialAsset): MaterialRenderProjection | undefined {
    return this.#project(world, material, undefined);
  }
  static project(
    source: ParticleMaterialSource | undefined,
    world: World,
    material: MaterialAsset,
    context: Context,
  ): MaterialRenderProjection | undefined {
    return source != null && #project in source
      ? source.#project(world, material, context)
      : source?.projection?.(world, material);
  }
}

export function createHostMaterialSource(
  read: ParticleMaterialSource['read'],
  captureFrame: NonNullable<ParticleMaterialSource['captureFrame']>,
  project: (
    world: World,
    material: MaterialAsset,
    context: Context,
  ) => MaterialRenderProjection | undefined,
): ParticleMaterialSource {
  return new HostMaterialSource(read, captureFrame, project);
}
export const projectParticleMaterial = HostMaterialSource.project;

// Frozen contexts contain only primitive data and cannot change between frames.
const immutableContexts = new WeakSet<object>();
const immutableData = new WeakSet<object>();

// Dropped rows would otherwise cross structured clone, which observes enumerable
// accessors and rejects non-cloneable values. Leave those publications complete.
function dataOnly(value: unknown, seen: Set<object>): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
    return typeof value !== 'function' && typeof value !== 'symbol';
  if (immutableContexts.has(value) || immutableData.has(value) || seen.has(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
    return false;
  seen.add(value);
  let immutable = Object.isFrozen(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key === 'symbol' || descriptor?.enumerable !== true) continue;
    if (!('value' in descriptor) || !dataOnly(descriptor.value, seen)) return false;
    const child = descriptor.value;
    // A frozen parent alone does not make its children immutable. Cycles stay
    // on the per-publication path until every child is independently proven.
    if (
      child !== null &&
      typeof child === 'object' &&
      !immutableContexts.has(child) &&
      !immutableData.has(child)
    )
      immutable = false;
  }
  if (immutable) immutableData.add(value);
  return true;
}

// The stock projector creates fresh pass/program records. Only the nested
// context must be immutable here; ABI, render state and values remain live.
// Keeping every matching color/address row preserves the receiver's selector,
// even when a later material read mutates the current ABI before publication.
function contextData(projection: MaterialRenderProjection): boolean {
  for (const pass of projection.passes)
    for (const program of pass.programs) {
      if (immutableContexts.has(program.context)) continue;
      if (
        !Object.isFrozen(program.context) ||
        Object.getPrototypeOf(program.context) !== Object.prototype
      )
        return false;
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(program.context)))
        if (
          !('value' in descriptor) ||
          (descriptor.value !== null &&
            (typeof descriptor.value === 'object' || typeof descriptor.value === 'function')) ||
          (descriptor.enumerable && typeof descriptor.value === 'symbol')
        )
          return false;
      immutableContexts.add(program.context);
    }
  return true;
}

const particlePasses = new Set([
  'particle-billboard',
  'particle-mesh',
  'particle-ribbon',
  'particle-trail',
  'particle-beam',
]);

/** Current stock projection only: no retained result or immutable ABI assumption. */
export function selectParticleMaterialContext(
  projection: MaterialRenderProjection,
  context: Context,
): MaterialRenderProjection {
  if (context === undefined) return projection;
  try {
    // Inspection is optional. An exotic nested value may reject descriptor
    // discovery; preserve its original clone/receiving failure boundary.
    if (!contextData(projection) || !dataOnly(projection, new Set())) return projection;
    const passes = projection.passes.map((pass) => {
      if (!particlePasses.has(pass.name)) return pass;
      const programs = pass.programs.filter((program) =>
        sameMaterialContext(program.context, context),
      );
      // Keep a missing domain intact for the original receiving admission error.
      if (programs.length === 0) throw new Error('Unavailable particle material context');
      return programs.length === pass.programs.length ? pass : { ...pass, programs };
    });
    const modern = (rows: MaterialRenderProjection['passes']) =>
      rows.some((pass) =>
        pass.programs.some(
          (program) =>
            program.context.pipeline !== 'ray' &&
            (program.address !== undefined ||
              program.entry !== undefined ||
              program.abi !== undefined),
        ),
      );
    return modern(passes) === modern(projection.passes) ? { ...projection, passes } : projection;
  } catch {
    return projection;
  }
}
