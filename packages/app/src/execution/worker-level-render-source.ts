import type { AssetContentLease } from '@forgeax/engine-assets-runtime/internal';
import {
  LocalMeshSource,
  type PreparedMeshSource,
  type PublishedAssetVersion,
  type prepareExtractContext,
  publicationDependencies,
  type SourceViewPreparation,
  StagedMeshSourceError,
  type StagedMeshSourceStatus,
} from '@forgeax/engine-render/internal';
import type { SceneRosterObservation } from '@forgeax/engine-scene/internal';
import { type Asset, err, ok, type Result } from '@forgeax/engine-types';
import type {
  CandidateRenderSource,
  LevelRenderSelection,
} from '../levels/candidate-render-source';
import type { ClosedLevelAttempt } from './closed-level-row-protocol';
import type { SealedLevelRows, SourceClosedLevelRows } from './source-closed-level-rows';

/** The Engine Worker owns ECS observations and the fixed source asset lease. */
export class WorkerLevelRenderSource implements CandidateRenderSource {
  private readonly staged: LocalMeshSource;
  private readonly abort = new AbortController();
  private readonly work: Generator<void>;
  private phase: StagedMeshSourceStatus['phase'] = 'extracting';
  private rows: SealedLevelRows | undefined;
  private pending: Promise<void> | undefined;
  private failure: StagedMeshSourceError | undefined;
  private retirementFailure: StagedMeshSourceError | undefined;
  private rasterRows = 0;

  constructor(
    observation: SceneRosterObservation,
    context: () => ReturnType<typeof prepareExtractContext>,
    private readonly content: AssetContentLease,
    private readonly transport: SourceClosedLevelRows,
    private readonly id: ClosedLevelAttempt,
    private readonly current: () => boolean,
    private readonly release: () => void,
  ) {
    this.staged = new LocalMeshSource(observation, context);
    this.work = this.prepare();
  }

  get hasRasterRows(): boolean {
    return this.rasterRows > 0;
  }

  private *prepare(): Generator<void> {
    const prepared = (yield* this.staged.extract(() => this.isCurrent())).unwrap();
    const handles = yield* fixedAssets(prepared);
    this.rasterRows = prepared.renderables.length;
    if (this.rasterRows === 0) {
      this.phase = 'resident-input';
      return;
    }
    const lease = this.content;
    function* versions(): Generator<PublishedAssetVersion> {
      for (const handle of handles)
        yield {
          handle,
          revision: lease.version(handle).unwrap(),
          value: lease.read<Asset>(handle).unwrap(),
        };
    }
    this.phase = 'admitting';
    this.awaitWork(
      this.transport
        .stage(this.id, prepared, { signal: this.abort.signal, assets: versions() })
        .then((result) => {
          this.rows = result.unwrap();
          if (!this.abort.signal.aborted) this.phase = 'resident-input';
        }),
    );
  }

  private awaitWork(work: Promise<void>, retiring = false): void {
    this.pending = work.then(
      () => {
        this.pending = undefined;
      },
      (cause) => {
        this.pending = undefined;
        const failure = new StagedMeshSourceError({ reason: 'source' }, cause);
        if (retiring || (cause instanceof Error && cause.cause instanceof AggregateError))
          this.retirementFailure = failure;
        else this.failure = failure;
      },
    );
  }

  prepareViews(current: () => boolean): SourceViewPreparation {
    const rows = this.rows;
    if (rows === undefined) throw new StagedMeshSourceError({ reason: 'source' });
    const requestNative = () =>
      rows.prepare(controller.signal, current).then(() => {
        ready = true;
      });
    const controller = new AbortController();
    let ready = false;
    function* prepare() {
      yield requestNative();
    }
    return Object.assign(prepare(), {
      isCurrent: () => ready && !controller.signal.aborted && current(),
      isObsolete: () => false,
      retire: () => {
        controller.abort();
        return Promise.resolve(ok(undefined));
      },
    });
  }

  inspect(): StagedMeshSourceStatus {
    return {
      phase: this.phase,
      members: this.staged.members.length,
      admitted: this.phase === 'resident-input' ? this.rasterRows : 0,
      reserved: 0,
      pending: this.pending,
    };
  }

  isCurrent(): boolean {
    return (
      !this.abort.signal.aborted &&
      this.current() &&
      this.staged.isCurrent() &&
      this.content.matchesCurrent()
    );
  }

  step(): Result<StagedMeshSourceStatus, StagedMeshSourceError> {
    if (this.failure !== undefined) return err(this.failure);
    try {
      if (!this.isCurrent()) throw new StagedMeshSourceError({ reason: 'source' });
      if (this.phase === 'extracting') this.work.next();
      return ok(this.inspect());
    } catch (cause) {
      this.phase = 'failed';
      return err(new StagedMeshSourceError({ reason: 'source' }, cause));
    }
  }

  acceptSource(next: SceneRosterObservation): Result<void, StagedMeshSourceError> {
    try {
      this.staged.advance(next);
      return ok(undefined);
    } catch (cause) {
      return err(new StagedMeshSourceError({ reason: 'successor' }, cause));
    }
  }

  setActive(active: boolean): Result<void | Promise<LevelRenderSelection>, StagedMeshSourceError> {
    if (this.phase !== 'resident-input' || (active && !this.isCurrent()))
      return err(new StagedMeshSourceError({ reason: 'source' }));
    return ok(this.rows?.select(active));
  }

  retireStep(): Result<StagedMeshSourceStatus, StagedMeshSourceError> {
    try {
      if (!this.abort.signal.aborted) {
        this.abort.abort();
        this.work.return(undefined);
        this.phase = 'retiring';
      }
      if (this.pending !== undefined) return ok(this.inspect());
      if (this.phase === 'retired') return ok(this.inspect());
      if (this.retirementFailure !== undefined) return err(this.retirementFailure);
      const rows = this.rows;
      if (rows !== undefined) {
        this.awaitWork(
          rows.retire().then(() => {
            this.rows = undefined;
          }),
          true,
        );
        return ok(this.inspect());
      }
      if (this.failure !== undefined && this.failure.cause !== undefined) return err(this.failure);
      this.staged.dispose();
      this.release();
      this.phase = 'retired';
      return ok(this.inspect());
    } catch (cause) {
      return err(new StagedMeshSourceError({ reason: 'source' }, cause));
    }
  }
}

function* fixedAssets(input: PreparedMeshSource): Generator<void, Set<number>> {
  const handles = new Set<number>();
  for (const row of input.renderables) {
    for (const handle of publicationDependencies(row)) handles.add(handle);
    for (const lod of row.lods ?? []) if (typeof lod.mesh === 'number') handles.add(lod.mesh);
    for (const material of [...row.materials, ...(row.materialOverrides ?? [])])
      for (const asset of material?.snapshot.sourceAssets?.assets ?? []) handles.add(asset.handle);
    yield;
  }
  return handles;
}
