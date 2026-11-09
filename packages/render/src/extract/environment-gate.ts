import type { Component, EntityHandle, QueryDescriptor, World } from '@forgeax/engine-ecs';
import { isQueryIterating } from '@forgeax/engine-ecs/internal';
import {
  createStateProjection,
  readEntityComponentEpoch,
  readMutationEpoch,
  readMutationEpochExcept,
  type StateProjection,
} from '@forgeax/engine-ecs/projection';
import {
  GlobalTransform,
  readPresentationWorldMatrix,
  Transform,
  TransformInterpolation,
} from '@forgeax/engine-scene';
import { sameValue } from '../same-value';

interface InputReads {
  readonly components: Set<Component>;
  readonly candidates: Set<Component>;
  readonly globals: Set<Component>;
}
interface Observation {
  readonly world: World;
  readonly inputs: InputReads | undefined;
  readonly poses: EntityHandle[];
  volatile: boolean;
}
/** One synchronous extraction owns its observation and restores its parent. */
let observation: Observation | undefined;
const QUERY_INPUT_ROLES = ['read', 'write', 'optional', 'with', 'without'] as const;
const INPUT_SETS = ['components', 'candidates', 'globals'] as const;

function observedInputs(world: World): InputReads | undefined {
  if (observation === undefined) return undefined;
  if (observation.world === world) return observation.inputs;
  observation.volatile = true;
  return undefined;
}

/** One declared stock read Query per World, with ordinary live ECS iteration. */
export function createEnvironmentQuery<
  const R extends readonly Component[] = readonly [],
  const O extends readonly Component[] = readonly [],
>(descriptor: Pick<QueryDescriptor<R, readonly [], O>, 'read' | 'optional' | 'with' | 'without'>) {
  const owned = Object.freeze({
    ...(descriptor.read === undefined ? {} : { read: Object.freeze([...descriptor.read]) as R }),
    ...(descriptor.optional === undefined
      ? {}
      : { optional: Object.freeze([...descriptor.optional]) as O }),
    ...(descriptor.with === undefined ? {} : { with: Object.freeze([...descriptor.with]) }),
    ...(descriptor.without === undefined
      ? {}
      : { without: Object.freeze([...descriptor.without]) }),
  });
  const construct = (world: World) => world.query<R, readonly [], O>(owned);
  const queries = new WeakMap<World, ReturnType<typeof construct>>();
  return (world: World): ReturnType<typeof construct> => {
    noteQueryInputs(world, owned);
    const cached = queries.get(world);
    if (cached?.ok && !isQueryIterating(cached.value)) return cached;
    // Error callbacks can extract this same World while the outer cursor lives.
    // That cold invocation gets an independent Query, never the outer cursor.
    const query = construct(world);
    if (cached === undefined && query.ok) queries.set(world, query);
    return query;
  };
}

/** Record the actual query vocabulary, including optional absence and joins. */
export function queryEnvironment<
  const R extends readonly Component[] = readonly [],
  const W extends readonly Component[] = readonly [],
  const O extends readonly Component[] = readonly [],
>(world: World, descriptor: QueryDescriptor<R, W, O>) {
  noteQueryInputs(world, descriptor);
  return world.query(descriptor);
}

function noteQueryInputs(world: World, descriptor: QueryDescriptor) {
  const reads = observedInputs(world);
  if (reads !== undefined) {
    for (let roleIndex = 0; roleIndex < QUERY_INPUT_ROLES.length; roleIndex++) {
      const role = QUERY_INPUT_ROLES[roleIndex];
      if (role === undefined) continue;
      const components = descriptor[role];
      if (components === undefined) continue;
      for (let index = 0; index < components.length; index++) {
        const component = components[index];
        if (component !== undefined) reads.components.add(component);
      }
    }
    const candidates = descriptor.read ?? descriptor.with;
    if (candidates !== undefined)
      for (let index = 0; index < candidates.length; index++) {
        const component = candidates[index];
        if (component !== undefined && component !== Transform && component !== GlobalTransform)
          reads.candidates.add(component);
      }
  }
}

/** Dependencies read outside query iteration, including cached queries and hierarchy. */
export function noteEnvironmentInputs(world: World, components: readonly Component[]): void {
  const reads = observedInputs(world);
  if (reads === undefined) return;
  for (const component of components) reads.globals.add(component);
}

/**
 * The presentation pose of an environment entity (camera, light, probe, decal,
 * sky). Every environment pose read goes through here, so the gate knows the
 * exact entities whose movement changes the environment.
 */
export function readEnvironmentPose(world: World, entity: EntityHandle) {
  if (observation?.world === world) observation.poses.push(entity);
  else if (observation !== undefined) observation.volatile = true;
  return readPresentationWorldMatrix(world, entity);
}

/** Note an environment entity whose propagated world transform was read directly. */
export function noteEnvironmentPose(entity: EntityHandle): void {
  observation?.poses.push(entity);
}

const POSE = [Transform, GlobalTransform] as const;

/** The explicit inputs one environment extraction read, and its result. */
interface Extraction<T> {
  readonly value: T;
  readonly structureEpoch: number;
  /** World mutation epoch the extraction observed. */
  readonly epoch: number;
  readonly key: string;
  readonly poses: readonly EntityHandle[];
  /** Read World Time (volumetric fog, cloud layer) or routed an error: never reused. */
  readonly volatile: boolean;
  readonly source: StateProjection | undefined;
  readonly globals: StateProjection | undefined;
  readonly inputs: InputReads | undefined;
}

/** Successful nested results carry dependencies even when their own cache hit. */
function observeNested(world: World, extraction: Extraction<unknown>): void {
  const parent = observation;
  if (parent === undefined) return;
  if (parent.world !== world) {
    parent.volatile = true;
    return;
  }
  if (extraction.volatile || parent.inputs === undefined || extraction.inputs === undefined)
    parent.volatile = true;
  if (parent.inputs !== undefined && extraction.inputs !== undefined)
    for (const role of INPUT_SETS) {
      const target = parent.inputs[role];
      extraction.inputs[role].forEach(target.add, target);
    }
  for (let index = 0; index < extraction.poses.length; index++) {
    const entity = extraction.poses[index];
    if (entity !== undefined) parent.poses.push(entity);
  }
}

/**
 * Change-driven environment extraction of source Worlds: a World's cameras,
 * lights, probes, sky, fog, decals and post-process parameters are extracted
 * again only when an explicit input changed, otherwise the previous result is
 * returned with its identities. The inputs are:
 *
 * - actual stock query inputs, with membership reconciled by ECS write evidence;
 *   arbitrary extractors retain the conservative component/structure guard;
 * - the pose of each entity the extraction read (`readEnvironmentPose`), and
 *   whether that pose is interpolated (it then follows Time);
 * - World Time, when the result depends on it;
 * - asset content (`assetsChanged`) and the caller's view key;
 * - routed errors: an extraction that reported a failure reports it again.
 */
export class EnvironmentGate<T, M extends object = object> {
  private readonly extractions = new WeakMap<World, Extraction<T>>();
  private merged:
    | { readonly parts: readonly T[]; readonly key: string; readonly value: M }
    | undefined;
  /** Set by the owner before a frame: any asset content changed since the last frame. */
  assetsChanged = true;

  /** Only the stock extraction opts into its fully observed query route. */
  constructor(private readonly trackInputs = false) {}

  read(
    world: World,
    key: string,
    extract: (routedError: () => void) => { readonly value: T; readonly timeDependent: boolean },
  ): T {
    const previous = this.extractions.get(world);
    if (previous !== undefined && this.current(world, key, previous)) {
      observeNested(world, previous);
      return previous.value;
    }
    const epoch = readMutationEpoch(world);
    const structureEpoch = world.getStructureEpoch();
    const outer = observation;
    const inputs: InputReads | undefined = this.trackInputs
      ? {
          components: new Set([Transform, GlobalTransform, TransformInterpolation]),
          candidates: new Set(),
          globals: new Set(),
        }
      : undefined;
    const poses: EntityHandle[] = [];
    const current: Observation = { world, inputs, poses, volatile: false };
    observation = current;
    let result: { readonly value: T; readonly timeDependent: boolean };
    try {
      result = extract(() => {
        current.volatile = true;
      });
    } finally {
      observation = outer;
    }
    const inputsEqual =
      inputs !== undefined && previous?.inputs !== undefined && sameInputs(previous.inputs, inputs);
    const source =
      inputs === undefined
        ? undefined
        : inputsEqual
          ? previous?.source
          : createStateProjection(world, [...inputs.components], [...inputs.candidates]);
    const globals =
      inputs === undefined || inputs.globals.size === 0
        ? undefined
        : inputsEqual
          ? previous?.globals
          : createStateProjection(world, [...inputs.globals]);
    source?.read().accept();
    globals?.read().accept();
    const extraction: Extraction<T> = {
      value: result.value,
      structureEpoch,
      epoch,
      key,
      poses,
      volatile: current.volatile || result.timeDependent || readMutationEpoch(world) !== epoch,
      source,
      globals,
      inputs,
    };
    this.extractions.set(world, extraction);
    observeNested(world, extraction);
    return result.value;
  }

  /**
   * The frame entries merged from `worlds`' extractions; rebuilt only when one
   * World's extraction changed, the merge key changed, or the last merge
   * routed an error. A rebuilt entry equal to its predecessor keeps the
   * predecessor's identity, so a camera edit leaves the lights entry as it was.
   */
  merge(worlds: readonly World[], key: string, build: (routedError: () => void) => M): M {
    const merged = this.merged;
    let matched = merged !== undefined && merged.key === key;
    let count = 0;
    for (const world of worlds) {
      const extraction = this.extractions.get(world);
      if (extraction === undefined) continue;
      if (merged?.parts[count++] !== extraction.value) matched = false;
    }
    if (matched && count === merged?.parts.length) return merged.value;
    const parts: T[] = [];
    for (const world of worlds) {
      const extraction = this.extractions.get(world);
      if (extraction !== undefined) parts.push(extraction.value);
    }
    let routed = false;
    const built = build(() => {
      routed = true;
    });
    const value = merged === undefined ? built : retainEqualEntries(merged.value, built);
    this.merged = routed ? undefined : { parts, key, value };
    return value;
  }

  private current(world: World, key: string, previous: Extraction<T>): boolean {
    if (
      previous.volatile ||
      this.assetsChanged ||
      previous.key !== key ||
      (previous.source === undefined &&
        (world.getStructureEpoch() !== previous.structureEpoch ||
          readMutationEpochExcept(world, POSE) > previous.epoch))
    )
      return false;
    if (!projectionCurrent(previous.source) || !projectionCurrent(previous.globals)) return false;
    for (const entity of previous.poses) {
      if (world.hasComponent(entity, TransformInterpolation)) return false;
      for (const component of POSE)
        if (readEntityComponentEpoch(world, entity, component) > previous.epoch) return false;
    }
    return true;
  }
}

function retainEqualEntries<M extends object>(previous: M, next: M): M {
  const entries = next as Record<string, unknown>;
  const prior = previous as Record<string, unknown>;
  let retained: Record<string, unknown> | undefined;
  for (const key in entries) {
    const value = entries[key];
    if (value === prior[key] || !sameValue(value, prior[key])) continue;
    retained ??= { ...entries };
    retained[key] = prior[key];
  }
  return (retained ?? next) as M;
}

function projectionCurrent(source: StateProjection | undefined): boolean {
  if (source === undefined || source.isCurrent()) return true;
  const batch = source.read();
  if (batch.indices.length > 0) return false;
  batch.accept();
  return true;
}

function sameInputs(previous: InputReads, next: InputReads): boolean {
  for (const role of INPUT_SETS) {
    if (previous[role].size !== next[role].size) return false;
    for (const component of previous[role]) if (!next[role].has(component)) return false;
  }
  return true;
}
