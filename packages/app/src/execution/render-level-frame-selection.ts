import type { FrameReceipt, PublishedRenderFrameInput } from '@forgeax/engine-render';
import type { ClosedLevelFrameSelectionReceipt } from './closed-level-row-protocol';
import type { RenderLevelDeviceWork } from './render-level-device-work';
import type { RenderWorkerInput } from './render-worker-protocol';
import { serializableDetail } from './worker-error';

type Draw = Extract<RenderWorkerInput, { kind: 'draw' }>;
type Selection = NonNullable<Draw['groupSelection']>;
type Outcome = ClosedLevelFrameSelectionReceipt['result'];
type Failure = Extract<Outcome, { ok: false }>;

const rejectedFrame = { ok: false, reason: 'frame' } as const;

/** The selected group and its acknowledgement belong to one accepted, presentable draw. */
export class RenderLevelFrameSelection {
  private undo: (() => void) | undefined;
  private rejection: Failure | undefined;

  constructor(
    private readonly message: Pick<Draw, 'frameId' | 'publication' | 'worldIdentity'>,
    private readonly selection: Selection,
    private readonly work: Pick<RenderLevelDeviceWork, 'select'> | undefined,
    private readonly reply: (receipt: ClosedLevelFrameSelectionReceipt) => void,
  ) {}

  readonly apply: NonNullable<PublishedRenderFrameInput['onPublicationAccepted']> = (accepted) => {
    const { id } = this.selection;
    if (
      this.message.worldIdentity !== id.worldIdentity ||
      accepted.source !== id.publication.source ||
      accepted.epoch !== id.publication.epoch ||
      accepted.revision !== this.message.publication.revision ||
      this.work === undefined
    ) {
      this.rejection = { ok: false, reason: 'identity' };
      return;
    }
    const selected = this.work.select(this.selection);
    if (selected.ok) this.undo = selected.value;
    else this.rejection = selected.error;
  };

  finish(receipt: FrameReceipt | undefined): void {
    if (this.rejection !== undefined) {
      this.report(this.rejection);
      return;
    }
    if (this.undo !== undefined && receipt?.presentation === 'ready') {
      this.reportOnCompletion(receipt.completed, { ok: true });
      return;
    }

    try {
      this.undo?.();
    } catch (cause) {
      this.report({ ...rejectedFrame, detail: serializableDetail(cause) });
      return;
    }
    const detail = receipt?.presentationPendingReason;
    if (this.undo === undefined || receipt?.preparationCompleted === undefined) {
      this.report({ ...rejectedFrame, detail });
      return;
    }
    // A preparation receipt can only request a new draw. Only that draw can confirm selection.
    this.reportOnCompletion(receipt.preparationCompleted, { ok: false, reason: 'pending', detail });
  }

  private reportOnCompletion(completed: FrameReceipt['completed'], outcome: Outcome): void {
    void completed.then(
      (result) =>
        this.report(
          result.ok ? outcome : { ...rejectedFrame, detail: serializableDetail(result.error) },
        ),
      (cause: unknown) => this.report({ ...rejectedFrame, detail: serializableDetail(cause) }),
    );
  }

  private report(result: Outcome): void {
    this.reply({
      kind: 'closed-level-selection-result',
      ...this.selection,
      frameId: this.message.frameId,
      revision: this.message.publication.revision,
      result,
    });
  }
}
