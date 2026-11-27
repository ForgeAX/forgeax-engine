import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { RenderPublicationError } from '@forgeax/engine-render';
import {
  type ClosedLevelAssetPayload,
  captureLevelMaterialPrograms,
  encodeClosedLevelRows,
  type PreparedMeshSource,
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
  type ClosedLevelFrameChanges,
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
  readonly batch: symbol | undefined;
  readonly current: () => boolean;
  readonly resolve: (selection: LevelRenderSelection) => void;
  readonly reject: (cause: unknown) => void;
}

interface SentSelections {
  readonly selections: Map<number, PendingSelection>;
  readonly replies: Map<number, ClosedLevelFrameSelectionReceipt>;
  readonly revision: number;
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
  private readonly acknowledgedPrograms = new Set<string>();
  private selectionBatch: symbol | undefined;
  private readonly pending = new Map<
    number,
    { readonly id: ClosedLevelRowIdentity; finish(result: Receipt): void }
  >();

  private readonly unsentSelections = new Map<number, PendingSelection>();
  private readonly sentSelections = new Map<number, SentSelections>();
  // Sender hints contain only versions acknowledged by the receiving owner.
  private readonly sealedAssets = new Map<number, SealedAssetVersions>();

  constructor(
    private readonly session: () => Session | undefined,
    private readonly registry?: () => AssetRegistry,
  ) {}

  async stage(
    level: ClosedLevelAttempt,
    input: Pick<PreparedMeshSource, 'renderables' | 'dispatch' | 'isCurrent'>,
    options?: {
      readonly signal?: AbortSignal;
      readonly assets?: Iterable<ClosedLevelAssetPayload>;
    },
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
      if (!session.isCurrent() || !input.isCurrent() || signal?.aborted)
        throw unavailable('closed Level source changed before seal');
      const programs =
        this.registry === undefined
          ? []
          : captureLevelMaterialPrograms(this.registry(), input.renderables, (key) =>
              this.acknowledgedPrograms.has(key),
            );
      const sealed = await this.request(
        session,
        id,
        {
          kind: 'seal',
          assets: assets.size,
          chunks: ordinal,
          rows: input.renderables.length,
          ...(programs.length === 0 ? {} : { programs }),
        },
        undefined,
        signal,
      );
      this.confirm(sealed, 'seal');
      if (!session.isCurrent() || !input.isCurrent() || signal?.aborted)
        throw unavailable('closed Level source changed before seal returned');
      for (const { key } of programs) this.acknowledgedPrograms.add(key);
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

  batchSelections(apply: () => void): void {
    if (this.selectionBatch !== undefined) throw Error('nested Level selection exchange');
    const batch = Symbol();
    this.selectionBatch = batch;
    try {
      apply();
    } catch (cause) {
      for (const [stream, selection] of this.unsentSelections) {
        if (selection.batch !== batch) continue;
        this.unsentSelections.delete(stream);
        selection.reject(cause);
      }
      throw cause;
    } finally {
      this.selectionBatch = undefined;
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
      [...this.sentSelections.values()].some((sent) => sent.selections.has(selection.id.stream))
    )
      return Promise.reject(
        new RenderPublicationError({ reason: 'in-flight', subject: 'Level selection' }),
      );
    return new Promise((resolve, reject) => {
      this.unsentSelections.set(selection.id.stream, {
        value: selection,
        batch: this.selectionBatch,
        current: session.isCurrent,
        resolve,
        reject,
      });
    });
  }

  takeSelection(frameId: number, revision: number): ClosedLevelFrameChanges | undefined {
    const first = this.unsentSelections.values().next().value;
    if (first === undefined) return undefined;
    const selections = new Map([[first.value.id.stream, first]]);
    this.unsentSelections.delete(first.value.id.stream);
    if (first.batch !== undefined) {
      for (const [stream, candidate] of this.unsentSelections) {
        if (candidate.batch !== first.batch) continue;
        selections.set(stream, candidate);
        this.unsentSelections.delete(stream);
      }
    }
    if ([...selections.values()].some((selection) => !selection.current())) {
      for (const selection of selections.values())
        selection.reject(unavailable('closed Level frame session ended'));
      return undefined;
    }
    this.sentSelections.set(frameId, { selections, replies: new Map(), revision });
    const changes = [...selections.values()].map(({ value }) => value);
    return changes.length === 1 ? changes[0] : { changes };
  }

  receiveSelection(receipt: ClosedLevelFrameSelectionReceipt): void {
    const sent = this.sentSelections.get(receipt.frameId);
    if (sent === undefined || receipt.revision !== sent.revision) return;
    const stream = receipt.id.stream;
    const selection = sent.selections.get(stream);
    if (
      selection === undefined ||
      selection.value.active !== receipt.active ||
      !sameClosedLevelRowIdentity(selection.value.id, receipt.id)
    )
      return;
    sent.replies.set(stream, receipt);
    if (sent.replies.size !== sent.selections.size) return;
    this.sentSelections.delete(receipt.frameId);
    const refused = [...sent.replies.values()].find((reply) => !reply.result.ok)?.result;
    for (const [key, item] of sent.selections) {
      const reply = sent.replies.get(key);
      if (reply !== undefined)
        this.finishSelection(
          item,
          refused === undefined
            ? reply
            : {
                ...reply,
                result: refused,
              },
        );
    }
  }

  private finishSelection(
    selection: PendingSelection,
    receipt: ClosedLevelFrameSelectionReceipt,
  ): void {
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
    for (const selection of sent.selections.values()) selection.reject(cause);
  }

  private async sendAssets(
    session: Session,
    id: ClosedLevelRowIdentity,
    isCurrent: () => boolean,
    assets: Iterable<ClosedLevelAssetPayload> | undefined,
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
    { handle, revision }: ClosedLevelAssetPayload,
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
    asset: ClosedLevelAssetPayload,
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
      if (sent.selections.has(id.stream))
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
    this.acknowledgedPrograms.clear();
    for (const { finish } of this.pending.values()) finish(closed);
    const failure = unavailable('closed Level frame session ended');
    for (const selection of this.unsentSelections.values()) selection.reject(failure);
    this.unsentSelections.clear();
    for (const [frameId] of this.sentSelections) this.failSelection(frameId, failure);
  }
}
