import type { GpuDrivenViewInspection } from './view-gpu';

type ViewResources = Pick<
  GpuDrivenViewInspection,
  'resourceGeneration' | 'candidateCapacity' | 'batchCapacity' | 'indirectCapacity'
>;
interface RasterClass {
  readonly classKey: string;
  readonly recordingClassKey: string;
}
interface Publication {
  source: object;
  readonly sceneIdentity: number;
  readonly resources: ViewResources;
  readonly rawClasses: readonly string[];
  readonly recordingClasses: readonly string[];
  rigidBindings: object;
  skinBindings: object | undefined;
  readonly raw: object;
  recording: object;
  /** Stock-recorder classes the last graph with this recording identity was built with. */
  builtRecording: ReadonlySet<string>;
}

/**
 * A stock-recorder graph keeps the projected classes it was built with; a
 * class whose last batch disappears needs no recompile while the graph still
 * holds it. Bound the absent classes a graph may retain.
 */
const MAX_ABSENT_RECORDING_CLASSES = 32;

/** One raster publication, with the original and stock-recorder dependency projections. */
export class RasterGraphIdentity {
  private current: Publication | undefined;
  /** Diagnostic counts of which input replaced the raw or recording identity. */
  readonly changes: Record<string, number> = {};
  private count(reason: string): void {
    this.changes[reason] = (this.changes[reason] ?? 0) + 1;
  }

  update(
    source: object,
    sceneIdentity: number,
    resources: ViewResources,
    batches: readonly RasterClass[],
    rigidBindings: object,
    skinBindings: object | undefined,
  ): Pick<Publication, 'raw' | 'recording'> {
    const old = this.current;
    const sameResources =
      old !== undefined &&
      old.sceneIdentity === sceneIdentity &&
      old.resources.resourceGeneration === resources.resourceGeneration &&
      old.resources.candidateCapacity === resources.candidateCapacity &&
      old.resources.batchCapacity === resources.batchCapacity &&
      old.resources.indirectCapacity === resources.indirectCapacity;
    const sameBindings = old?.rigidBindings === rigidBindings && old.skinBindings === skinBindings;
    if (sameResources && sameBindings && old.source === source) return old;
    if (old !== undefined) {
      if (old.sceneIdentity !== sceneIdentity) this.count('sceneIdentity');
      for (const field of [
        'resourceGeneration',
        'candidateCapacity',
        'batchCapacity',
        'indirectCapacity',
      ] as const)
        if (old.resources[field] !== resources[field]) this.count(field);
      if (old.rigidBindings !== rigidBindings) this.count('rigidBindings');
      if (old.skinBindings !== skinBindings) this.count('skinBindings');
    }
    const raw = new Set<string>(),
      recording = new Set<string>();
    for (const batch of batches) {
      raw.add(batch.classKey);
      recording.add(batch.recordingClassKey);
    }
    const rawClasses = [...raw].sort(),
      recordingClasses = [...recording].sort();
    const covered =
      old !== undefined &&
      recordingClasses.every((key) => old.builtRecording.has(key)) &&
      old.builtRecording.size - recordingClasses.length <= MAX_ABSENT_RECORDING_CLASSES;
    const recordingIdentity = sameResources && sameBindings && covered ? old.recording : {};
    if (old !== undefined && recordingIdentity !== old.recording && !covered)
      this.count('recordingClasses');
    const builtRecording =
      old !== undefined && recordingIdentity === old.recording
        ? old.builtRecording
        : new Set(recordingClasses);
    if (old !== undefined && !same(old.rawClasses, rawClasses)) this.count('rawClasses');
    if (sameResources && same(old.rawClasses, rawClasses)) {
      old.source = source;
      old.recording = recordingIdentity;
      old.builtRecording = builtRecording;
      old.rigidBindings = rigidBindings;
      old.skinBindings = skinBindings;
      return old;
    }
    this.current = {
      source,
      sceneIdentity,
      resources: {
        resourceGeneration: resources.resourceGeneration,
        candidateCapacity: resources.candidateCapacity,
        batchCapacity: resources.batchCapacity,
        indirectCapacity: resources.indirectCapacity,
      },
      rawClasses,
      recordingClasses,
      rigidBindings,
      skinBindings,
      raw: {},
      recording: recordingIdentity,
      builtRecording,
    };
    return this.current;
  }

  /**
   * Record the classes a stock-recorder graph was actually built with. A graph
   * rebuilt for another dependency holds only the then-live classes; a later
   * reappearing class must change the identity again.
   */
  built(recordingClasses: Iterable<string>): void {
    if (this.current !== undefined) this.current.builtRecording = new Set(recordingClasses);
  }

  clear(): void {
    this.current = undefined;
  }
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
