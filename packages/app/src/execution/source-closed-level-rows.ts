import { RenderPublicationError } from '@forgeax/engine-render';
import {
  encodeClosedLevelRows,
  type PreparedMeshSource,
  type PublishedAssetVersion,
  publicationAssetPayloadTransfers,
} from '@forgeax/engine-render/internal';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type LevelRenderSelection,
  LevelViewObsoleteError,
} from '../levels/candidate-render-source';
import {
  CLOSED_LEVEL_ROWS_PER_CHUNK,
  type ClosedLevelAttempt,
  type ClosedLevelFrameSelection,
  type ClosedLevelFrameSelectionReceipt,
  type ClosedLevelRowIdentity,
  type ClosedLevelRowOperation,
  type ClosedLevelRowReceipt,
  type ClosedLevelRowRequest,
  sameClosedLevelRowIdentity,
} from './closed-level-row-protocol';

type Receipt = ClosedLevelRowReceipt['result'];
type Session = Pick<ClosedLevelRowIdentity, 'publication' | 'worldIdentity'> & {
  isCurrent(): boolean;
  post(message: ClosedLevelRowRequest, transfer?: ArrayBuffer[]): void;
};

export interface SealedLevelRows {
  readonly id: ClosedLevelRowIdentity;
  prepare(signal?: AbortSignal, current?: () => boolean): Promise<void>;
  select(active: boolean): Promise<LevelRenderSelection>;
  retire(): Promise<void>;
}

interface PendingSelection {
  readonly value: ClosedLevelFrameSelection;
  readonly current: () => boolean;
  readonly resolve: (selection: LevelRenderSelection) => void;
  readonly reject: (cause: unknown) => void;
}

interface SealedAssetVersions {
  readonly id: ClosedLevelRowIdentity;
  readonly versions: ReadonlyMap<number, number>;
}

const closed = { ok: false, reason: 'closed' } as const;
const unavailable = (subject: string) =>
  new RenderPublicationError({ reason: 'disposed', subject });

/** Only one stream sends chunks at a time; none uses an ordinary frame credit. */
export class SourceClosedLevelRows {
  private stream = 0;
  private serial = 0;
  private sending = false;
  private readonly pending = new Map<
    number,
    { readonly id: ClosedLevelRowIdentity; finish(result: Receipt): void }
  >();

  private readonly unsentSelections = new Map<number, PendingSelection>();
  private readonly sentSelections = new Map<
    number,
    { readonly selection: PendingSelection; readonly revision: number }
  >();
  // Sender hints contain only versions acknowledged by the receiving owner.
  private readonly sealedAssets = new Map<number, SealedAssetVersions>();

  constructor(private readonly session: () => Session | undefined) {}

  async stage(
    level: ClosedLevelAttempt,
    input: Pick<PreparedMeshSource, 'renderables' | 'dispatch' | 'isCurrent'>,
    options?: { readonly signal?: AbortSignal; readonly assets?: Iterable<PublishedAssetVersion> },
  ): Promise<Result<SealedLevelRows, RenderPublicationError>> {
    const signal = options?.signal;
    const session = this.session();
    if (this.sending || session === undefined || signal?.aborted)
      return err(unavailable('closed Level row stream unavailable'));
    const id = {
      publication: session.publication,
      worldIdentity: session.worldIdentity,
      stream: ++this.stream,
      level,
    };
    let retirement: Promise<void> | undefined;
    const retire = () => (retirement ??= this.retire(session, id));
    this.sending = true;
    try {
      const assets = await this.sendAssets(session, id, input.isCurrent, options?.assets, signal);
      let ordinal = 0;
      for (const rows of encodeClosedLevelRows(input, CLOSED_LEVEL_ROWS_PER_CHUNK)) {
        const transfer = [
          rows.upserts.buffer,
          rows.transformEntities.buffer,
          rows.transforms.buffer,
        ];
        const result = await this.request(
          session,
          id,
          { kind: 'stage', ordinal, rows },
          transfer,
          signal,
        );
        this.confirm(result, 'chunk');
        ordinal++;
      }
      const sealed = await this.request(
        session,
        id,
        {
          kind: 'seal',
          assets: assets.size,
          chunks: ordinal,
          rows: input.renderables.length,
        },
        undefined,
        signal,
      );
      this.confirm(sealed, 'seal');
      if (!session.isCurrent() || !input.isCurrent() || signal?.aborted)
        throw unavailable('closed Level source changed before seal returned');
      this.sealedAssets.set(id.stream, { id, versions: assets });
      return ok({
        id,
        prepare: async (signal, current = input.isCurrent) => {
          if (retirement !== undefined || !current())
            throw unavailable('closed Level source changed before native preparation');
          this.confirm(
            await this.request(session, id, { kind: 'prepare' }, undefined, signal),
            'prepare',
          );
          if (!current()) throw unavailable('closed Level source changed before native ready');
        },
        select: (active) =>
          retirement === undefined
            ? this.select(session, { id, active })
            : Promise.reject(unavailable('closed Level stream retired')),
        retire,
      });
    } catch (cause) {
      try {
        await retire();
      } catch (retirement) {
        return err(
          Object.assign(unavailable('closed Level row custody remains unconfirmed'), {
            cause: new AggregateError([cause, retirement]),
          }),
        );
      }
      return err(
        cause instanceof RenderPublicationError
          ? cause
          : Object.assign(
              new RenderPublicationError({
                reason: 'shape',
                subject: 'closed Level source capture',
              }),
              { cause },
            ),
      );
    } finally {
      this.sending = false;
    }
  }

  private select(
    session: Session,
    selection: ClosedLevelFrameSelection,
  ): Promise<LevelRenderSelection> {
    if (!session.isCurrent())
      return Promise.reject(unavailable('closed Level frame session ended'));
    if (
      this.unsentSelections.has(selection.id.stream) ||
      [...this.sentSelections.values()].some(
        (sent) => sent.selection.value.id.stream === selection.id.stream,
      )
    )
      return Promise.reject(
        new RenderPublicationError({ reason: 'in-flight', subject: 'Level selection' }),
      );
    return new Promise((resolve, reject) => {
      this.unsentSelections.set(selection.id.stream, {
        value: selection,
        current: session.isCurrent,
        resolve,
        reject,
      });
    });
  }

  takeSelection(frameId: number, revision: number): ClosedLevelFrameSelection | undefined {
    for (const [stream, selection] of this.unsentSelections) {
      this.unsentSelections.delete(stream);
      if (!selection.current()) {
        selection.reject(unavailable('closed Level frame session ended'));
        continue;
      }
      this.sentSelections.set(frameId, { selection, revision });
      return selection.value;
    }
    return undefined;
  }

  receiveSelection(receipt: ClosedLevelFrameSelectionReceipt): void {
    const sent = this.sentSelections.get(receipt.frameId);
    if (sent === undefined || receipt.revision !== sent.revision) return;
    const { selection } = sent;
    if (
      selection.value.active !== receipt.active ||
      !sameClosedLevelRowIdentity(selection.value.id, receipt.id)
    )
      return;
    this.sentSelections.delete(receipt.frameId);
    if (!selection.current()) selection.reject(unavailable('closed Level frame session ended'));
    else if (receipt.result.ok)
      selection.resolve(
        Object.freeze({
          active: receipt.active,
          frameId: receipt.frameId,
          revision: receipt.revision,
        }),
      );
    else {
      const { reason, detail } = receipt.result;
      if (reason === 'pending') {
        this.unsentSelections.set(selection.value.id.stream, selection);
        return;
      }
      if (reason === 'view-obsolete') {
        selection.reject(new LevelViewObsoleteError(detail));
        return;
      }
      selection.reject(
        Object.assign(
          new RenderPublicationError({
            reason: reason === 'identity' ? 'identity' : reason === 'closed' ? 'disposed' : 'shape',
            subject: `closed Level frame selection: ${reason}`,
          }),
          { cause: detail },
        ),
      );
    }
  }

  failSelection(frameId: number, cause: unknown): void {
    const sent = this.sentSelections.get(frameId);
    if (sent === undefined) return;
    this.sentSelections.delete(frameId);
    sent.selection.reject(cause);
  }

  private async sendAssets(
    session: Session,
    id: ClosedLevelRowIdentity,
    isCurrent: () => boolean,
    assets: Iterable<PublishedAssetVersion> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ReadonlyMap<number, number>> {
    const versions = new Map<number, number>();
    const current = () => session.isCurrent() && isCurrent() && signal?.aborted !== true;
    for (const asset of assets ?? []) {
      if (!current()) throw unavailable('closed Level asset source changed');
      await this.sendAsset(session, id, versions.size, asset, current, signal);
      versions.set(asset.handle, asset.revision);
    }
    return versions;
  }

  private mayRetain(
    id: ClosedLevelRowIdentity,
    { handle, revision }: PublishedAssetVersion,
  ): boolean {
    for (const entry of this.sealedAssets.values())
      if (
        entry.id.publication.source === id.publication.source &&
        entry.id.publication.epoch === id.publication.epoch &&
        entry.id.worldIdentity === id.worldIdentity &&
        entry.versions.get(handle) === revision
      )
        return true;
    return false;
  }

  private async sendAsset(
    session: Session,
    id: ClosedLevelRowIdentity,
    ordinal: number,
    asset: PublishedAssetVersion,
    current: () => boolean,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (this.mayRetain(id, asset)) {
      const version = { handle: asset.handle, revision: asset.revision };
      const retained = await this.request(
        session,
        id,
        { kind: 'asset', ordinal, asset: version },
        undefined,
        signal,
      );
      if (retained.ok || retained.reason !== 'assets') {
        this.confirm(retained, 'asset');
        return;
      }
    }
    if (!current()) throw unavailable('closed Level asset source changed');
    const owned = structuredClone(asset);
    this.confirm(
      await this.request(
        session,
        id,
        { kind: 'asset', ordinal, asset: owned },
        publicationAssetPayloadTransfers(owned.value),
        signal,
      ),
      'asset',
    );
  }

  private async retire(session: Session, id: ClosedLevelRowIdentity): Promise<void> {
    this.sealedAssets.delete(id.stream);
    const queued = this.unsentSelections.get(id.stream);
    if (queued !== undefined) {
      this.unsentSelections.delete(id.stream);
      queued.reject(unavailable('closed Level stream retired'));
    }
    for (const [frameId, sent] of this.sentSelections)
      if (sameClosedLevelRowIdentity(sent.selection.value.id, id))
        this.failSelection(frameId, unavailable('closed Level stream retired'));
    if (session.isCurrent()) {
      const result = await this.request(session, id, { kind: 'retire' });
      // No first chunk was admitted when the stream never started.
      if (!result.ok && result.reason !== 'closed' && result.reason !== 'sequence')
        this.confirm(result, 'retire');
    }
  }

  private confirm(result: Receipt, phase: 'asset' | 'chunk' | 'seal' | 'prepare' | 'retire'): void {
    if (result.ok) return;
    throw Object.assign(
      new RenderPublicationError({
        reason:
          result.reason === 'identity'
            ? 'identity'
            : result.reason === 'closed'
              ? 'disposed'
              : 'shape',
        subject: `closed Level row ${phase}: ${result.reason}`,
      }),
      { cause: result.detail },
    );
  }

  private request(
    session: Session,
    id: ClosedLevelRowIdentity,
    operation: ClosedLevelRowOperation,
    transfer?: ArrayBuffer[],
    signal?: AbortSignal,
  ): Promise<Receipt> {
    if (signal?.aborted || !session.isCurrent()) return Promise.resolve(closed);
    const serial = ++this.serial;
    return new Promise((resolve, reject) => {
      const abort = () => finish(closed);
      const remove = () => {
        this.pending.delete(serial);
        signal?.removeEventListener('abort', abort);
      };
      const finish = (result: Receipt) => {
        remove();
        resolve(result);
      };
      this.pending.set(serial, { id, finish });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        session.post({ kind: 'closed-level-rows', id, serial, operation }, transfer);
      } catch (cause) {
        remove();
        reject(cause);
      }
    });
  }

  receive(receipt: ClosedLevelRowReceipt): void {
    const pending = this.pending.get(receipt.serial);
    if (pending !== undefined && sameClosedLevelRowIdentity(pending.id, receipt.id))
      pending.finish(receipt.result);
  }

  invalidate(): void {
    this.sealedAssets.clear();
    for (const { finish } of this.pending.values()) finish(closed);
    const failure = unavailable('closed Level frame session ended');
    for (const selection of this.unsentSelections.values()) selection.reject(failure);
    this.unsentSelections.clear();
    for (const [frameId] of this.sentSelections) this.failSelection(frameId, failure);
  }
}
