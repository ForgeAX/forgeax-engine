interface RasterClass {
  readonly classKey: string;
  readonly recordingClassKey: string;
}
interface Publication {
  source: object;
  readonly sceneIdentity: number;
  readonly graphGeneration: number;
  readonly rawClasses: readonly string[];
  readonly recordingClasses: readonly string[];
  rigidBindings: object;
  skinBindings: object | undefined;
  readonly raw: object;
  recording: object;
  /** Stock-recorder classes the last graph with this recording identity was built with. */
  builtRecording: ReadonlySet<string>;
}

function sameRawClasses(previous: Publication | undefined, classes: ReadonlySet<string>): boolean {
  return (
    previous !== undefined &&
    previous.rawClasses.length === classes.size &&
    previous.rawClasses.every((key) => classes.has(key))
  );
}

function coversRecordingClasses(
  previous: Publication | undefined,
  classes: ReadonlySet<string>,
): boolean {
  if (previous === undefined) return false;
  for (const key of classes) {
    if (!previous.builtRecording.has(key)) return false;
  }
  return true;
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
    graphGeneration: number,
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
      old.graphGeneration === graphGeneration;
    if (sameResources && old.source === source) {
      old.rigidBindings = rigidBindings;
      old.skinBindings = skinBindings;
      return old;
    }
    if (old !== undefined) {
      if (old.sceneIdentity !== sceneIdentity) this.count('sceneIdentity');
      if (old.graphGeneration !== graphGeneration) this.count('resourceGeneration');
    }
    const raw = new Set<string>(),
      recording = new Set<string>();
    for (const batch of batches) {
      raw.add(batch.classKey);
      recording.add(batch.recordingClassKey);
    }
    // Class sets are compared unsorted: the common frame republishes the same
    // classes, and only a replaced publication needs the sorted arrays.
    const sameRaw = sameRawClasses(old, raw);
    // A stock-recorder graph projects classes first seen after compilation
    // from the live frame (residency-owned meshes are bound outside the
    // graph), so its identity no longer depends on the class set. Count the
    // classes it had to admit late for diagnostics only.
    const covered = coversRecordingClasses(old, recording);
    const recordingIdentity = sameResources ? old.recording : {};
    if (old !== undefined && !covered) this.count('lateRecordingClasses');
    let recordingClasses: string[] | undefined;
    let builtRecording: ReadonlySet<string>;
    if (sameResources && covered) {
      builtRecording = old.builtRecording;
    } else {
      recordingClasses = [...recording].sort();
      builtRecording = sameResources
        ? new Set([...old.builtRecording, ...recordingClasses])
        : new Set(recordingClasses);
    }
    if (old !== undefined && !sameRaw) this.count('rawClasses');
    if (sameResources && sameRaw) {
      old.source = source;
      old.recording = recordingIdentity;
      old.builtRecording = builtRecording;
      old.rigidBindings = rigidBindings;
      old.skinBindings = skinBindings;
      return old;
    }
    const rawClasses = [...raw].sort();
    recordingClasses ??= [...recording].sort();
    this.current = {
      source,
      sceneIdentity,
      graphGeneration,
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
