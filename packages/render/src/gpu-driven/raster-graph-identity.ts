interface RasterClass {
  readonly classKey: string;
  readonly recordingClassKey: string;
}
interface Publication {
  readonly sceneIdentity: number;
  readonly graphGeneration: number;
  readonly raw: object;
  readonly recording: object;
}

/** One raster publication, with the original and stock-recorder dependency projections. */
export class RasterGraphIdentity {
  private readonly sceneIdentities = new WeakMap<object, number>();
  private nextSceneIdentity = 1;
  sceneIdentity(scene: object): number {
    const existing = this.sceneIdentities.get(scene);
    if (existing !== undefined) return existing;
    const identity = this.nextSceneIdentity;
    this.nextSceneIdentity += 1;
    this.sceneIdentities.set(scene, identity);
    return identity;
  }
  private current: Publication | undefined;
  private readonly rawMembers = new Map<string, boolean>();
  private readonly recordingMembers = new Map<string, boolean>();
  private visit = false;
  /** Diagnostic counts of which input replaced the raw or recording identity. */
  readonly changes: Record<string, number> = {};
  private count(reason: string): void {
    this.changes[reason] = (this.changes[reason] ?? 0) + 1;
  }

  update(
    _source: object,
    sceneIdentity: number,
    graphGeneration: number,
    batches: readonly RasterClass[],
    _rigidBindings: object,
    _skinBindings: object | undefined,
  ): Pick<Publication, 'raw' | 'recording'> {
    const old = this.current;
    const sameGeneration =
      old !== undefined &&
      old.sceneIdentity === sceneIdentity &&
      old.graphGeneration === graphGeneration;
    const priorCount = this.rawMembers.size;
    this.visit = !this.visit;
    let seen = 0;
    let added = false;
    let late = false;
    let seenRecording = 0;
    if (!sameGeneration) this.recordingMembers.clear();
    for (const batch of batches) {
      const stamp = this.rawMembers.get(batch.classKey);
      if (stamp !== this.visit) {
        this.rawMembers.set(batch.classKey, this.visit);
        seen++;
        if (stamp === undefined) added = true;
      }
      const recording = this.recordingMembers.get(batch.recordingClassKey);
      if (recording !== this.visit) {
        this.recordingMembers.set(batch.recordingClassKey, this.visit);
        seenRecording++;
        if (recording === undefined) late = true;
      }
    }
    if (this.recordingMembers.size > seenRecording)
      this.recordingMembers.forEach((stamp, key) => {
        if (stamp !== this.visit) this.recordingMembers.delete(key);
      });
    const removed = this.rawMembers.size > seen;
    if (removed)
      this.rawMembers.forEach((stamp, key) => {
        if (stamp !== this.visit) this.rawMembers.delete(key);
      });
    if (old !== undefined) {
      if (old.sceneIdentity !== sceneIdentity) this.count('sceneIdentity');
      if (old.graphGeneration !== graphGeneration) this.count('resourceGeneration');
      if (late && sameGeneration) this.count('lateRecordingClasses');
      if (added || seen !== priorCount) this.count('rawClasses');
    }
    if (sameGeneration && !added && !removed) return old;
    const current = {
      sceneIdentity,
      graphGeneration,
      raw: {},
      recording: sameGeneration ? old.recording : {},
    };
    this.current = current;
    return current;
  }

  /** The authored graph initially projects its then-live classes. */
  built(recordingClasses: Iterable<string>): void {
    this.recordingMembers.clear();
    for (const key of recordingClasses) this.recordingMembers.set(key, this.visit);
  }

  clear(): void {
    this.current = undefined;
    this.rawMembers.clear();
    this.recordingMembers.clear();
  }
}
