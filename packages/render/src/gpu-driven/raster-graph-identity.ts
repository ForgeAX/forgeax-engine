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
}

/** One raster publication, with the original and stock-recorder dependency projections. */
export class RasterGraphIdentity {
  private current: Publication | undefined;

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
    const raw = new Set<string>(),
      recording = new Set<string>();
    for (const batch of batches) {
      raw.add(batch.classKey);
      recording.add(batch.recordingClassKey);
    }
    const rawClasses = [...raw].sort(),
      recordingClasses = [...recording].sort();
    const recordingIdentity =
      sameResources && sameBindings && same(old.recordingClasses, recordingClasses)
        ? old.recording
        : {};
    if (sameResources && same(old.rawClasses, rawClasses)) {
      old.source = source;
      old.recording = recordingIdentity;
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
    };
    return this.current;
  }

  clear(): void {
    this.current = undefined;
  }
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
