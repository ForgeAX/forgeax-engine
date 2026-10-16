import type { MeshAsset } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';
import { PointsLinesPrepareFailedError } from '../errors/render';
import type { PointsLinesExpandedGeometry, PointsLinesExpansionCache } from './expansion-cache';
import {
  createPointsLinesLaneContract,
  type PointsLinesBackend,
  type PointsLinesLane,
  type PointsLinesLaneContract,
} from './record';
import type { PointsLinesRetainedSnapshot } from './snapshot';

export interface PointsLinesGpuResourceAdapter<Resource> {
  create(geometry: PointsLinesExpandedGeometry): Result<Resource, Error>;
  upload(resource: Resource, geometry: PointsLinesExpandedGeometry): Result<number, Error>;
  validate(resource: Resource, geometry: PointsLinesExpandedGeometry): Result<void, Error>;
  destroy(resource: Resource): void;
}

export interface PointsLinesPreparedResource<Resource> {
  readonly resource: Resource;
  readonly geometry: PointsLinesExpandedGeometry;
  readonly snapshot: PointsLinesRetainedSnapshot;
  readonly uploadedBytes: number;
  readonly lastKnownGood: true;
}

export interface PointsLinesPreparationOptions<Resource> {
  readonly cache: PointsLinesExpansionCache;
  readonly adapter: PointsLinesGpuResourceAdapter<Resource>;
}

export interface PointsLinesLanePreparationAdapter<Resource> {
  readonly contract: PointsLinesLaneContract;
  prepare(
    snapshot: PointsLinesRetainedSnapshot,
    mesh: MeshAsset,
  ): Result<PointsLinesPreparedResource<Resource>, PointsLinesPrepareFailedError>;
  resetForDeviceLoss(): void;
  /** Drop lost-device handles without calling destroy on the dead device. */
  abandonForDeviceLoss(): void;
  lastKnownGood(): PointsLinesPreparedResource<Resource> | undefined;
  inspect(): PointsLinesPreparationInspection<Resource>;
}

export interface PointsLinesPreparationInspection<Resource> {
  readonly status: 'empty' | 'resident' | 'rebuild-pending';
  readonly lastKnownGood: boolean;
  readonly liveResource: Resource | undefined;
  readonly liveBytes: number;
  readonly candidateBytes: number;
  readonly cacheEntries: number;
  readonly uploads: number;
  readonly rebuilds: number;
  readonly failures: number;
}

/**
 * Owns one atomic candidate/LKG pair for a Points/Lines render projection.
 * GPU resources are supplied by the existing DeviceScope adapter; this class
 * keeps no backend handle or second resource ledger.
 */
export class PointsLinesPreparation<Resource> {
  private live: PointsLinesPreparedResource<Resource> | undefined;
  private pendingCandidateBytes = 0;
  private status: 'empty' | 'resident' | 'rebuild-pending' = 'empty';
  private uploads = 0;
  private rebuilds = 0;
  private failures = 0;

  constructor(private readonly options: PointsLinesPreparationOptions<Resource>) {}

  prepare(
    snapshot: PointsLinesRetainedSnapshot,
    mesh: MeshAsset,
  ): Result<PointsLinesPreparedResource<Resource>, PointsLinesPrepareFailedError> {
    const geometry = this.options.cache.getOrCreate(snapshot, mesh);
    if (this.live?.geometry.key === geometry.key) {
      this.live = {
        ...this.live,
        snapshot,
        uploadedBytes: 0,
      };
      this.status = 'resident';
      return ok(this.live);
    }

    this.pendingCandidateBytes = geometry.derivedBytes;
    const created = this.options.adapter.create(geometry);
    if (!created.ok) return this.fail(snapshot, created.error);
    const candidate = created.value;
    const uploaded = this.options.adapter.upload(candidate, geometry);
    if (!uploaded.ok) {
      this.options.adapter.destroy(candidate);
      return this.fail(snapshot, uploaded.error);
    }
    this.uploads += 1;
    const validated = this.options.adapter.validate(candidate, geometry);
    if (!validated.ok) {
      this.options.adapter.destroy(candidate);
      return this.fail(snapshot, validated.error);
    }

    const previous = this.live;
    this.live = {
      resource: candidate,
      geometry,
      snapshot,
      uploadedBytes: uploaded.value,
      lastKnownGood: true,
    };
    this.pendingCandidateBytes = 0;
    this.status = 'resident';
    this.rebuilds += 1;
    if (previous !== undefined) this.options.adapter.destroy(previous.resource);
    return ok(this.live);
  }

  resetForDeviceLoss(): void {
    if (this.live !== undefined) this.options.adapter.destroy(this.live.resource);
    this.live = undefined;
    this.pendingCandidateBytes = 0;
    this.status = 'rebuild-pending';
  }

  abandonForDeviceLoss(): void {
    this.live = undefined;
    this.pendingCandidateBytes = 0;
    this.status = 'rebuild-pending';
  }

  lastKnownGood(): PointsLinesPreparedResource<Resource> | undefined {
    return this.live;
  }

  inspect(): PointsLinesPreparationInspection<Resource> {
    return {
      status: this.status,
      lastKnownGood: this.live?.lastKnownGood ?? false,
      liveResource: this.live?.resource,
      liveBytes: this.live?.geometry.derivedBytes ?? 0,
      candidateBytes: this.pendingCandidateBytes,
      cacheEntries: this.options.cache.size,
      uploads: this.uploads,
      rebuilds: this.rebuilds,
      failures: this.failures,
    };
  }

  private fail(
    snapshot: PointsLinesRetainedSnapshot,
    cause: Error,
  ): Result<never, PointsLinesPrepareFailedError> {
    this.pendingCandidateBytes = 0;
    this.failures += 1;
    return err(
      new PointsLinesPrepareFailedError({
        owner: 'points-lines',
        generation: snapshot.meshGeneration,
        stage: 'prepare',
        cause: cause.message,
        lastKnownGood: this.live !== undefined,
      }),
    );
  }
}

/**
 * Binds the existing atomic preparation owner to a lane contract. It carries
 * no RHI handle and does not add a second cache or recovery owner.
 */
export function createPointsLinesLanePreparationAdapter<Resource>(
  lane: PointsLinesLane,
  backend: PointsLinesBackend,
  options: PointsLinesPreparationOptions<Resource>,
): PointsLinesLanePreparationAdapter<Resource> {
  const preparation = new PointsLinesPreparation(options);
  return {
    contract: createPointsLinesLaneContract(lane, backend),
    prepare: (snapshot, mesh) => preparation.prepare(snapshot, mesh),
    resetForDeviceLoss: () => preparation.resetForDeviceLoss(),
    abandonForDeviceLoss: () => preparation.abandonForDeviceLoss(),
    lastKnownGood: () => preparation.lastKnownGood(),
    inspect: () => preparation.inspect(),
  };
}
