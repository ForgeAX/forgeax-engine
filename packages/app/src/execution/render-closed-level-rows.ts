import type { RenderPublicationIdentity } from '@forgeax/engine-render';
import {
  type ClosedLevelAssetHold,
  type ClosedLevelAssetPublication,
  collectPublicationDependencies,
  decodeClosedLevelRows,
  type RenderPublication,
  type RenderPublicationRows,
  sameClosedLevelRows,
} from '@forgeax/engine-render/internal';
import {
  CLOSED_LEVEL_ROWS_PER_CHUNK,
  type ClosedLevelRowIdentity,
  type ClosedLevelRowOperation,
  type ClosedLevelRowReceipt,
  type ClosedLevelRowRequest,
  sameClosedLevelRowIdentity,
} from './closed-level-row-protocol';
import { serializableDetail } from './worker-error';

type Rows = ReturnType<ReturnType<typeof decodeClosedLevelRows>['unwrap']>;
type Admission = ClosedLevelRowReceipt['result'];
const accepted = { ok: true } as const;
const reject = (reason: Extract<Admission, { ok: false }>['reason']): Admission => ({
  ok: false,
  reason,
});
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;

interface Stream {
  readonly id: ClosedLevelRowIdentity;
  readonly chunks: { readonly wire: RenderPublicationRows; readonly rows: Rows }[];
  readonly entities: Set<number>;
  readonly assets: Map<number, HeldAsset>;
  readonly assetOrder: number[];
  readonly requiredAssets: Set<number>;
  readonly requiredVersions: Map<number, number>;
  sealed: boolean;
}

interface HeldAsset {
  readonly version: number;
  readonly hold: ClosedLevelAssetHold;
}

/** Worker custody for decoded rows awaiting device preparation. */
export class RenderClosedLevelRows {
  private readonly streams = new Map<number, Stream>();
  private latestStream = 0;
  constructor(
    private readonly publication: RenderPublicationIdentity,
    private readonly worldIdentity: string,
    private readonly retainAsset: (
      asset: ClosedLevelAssetPublication,
    ) => ClosedLevelAssetHold | undefined,
    private readonly installPrograms?: (programs: RenderPublication['programs']) => void,
  ) {}

  receive({ id, serial, operation }: ClosedLevelRowRequest): ClosedLevelRowReceipt {
    return { kind: 'closed-level-rows-result', id, serial, result: this.apply(id, operation) };
  }

  private apply(id: ClosedLevelRowIdentity, operation: ClosedLevelRowOperation): Admission {
    if (!this.valid(id)) return reject('identity');
    if (operation.kind === 'prepare') return reject('sequence');
    const prior = this.streams.get(id.stream);
    if (prior !== undefined && !sameClosedLevelRowIdentity(id, prior.id)) return reject('identity');
    if (operation.kind === 'retire') {
      this.latestStream = Math.max(this.latestStream, id.stream);
      this.streams.delete(id.stream);
      if (prior !== undefined) this.releaseAssets(prior);
      return accepted;
    }
    if (prior !== undefined) return this.append(prior, operation);
    if (id.stream <= this.latestStream) return reject('closed');
    const stream: Stream = {
      id,
      chunks: [],
      entities: new Set(),
      assets: new Map(),
      assetOrder: [],
      requiredAssets: new Set(),
      requiredVersions: new Map(),
      sealed: false,
    };
    const result = this.append(stream, operation);
    if (result.ok) {
      this.latestStream = id.stream;
      this.streams.set(id.stream, stream);
    }
    return result;
  }

  private valid(id: ClosedLevelRowIdentity): boolean {
    const { level, publication } = id;
    return (
      publication.source === this.publication.source &&
      publication.epoch === this.publication.epoch &&
      id.worldIdentity === this.worldIdentity &&
      positive(id.stream) &&
      positive(level.instance) &&
      positive(level.generation) &&
      positive(level.request) &&
      positive(level.attempt)
    );
  }

  private append(
    stream: Stream,
    operation: Exclude<ClosedLevelRowOperation, { kind: 'prepare' | 'retire' }>,
  ): Admission {
    if (operation.kind === 'asset') return this.appendAsset(stream, operation);
    if (operation.kind === 'seal') return this.seal(stream, operation);
    const { ordinal, rows } = operation;
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > stream.chunks.length)
      return reject('sequence');
    const prior = stream.chunks[ordinal];
    if (prior !== undefined)
      return sameClosedLevelRows(prior.wire, rows) ? accepted : reject('conflict');
    if (stream.sealed) return reject('closed');
    if (
      rows.transformEntities.length === 0 ||
      rows.transformEntities.length > CLOSED_LEVEL_ROWS_PER_CHUNK
    )
      return reject('rows');
    const decoded = decodeClosedLevelRows(rows);
    if (!decoded.ok) return reject('rows');
    if (decoded.value.some(({ entityKey }) => stream.entities.has(entityKey)))
      return reject('conflict');
    const versions = this.observeMaterialVersions(stream, decoded.value);
    if (versions === undefined) return reject('conflict');
    for (const [handle, version] of versions) stream.requiredVersions.set(handle, version);
    for (const row of decoded.value) {
      stream.entities.add(row.entityKey);
      collectPublicationDependencies(row, stream.requiredAssets);
      for (const lod of row.lods ?? [])
        if (typeof lod.mesh === 'number') stream.requiredAssets.add(lod.mesh);
    }
    stream.chunks.push({ wire: rows, rows: decoded.value });
    return accepted;
  }

  private observeMaterialVersions(stream: Stream, rows: Rows): Map<number, number> | undefined {
    const versions = new Map<number, number>();
    for (const row of rows) {
      for (const material of [...row.materials, ...(row.materialOverrides ?? [])]) {
        const source = material?.snapshot.sourceAssets;
        if (source === undefined) continue;
        for (const { handle, revision } of source.assets) {
          const existing = versions.get(handle) ?? stream.requiredVersions.get(handle);
          if (existing !== undefined && existing !== revision) return undefined;
          versions.set(handle, revision);
        }
      }
    }
    return versions;
  }

  private seal(
    stream: Stream,
    operation: Extract<ClosedLevelRowOperation, { kind: 'seal' }>,
  ): Admission {
    if (
      operation.chunks !== stream.chunks.length ||
      operation.rows !== stream.entities.size ||
      operation.assets !== stream.assets.size
    )
      return reject('sequence');
    for (const handle of stream.requiredAssets)
      if (!stream.assets.has(handle)) return reject('assets');
    for (const [handle, revision] of stream.requiredVersions)
      if (stream.assets.get(handle)?.version !== revision) return reject('assets');
    if (!this.assetsCurrent(stream)) return reject('assets');
    if (operation.programs !== undefined) {
      if (this.installPrograms === undefined || !Array.isArray(operation.programs))
        return reject('assets');
      try {
        this.installPrograms(operation.programs);
      } catch (cause) {
        return { ok: false, reason: 'assets', detail: serializableDetail(cause) };
      }
    }
    stream.sealed = true;
    return accepted;
  }

  private assetsCurrent(stream: Stream): boolean {
    for (const { hold } of stream.assets.values()) if (!hold.isCurrent()) return false;
    return true;
  }

  private appendAsset(
    stream: Stream,
    operation: Extract<ClosedLevelRowOperation, { kind: 'asset' }>,
  ): Admission {
    const { ordinal, asset } = operation;
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > stream.assetOrder.length)
      return reject('sequence');
    const prior = stream.assetOrder[ordinal];
    if (prior !== undefined) {
      if (prior !== asset.handle || stream.assets.get(prior)?.version !== asset.revision)
        return reject('conflict');
      const repeated = this.retainAsset(asset);
      repeated?.release();
      return repeated === undefined ? reject('conflict') : accepted;
    }
    if (stream.sealed) return reject('closed');
    if (stream.assets.has(asset.handle)) return reject('conflict');
    const hold = this.retainAsset(asset);
    if (hold === undefined) return reject('assets');
    stream.assets.set(asset.handle, { version: asset.revision, hold });
    stream.assetOrder.push(asset.handle);
    return accepted;
  }

  private releaseAssets(stream: Stream): void {
    for (const { hold } of stream.assets.values()) hold.release();
    stream.assets.clear();
  }

  /** Device admission borrows the sealed chunks for this exact attempt. */
  borrowSealed(id: ClosedLevelRowIdentity):
    | {
        readonly chunks: readonly Rows[];
        readonly members: readonly number[];
        readonly assets: ReadonlyMap<number, HeldAsset>;
        rowsCurrent(): boolean;
        isCurrent(): boolean;
      }
    | undefined {
    const stream = this.streams.get(id.stream);
    if (stream === undefined || !stream.sealed || !sameClosedLevelRowIdentity(stream.id, id))
      return undefined;
    const rowsCurrent = () => this.streams.get(id.stream) === stream;
    return {
      chunks: stream.chunks.map(({ rows }) => rows),
      members: [...stream.entities],
      assets: stream.assets,
      rowsCurrent,
      isCurrent: () => rowsCurrent() && this.assetsCurrent(stream),
    };
  }

  discard(id: ClosedLevelRowIdentity): void {
    this.apply(id, { kind: 'retire' });
  }

  /** Release unconsumed row custody when the entire publication session ends. */
  dispose(): void {
    for (const stream of this.streams.values()) this.releaseAssets(stream);
    this.streams.clear();
  }
}
