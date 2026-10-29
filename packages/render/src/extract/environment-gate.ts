import type { EntityHandle, World } from '@forgeax/engine-ecs';
import {
  readEntityComponentEpoch,
  readMutationEpoch,
  readMutationEpochExcept,
} from '@forgeax/engine-ecs/projection';
import {
  GlobalTransform,
  readPresentationWorldMatrix,
  Transform,
  TransformInterpolation,
} from '@forgeax/engine-scene';
import { sameValue } from '../same-value';

/** Pose reads of the environment extraction running now; undefined outside one. */
let poseReads: EntityHandle[] | undefined;

/**
 * The presentation pose of an environment entity (camera, light, probe, decal,
 * sky). Every environment pose read goes through here, so the gate knows the
 * exact entities whose movement changes the environment.
 */
export function readEnvironmentPose(world: World, entity: EntityHandle) {
  poseReads?.push(entity);
  return readPresentationWorldMatrix(world, entity);
}

/** Note an environment entity whose propagated world transform was read directly. */
export function noteEnvironmentPose(entity: EntityHandle): void {
  poseReads?.push(entity);
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
}

/**
 * Change-driven environment extraction of source Worlds: a World's cameras,
 * lights, probes, sky, fog, decals and post-process parameters are extracted
 * again only when an explicit input changed, otherwise the previous result is
 * returned with its identities. The inputs are:
 *
 * - every component and the World structure, except pose components;
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

  read(
    world: World,
    key: string,
    extract: (routedError: () => void) => { readonly value: T; readonly timeDependent: boolean },
  ): T {
    const previous = this.extractions.get(world);
    if (previous !== undefined && this.current(world, key, previous)) return previous.value;
    const epoch = readMutationEpoch(world);
    const structureEpoch = world.getStructureEpoch();
    const outer = poseReads;
    const poses: EntityHandle[] = [];
    poseReads = poses;
    let routed = false;
    let result: { readonly value: T; readonly timeDependent: boolean };
    try {
      result = extract(() => {
        routed = true;
      });
    } finally {
      poseReads = outer;
    }
    this.extractions.set(world, {
      value: result.value,
      structureEpoch,
      epoch,
      key,
      poses,
      volatile: routed || result.timeDependent,
    });
    return result.value;
  }

  /**
   * The frame entries merged from `worlds`' extractions; rebuilt only when one
   * World's extraction changed, the merge key changed, or the last merge
   * routed an error. A rebuilt entry equal to its predecessor keeps the
   * predecessor's identity, so a camera edit leaves the lights entry as it was.
   */
  merge(worlds: readonly World[], key: string, build: (routedError: () => void) => M): M {
    const parts: T[] = [];
    for (const world of worlds) {
      const extraction = this.extractions.get(world);
      if (extraction !== undefined) parts.push(extraction.value);
    }
    const merged = this.merged;
    if (
      merged !== undefined &&
      merged.key === key &&
      merged.parts.length === parts.length &&
      merged.parts.every((part, index) => part === parts[index])
    )
      return merged.value;
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
      world.getStructureEpoch() !== previous.structureEpoch ||
      readMutationEpochExcept(world, POSE) > previous.epoch
    )
      return false;
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
