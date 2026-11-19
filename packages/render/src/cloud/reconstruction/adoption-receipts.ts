import type { FrameReceipt } from '../../render-contract';
import type { CloudCompletedAdoption } from '../inspection';
import type { CloudRecordedAdoption } from './adoption';

interface RecordedFrame {
  readonly frameNumber: number;
  readonly views: Map<string, CloudRecordedAdoption>;
}

interface ReadyGeneration {
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
  current: ReadonlyMap<string, CloudRecordedAdoption>;
  completed?: {
    readonly frameId: number;
    readonly views: ReadonlyMap<string, CloudCompletedAdoption>;
  };
}

/** Pairs the cloud producer's accepted physical work with the Renderer receipt for that submit. */
export class CloudAdoptionReceipts {
  private recorded: RecordedFrame | undefined;
  private ready: ReadyGeneration | undefined;

  constructor(private readonly isCurrent: (deviceGeneration: number) => boolean) {}

  record(frameNumber: number, view: string, adoption: CloudRecordedAdoption): void {
    if (this.recorded?.frameNumber !== frameNumber)
      this.recorded = { frameNumber, views: new Map() };
    this.recorded.views.set(view, adoption);
  }

  discard(): void {
    this.recorded = undefined;
  }

  reset(): void {
    this.discard();
    this.ready = undefined;
  }

  observe(frameNumber: number | undefined, accepted: boolean, receipt: FrameReceipt): void {
    const recorded = this.recorded;
    this.discard();
    if (!accepted) return;
    const { deviceGeneration, graphGeneration } = receipt;
    // A replacement graph revokes the old epoch even if it cannot yet present.
    if (
      this.ready?.deviceGeneration !== deviceGeneration ||
      this.ready?.graphGeneration !== graphGeneration
    )
      this.ready = undefined;
    if (receipt.presentation !== 'ready' || graphGeneration === undefined) return;
    const views = recorded?.frameNumber === frameNumber ? recorded?.views : undefined;
    if (views === undefined) {
      // A ready frame that did not use this cloud producer cannot inherit its result.
      this.ready = undefined;
      return;
    }
    this.ready ??= { deviceGeneration, graphGeneration, current: views };
    const ready = this.ready;
    ready.current = views;
    void receipt.completed.then((completion) => {
      if (
        !completion.ok ||
        !this.isCurrent(deviceGeneration) ||
        this.ready !== ready ||
        (ready.completed?.frameId ?? -1) >= receipt.frameId
      )
        return;
      const completedViews = new Map<string, CloudCompletedAdoption>();
      for (const [view, adoption] of views)
        completedViews.set(
          view,
          Object.freeze({
            ...adoption,
            frameId: receipt.frameId,
            deviceGeneration,
            graphGeneration,
          }),
        );
      ready.completed = { frameId: receipt.frameId, views: completedViews };
    });
  }

  read(view: string, deviceGeneration: number): CloudCompletedAdoption | undefined {
    if (!this.isCurrent(deviceGeneration) || this.ready?.deviceGeneration !== deviceGeneration)
      return undefined;
    const current = this.ready.current.get(view);
    const completed = this.ready.completed?.views.get(view);
    return current !== undefined &&
      completed?.worldIdentity === current.worldIdentity &&
      completed.entity === current.entity
      ? completed
      : undefined;
  }
}
