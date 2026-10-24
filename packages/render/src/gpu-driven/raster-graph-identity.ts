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
    // Capacities and visible-window bindings are resolved when the graph
    // executes; only the view's pass-list generation shapes the graph.
    const sameResources =
      old !== undefined &&
      old.sceneIdentity === sceneIdentity &&
      old.resources.resourceGeneration === resources.resourceGeneration;
    if (sameResources && old.source === source) {
      old.rigidBindings = rigidBindings;
      old.skinBindings = skinBindings;
      return old;
    }
    if (old !== undefined) {
      if (old.sceneIdentity !== sceneIdentity) this.count('sceneIdentity');
      if (old.resources.resourceGeneration !== resources.resourceGeneration)
        this.count('resourceGeneration');
    }
    const raw = new Set<string>(),
      recording = new Set<string>();
    for (const batch of batches) {
      raw.add(batch.classKey);
      recording.add(batch.recordingClassKey);
    }
    const rawClasses = [...raw].sort(),
      recordingClasses = [...recording].sort();
    // A stock-recorder graph projects classes first seen after compilation
    // from the live frame (residency-owned meshes are bound outside the
    // graph), so its identity no longer depends on the class set. Count the
    // classes it had to admit late for diagnostics only.
    const covered =
      old !== undefined && recordingClasses.every((key) => old.builtRecording.has(key));
    const recordingIdentity = sameResources ? old.recording : {};
    if (old !== undefined && !covered) this.count('lateRecordingClasses');
    const builtRecording =
      old !== undefined && recordingIdentity === old.recording
        ? new Set([...old.builtRecording, ...recordingClasses])
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
