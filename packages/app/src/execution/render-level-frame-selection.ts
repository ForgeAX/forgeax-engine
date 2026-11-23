import type { FrameReceipt, PublishedRenderFrameInput } from '@forgeax/engine-render';
import type { ClosedLevelFrameSelectionReceipt } from './closed-level-row-protocol';
import type { RenderLevelDeviceWork } from './render-level-device-work';
import type { RenderWorkerInput } from './render-worker-protocol';
import { serializableDetail } from './worker-error';

type Draw = Extract<RenderWorkerInput, { kind: 'draw' }>;
type Selection = NonNullable<Draw['groupSelection']>;
type Change = Omit<ClosedLevelFrameSelectionReceipt, 'kind' | 'frameId' | 'revision' | 'result'>;
type Outcome = ClosedLevelFrameSelectionReceipt['result'];
type Failure = Extract<Outcome, { ok: false }>;

const rejectedFrame = { ok: false, reason: 'frame' } as const;

/** The selected group and its acknowledgement belong to one accepted, presentable draw. */
export class RenderLevelFrameSelection {
  private readonly undo: (() => void)[] = [];
  private readonly changes: readonly Change[];
  private rejection: Failure | undefined;

  constructor(
    private readonly message: Pick<Draw, 'frameId' | 'publication' | 'worldIdentity'>,
    selection: Selection,
    private readonly work: Pick<RenderLevelDeviceWork, 'select'> | undefined,
    private readonly reply: (receipt: ClosedLevelFrameSelectionReceipt) => void,
  ) {
    this.changes = 'changes' in selection ? selection.changes : [selection];
  }

  readonly apply: NonNullable<PublishedRenderFrameInput['onPublicationAccepted']> = (accepted) => {
    for (const selection of this.changes) {
      const { id } = selection;
      if (
        this.message.worldIdentity !== id.worldIdentity ||
        accepted.source !== id.publication.source ||
        accepted.epoch !== id.publication.epoch ||
        accepted.revision !== this.message.publication.revision ||
        this.work === undefined
      ) {
        this.refuse({ ok: false, reason: 'identity' });
        return;
      }
      const selected = this.work.select(selection);
      if (!selected.ok) {
        this.refuse(selected.error);
        return;
      }
      this.undo.push(selected.value);
    }
  };

  private rollback(): void {
    const failures: unknown[] = [];
    for (const undo of this.undo.reverse()) {
      try {
        undo();
      } catch (cause) {
        failures.push(cause);
      }
    }
    this.undo.length = 0;
    if (failures.length > 0) throw new AggregateError(failures, 'Level selection rollback failed');
  }

  private refuse(rejection: Failure): void {
    this.rejection = rejection;
    try {
      this.rollback();
    } catch (cause) {
      this.rejection = { ...rejectedFrame, detail: serializableDetail(cause) };
      throw cause;
    }
  }

  finish(receipt: FrameReceipt | undefined): void {
    if (this.rejection !== undefined) {
      this.report(this.rejection);
      return;
    }
    const applied = this.undo.length > 0;
    if (applied && receipt?.presentation === 'ready') {
      this.reportOnCompletion(receipt.completed, { ok: true });
      return;
    }

    try {
      this.rollback();
    } catch (cause) {
      this.report({ ...rejectedFrame, detail: serializableDetail(cause) });
      return;
    }
    const detail = receipt?.presentationPendingReason;
    if (!applied || receipt?.preparationCompleted === undefined) {
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
    for (const change of this.changes)
      this.reply({
        kind: 'closed-level-selection-result',
        ...change,
        frameId: this.message.frameId,
        revision: this.message.publication.revision,
        result,
      });
  }
}
