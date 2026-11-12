import type { GpuScene } from '../gpu-scene';
import type { GpuSceneChangedBounds, SceneContentCursor } from '../gpu-scene-content-boxes';
import type { SubmissionPlan } from './batch-topology';

type Compare<Counters> = (
  previous: SubmissionPlan,
  next: SubmissionPlan,
  out: Set<number>,
  counters?: Counters,
) => void;

type BoundsRecord = {
  readonly scene: GpuScene;
  readonly since: SceneContentCursor;
  readonly current: SceneContentCursor;
  readonly bounds: GpuSceneChangedBounds;
};

/**
 * Sealed plans draw fixed content, so the primitives whose drawn content
 * differs between two plans are a fact of the pair. Shadow views that retain
 * the same plan and select the same next plan share one comparison, and the
 * boxes one change set occupied since a retained cursor are read once per
 * scene sync: a sync always publishes a new cursor object.
 */
export class ShadowPlanChanges<Counters> {
  private changed = new WeakMap<SubmissionPlan, WeakMap<SubmissionPlan, ReadonlySet<number>>>();
  private bounds = new WeakMap<ReadonlySet<number>, BoundsRecord>();

  constructor(private readonly compare: Compare<Counters>) {}

  /** The changed primitives between two plans; the returned set is never mutated. */
  between(
    previous: SubmissionPlan,
    next: SubmissionPlan,
    counters?: Counters,
  ): ReadonlySet<number> {
    let byNext = this.changed.get(previous);
    const known = byNext?.get(next);
    if (known !== undefined) return known;
    const changed = new Set<number>();
    this.compare(previous, next, changed, counters);
    if (byNext === undefined) {
      byNext = new WeakMap();
      this.changed.set(previous, byNext);
    }
    byNext.set(next, changed);
    return changed;
  }

  /** {@link GpuScene.slotBoundsSince} for a set returned by {@link between}. */
  boundsSince(
    scene: GpuScene,
    since: SceneContentCursor,
    slots: ReadonlySet<number>,
  ): GpuSceneChangedBounds {
    const current = scene.contentCursor;
    const known = this.bounds.get(slots);
    if (
      known !== undefined &&
      known.scene === scene &&
      known.since === since &&
      known.current === current
    )
      return known.bounds;
    const bounds = scene.slotBoundsSince(since, slots);
    this.bounds.set(slots, { scene, since, current, bounds });
    return bounds;
  }

  clear(): void {
    this.changed = new WeakMap();
    this.bounds = new WeakMap();
  }
}
