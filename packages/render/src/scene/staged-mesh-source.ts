import type { SceneRosterObservation } from '@forgeax/engine-scene/internal';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { RenderResidencyGroup } from '../gpu-driven/batch-residency';
import { SOURCE_ROWS_PER_RETIREMENT_STEP } from '../gpu-scene-source-rows';
import type { InstanceProjectionStore } from '../instances';
import { MaterialResource, materialResource } from '../material-resource';
import { renderableAssetRoots } from '../publication/dependencies';
import type {
  MaterialSnapshotCache,
  MaterialSnapshotContexts,
  RenderableSnapshot,
} from '../render-system-extract';
import { materialSnapshotContext } from '../render-system-extract';
import { adoptSceneMaterials, publishedRows, retiredSlots } from '../world/material-systems';
import type {
  MeshSourceContent,
  MeshSourceResourceStatus,
  MeshSourceResources,
} from './mesh-source-resources';
import type { PreparedMeshSource } from './prepared-mesh-source';
import type {
  RenderSceneApplyResult,
  RenderSceneOperation,
  RenderSceneSlot,
  ReservedSceneRow,
} from './render-scene-types';
import type { CompositionEntry } from './scene-composition';
import type { SceneRowPreparation } from './scene-rows';
import type { SceneSlotFrame } from './scene-slots';

export type StagedMeshSourceFailure =
  | 'source'
  | 'session'
  | 'collision'
  | 'material'
  | 'instances'
  | 'successor'
  | 'busy'
  | 'closed'
  | 'native-bridge-unavailable'
  | 'view-obsolete';
export class StagedMeshSourceError extends Error {
  readonly code = 'staged-mesh-source-invalid' as const;
  override readonly name = 'StagedMeshSourceError';
  constructor(
    readonly detail: { readonly reason: StagedMeshSourceFailure },
    cause?: unknown,
  ) {
    super(`Staged mesh source: ${detail.reason}`, cause === undefined ? undefined : { cause });
  }
}
export interface StagedMeshSourceStatus {
  readonly phase:
    | 'extracting'
    | 'reserving-rows'
    | 'preparing-resources'
    | 'admitting'
    | 'resident-input'
    | 'failed'
    | 'retiring'
    | 'retired';
  readonly resources?: MeshSourceResourceStatus;
  readonly pending?: Promise<void> | undefined;
  readonly members: number;
  readonly admitted: number;
  readonly reserved: number;
}
/** Internal CPU source admission only. This never issues native readiness or opens execution. */
export interface StagedMeshSource {
  readonly group: RenderResidencyGroup;
  readonly hasRasterRows: boolean;
  step(): Result<StagedMeshSourceStatus, StagedMeshSourceError>;
  acceptSource(next: SceneRosterObservation): Result<void, StagedMeshSourceError>;
  setActive(active: boolean): Result<void, StagedMeshSourceError>;
  isCurrent(): boolean;
  retireStep(): Result<StagedMeshSourceStatus, StagedMeshSourceError>;
  inspect(): StagedMeshSourceStatus;
}
/** The source owns observation and stop proof. Device state never reads its World. */
export interface MeshSourceStageInput {
  readonly members: readonly number[];
  readonly namespace: object;
  readonly version: object;
  assertCurrent(): void;
  isCurrent(): boolean;
  extract(
    current: () => boolean,
  ): Generator<
    void,
    Result<Pick<PreparedMeshSource, 'renderables' | 'materialSnapshots' | 'isCurrent'>, Error>
  >;
  stopped(): boolean;
  dispose(): void;
}

export interface MeshSourceStageHost {
  readonly entry: CompositionEntry;
  validateSession(): void;
  readonly content: MeshSourceContent;
  readonly materials: MaterialSnapshotContexts;
  readonly instances: InstanceProjectionStore | undefined;
  prepareResources?:
    | ((
        renderables: readonly RenderableSnapshot[],
        current: () => boolean,
        rows: readonly ReservedSceneRow[],
      ) => MeshSourceResources)
    | undefined;
  current(): boolean;
  edit<T>(run: () => T): T;
  publish(delta: RenderSceneApplyResult, before: number): void;
  release(stage: MeshSourceStage): void;
}
interface CanonicalMaterialReceipt {
  readonly resource: MaterialResource;
  readonly value: NonNullable<ReturnType<MaterialSnapshotCache['get']>>;
  readonly previous: ReturnType<MaterialSnapshotCache['get']>;
  published: boolean;
}

/** The composition holds this task until every real row and collection receipt is settled. */
export class MeshSourceStage<Input extends MeshSourceStageInput = MeshSourceStageInput> {
  readonly group: RenderResidencyGroup;
  private host: MeshSourceStageHost | undefined;
  private input: Input | undefined;
  private readonly members: Set<number>;
  private readonly versions = new Map<number, number>();
  private readonly rows = new Map<number, RenderSceneSlot>();
  private rowsFrame: SceneSlotFrame | undefined;
  private readonly canonical = new Map<
    MaterialSnapshotCache,
    Map<number, CanonicalMaterialReceipt>
  >();
  private readonly pendingRows: SceneRowPreparation[] = [];
  private rowCursor = 0;
  private contentCurrent: (() => boolean) | undefined;
  private validatedPublicationRevision: number | undefined;
  private preparationCurrent: (() => boolean) | undefined;
  private readonly collections = new Map<number, NonNullable<RenderableSnapshot['instances']>>();
  private phase: StagedMeshSourceStatus['phase'] = 'extracting';
  private work: Generator<void> | undefined;
  private resources: MeshSourceResources | undefined;
  private fault: StagedMeshSourceError | undefined;
  private busy = false;
  private admitted = 0;
  private readonly memberCount: number;
  private retiringRequested = false;

  constructor(host: MeshSourceStageHost, input: Input) {
    this.host = host;
    const checkContent = host.content.matchesCurrent;
    this.contentCurrent = () => checkContent.call(host.content);
    this.input = input;
    this.members = new Set(input.members);
    this.memberCount = this.members.size;
    for (const handle of host.content.handles) {
      const version = host.content.version(handle).unwrap();
      if (host.entry.source.assetRevision(handle) !== version)
        throw new StagedMeshSourceError({ reason: 'source' });
      this.versions.set(handle, version);
    }
    this.validate();
    for (const entity of this.members)
      if (host.entry.projection.has(entity))
        throw new StagedMeshSourceError({ reason: 'collision' });
    this.group = host.entry.topology.createResidencyGroup();
    this.work = this.prepare();
  }

  owns(entity: number): boolean {
    return this.members.has(entity);
  }
  belongsTo(entry: CompositionEntry): boolean {
    return this.host?.entry === entry;
  }
  needsRetirement(entry: CompositionEntry | undefined): boolean {
    return this.retiringRequested || entry === undefined || !this.belongsTo(entry);
  }
  ownsIn(world: object, entity: number): boolean {
    return this.input?.namespace === world && this.owns(entity);
  }

  get hasRasterRows(): boolean {
    return this.rows.size > 0;
  }

  private session(): MeshSourceStageHost {
    const host = this.host;
    if (host === undefined || !host.current())
      throw new StagedMeshSourceError({ reason: 'session' });
    host.validateSession();
    return host;
  }
  private inputsCurrent(host: MeshSourceStageHost): boolean {
    // The fixed content lease can be closed between ordinary publications.
    if (this.contentCurrent?.() !== true) return false;
    const source = host.entry.source;
    const publication = source.revision;
    // Local asset readers have no ordinary publication boundary.
    if (publication === undefined || publication !== this.validatedPublicationRevision) {
      for (const [handle, version] of this.versions)
        if (source.assetRevision(handle) !== version) return false;
      if (source.revision !== publication) return false;
      this.validatedPublicationRevision = publication;
    }
    return host.current();
  }
  private validate(): MeshSourceStageHost {
    const host = this.session();
    const input = this.input;
    const phase = this.phase;
    if (input === undefined) throw new StagedMeshSourceError({ reason: 'closed' });
    const version = input.version;
    input.assertCurrent();
    if (!this.inputsCurrent(host)) throw new StagedMeshSourceError({ reason: 'source' });
    if (this.preparationCurrent !== undefined && !this.preparationCurrent())
      throw new StagedMeshSourceError({ reason: 'source' });
    if (
      this.host !== host ||
      this.input !== input ||
      input.version !== version ||
      this.phase !== phase ||
      !host.current()
    )
      throw new StagedMeshSourceError({ reason: 'session' });
    for (const [cache, expected] of this.canonical)
      for (const [handle, receipt] of expected) {
        const current = cache.get(handle);
        if (!receipt.published) {
          if (current !== receipt.previous) throw new StagedMeshSourceError({ reason: 'material' });
        } else if (
          current === undefined ||
          current.assetRevision !== receipt.value.assetRevision ||
          materialResource(current.snapshot) !== receipt.resource
        )
          throw new StagedMeshSourceError({ reason: 'material' });
      }
    if (this.pendingRows[this.rowCursor]?.isCurrent() === false)
      throw new StagedMeshSourceError({ reason: 'session' });
    if (this.resources !== undefined && !this.resources.current())
      throw new StagedMeshSourceError({ reason: 'source' });
    this.validateRows(host);
    return host;
  }
  private validateRows(host: MeshSourceStageHost): void {
    const current = host.entry.projection.slotsSnapshot();
    if (current === this.rowsFrame) return;
    const verify = (row: RenderSceneSlot) => {
      const actual = host.entry.projection.slot(row.entityKey);
      if (
        actual?.slot !== row.slot ||
        actual.generation !== row.generation ||
        actual.version !== row.version ||
        actual.snapshot.residencyGroup !== this.group
      )
        throw new StagedMeshSourceError({ reason: 'session' });
    };
    const incremental =
      this.rowsFrame !== undefined &&
      current.changesSince(this.rowsFrame, (slot) => {
        const row = this.rows.get(slot);
        if (row !== undefined) verify(row);
      });
    if (!incremental) for (const row of this.rows.values()) verify(row);
    this.rowsFrame = current;
  }
  private closeGate(): void {
    const topology = this.host?.entry.topology;
    if (topology?.hasResidencyGroup(this.group))
      topology.setResidencyGroupActive(this.group, false);
  }
  private failure(cause: unknown): StagedMeshSourceError {
    const failure =
      cause instanceof StagedMeshSourceError
        ? cause
        : new StagedMeshSourceError({ reason: 'source' }, cause);
    this.fault ??= failure;
    this.phase = 'failed';
    this.closeGate();
    return failure;
  }
  isCurrent(): boolean {
    if (this.busy || this.phase !== 'resident-input') return false;
    return this.currentObservation();
  }
  private currentObservation(): boolean {
    this.busy = true;
    try {
      this.validate();
      return true;
    } catch {
      this.closeGate();
      return false;
    } finally {
      this.busy = false;
    }
  }
  /** Ordinary source observation may reuse only a fully settled, current task. */
  reuseCurrent(): boolean {
    if (this.busy || (this.phase !== 'resident-input' && this.phase !== 'admitting')) return false;
    return this.currentObservation();
  }
  fulfills(entity: number): boolean {
    const slot = this.host?.entry.projection.slot(entity)?.slot;
    return (
      this.owns(entity) &&
      (this.phase === 'resident-input' || (slot !== undefined && this.rows.has(slot)))
    );
  }

  step(): Result<StagedMeshSourceStatus, StagedMeshSourceError> {
    if (this.busy) return err(new StagedMeshSourceError({ reason: 'busy' }));
    if (this.fault !== undefined) return err(this.fault);
    if (this.phase === 'retiring' || this.phase === 'retired')
      return err(new StagedMeshSourceError({ reason: 'closed' }));
    if (this.phase === 'resident-input') return ok(this.inspect());
    this.busy = true;
    try {
      const host = this.host;
      if (host === undefined) throw new StagedMeshSourceError({ reason: 'closed' });
      host.edit(() => {
        this.validate();
        const next = this.work?.next();
        this.validate();
        if (next?.done) {
          this.work = undefined;
          this.phase = 'resident-input';
          this.preparationCurrent = undefined;
        }
      });
      return ok(this.inspect());
    } catch (cause) {
      if (cause instanceof StagedMeshSourceError && cause.detail.reason === 'busy')
        return err(cause);
      return err(this.failure(cause));
    } finally {
      this.busy = false;
    }
  }

  private resourceSourceCurrent(
    host: MeshSourceStageHost,
    initial: () => boolean,
    count: number,
  ): boolean {
    if (
      this.retiringRequested ||
      this.admitted + this.pendingRows.length - this.rowCursor !== count
    )
      return false;
    if (this.phase === 'resident-input')
      return this.input?.isCurrent() === true && this.inputsCurrent(host);
    return initial() && this.pendingRows[this.rowCursor]?.isCurrent() !== false;
  }

  private *prepare(): Generator<void> {
    const host = this.validate();
    const input = this.input;
    if (input === undefined) throw new StagedMeshSourceError({ reason: 'closed' });
    // Source snapshots remain private until the device admits them.
    const current = () => this.inputsCurrent(host);
    const prepared = yield* input.extract(current);
    if (!prepared.ok) throw prepared.error;
    if (prepared.value.isCurrent !== current) this.preparationCurrent = prepared.value.isCurrent;
    const resources = new Map<MaterialResource, MaterialResource>();
    for (const { geometry, vertexColor, cache } of prepared.value.materialSnapshots.values()) {
      const canonical = materialSnapshotContext(host.materials, geometry, vertexColor);
      for (const [handle, value] of cache) {
        const expected = canonical.get(handle);
        if (expected !== undefined && expected.assetRevision !== value.assetRevision)
          throw new StagedMeshSourceError({ reason: 'material' });
        const accepted = expected ?? value;
        const resource = MaterialResource.from(accepted.snapshot);
        resources.set(MaterialResource.from(value.snapshot), resource);
        let receipts = this.canonical.get(canonical);
        if (receipts === undefined) {
          receipts = new Map();
          this.canonical.set(canonical, receipts);
        }
        receipts.set(handle, { resource, value: accepted, previous: expected, published: false });
        yield;
      }
    }
    this.phase = 'reserving-rows';
    for (const source of prepared.value.renderables) {
      this.validate();
      const row = this.normalize(source, resources);
      for (const handle of renderableAssetRoots(row))
        if (handle !== 0 && !this.versions.has(handle))
          throw new StagedMeshSourceError({ reason: 'source' });
      const snapshot = this.projectInstances(host, row);
      this.pendingRows.push(host.entry.projection.prepareRow(snapshot));
      this.validate();
      yield;
    }
    if (host.prepareResources !== undefined) {
      this.phase = 'preparing-resources';
      const rows = Object.freeze(this.pendingRows.map((task) => task.row));
      this.resources = host.prepareResources(
        rows.map((row) => row.snapshot),
        () => this.resourceSourceCurrent(host, prepared.value.isCurrent, rows.length),
        rows,
      );
      yield* this.resources.prepare();
    }
    this.phase = 'admitting';
    for (const [cache, receipts] of this.canonical) {
      for (const [handle, receipt] of receipts) {
        cache.set(handle, receipt.value);
        receipt.published = true;
        yield;
      }
    }
    for (; this.rowCursor < this.pendingRows.length; ) {
      this.validate();
      const task = this.pendingRows[this.rowCursor];
      if (task === undefined) throw new StagedMeshSourceError({ reason: 'session' });
      this.publishRow(host, task, this.rowCursor);
      this.validate();
      yield;
    }
    this.pendingRows.length = 0;
    this.rowCursor = 0;
  }
  private publishRow(host: MeshSourceStageHost, task: SceneRowPreparation, index: number): void {
    const identity = task.row;
    const before = host.entry.projection.observedRows;
    const delta = task.publish(this.resources?.row(index));
    this.rowCursor++;
    const slot = delta.createdSlots[0];
    if (
      slot === undefined ||
      slot.slot !== identity.slot ||
      slot.generation !== identity.generation
    )
      throw new StagedMeshSourceError({ reason: 'session' });
    this.rows.set(slot.slot, slot);
    this.admitted++;
    this.resources?.acceptRow(index, slot);
    host.publish(delta, before);
  }

  private normalize(
    source: RenderableSnapshot,
    resources: ReadonlyMap<MaterialResource, MaterialResource>,
  ): RenderableSnapshot {
    return {
      ...source,
      residencyGroup: this.group,
      material: resources.get(source.material) ?? source.material,
      materials: source.materials.map((resource) => resources.get(resource) ?? resource),
      ...(source.materialOverrides === undefined
        ? {}
        : {
            materialOverrides: source.materialOverrides.map((resource) =>
              resource === undefined ? undefined : (resources.get(resource) ?? resource),
            ),
          }),
    };
  }
  private projectInstances(host: MeshSourceStageHost, row: RenderableSnapshot): RenderableSnapshot {
    if (row.instances === undefined) return row;
    const store = host.instances;
    if (store === undefined) throw new StagedMeshSourceError({ reason: 'instances' });
    const input = this.input;
    if (input === undefined) throw new StagedMeshSourceError({ reason: 'closed' });
    const projected = store.project(input.namespace, row.entityKey, row.instances.transforms);
    if (!('collectionId' in projected))
      throw new StagedMeshSourceError({ reason: 'instances' }, projected);
    const instances = { ...row.instances, ...projected };
    this.collections.set(row.entityKey, instances);
    store.accept(input.namespace, row.entityKey, projected);
    return { ...row, instances };
  }

  isActive(): boolean {
    const topology = this.host?.entry.topology;
    return (
      topology?.hasResidencyGroup(this.group) === true &&
      topology.captureResidencySelection().includes(this.group)
    );
  }

  setActive(active: boolean): Result<void, StagedMeshSourceError> {
    if (this.busy) return err(new StagedMeshSourceError({ reason: 'busy' }));
    this.busy = true;
    try {
      this.session().edit(() => {
        if (active) this.validate();
        const topology = this.session().entry.topology;
        topology.setResidencyGroupActive(this.group, active);
      });
      return ok(undefined);
    } catch (cause) {
      return err(this.failure(cause));
    } finally {
      this.busy = false;
    }
  }

  protected transitionSource(advance: (input: Input) => void): Result<void, StagedMeshSourceError> {
    if (this.busy) return err(new StagedMeshSourceError({ reason: 'busy' }));
    const input = this.input;
    if (this.phase !== 'resident-input' || input === undefined)
      return err(new StagedMeshSourceError({ reason: 'closed' }));
    this.busy = true;
    try {
      this.session().edit(() => {
        this.closeGate();
        const host = this.session();
        advance(input);
        if (!this.inputsCurrent(host) || this.input !== input)
          throw new StagedMeshSourceError({ reason: 'source' });
        this.validate();
      });
      return ok(undefined);
    } catch (cause) {
      if (cause instanceof StagedMeshSourceError && cause.detail.reason === 'busy')
        return err(cause);
      return err(this.failure(cause));
    } finally {
      this.busy = false;
    }
  }

  /** Qualified closed rows share one notification to each ordinary Scene consumer. */
  private retireRows(host: MeshSourceStageHost): void {
    const rows: RenderSceneSlot[] = [];
    const operations: RenderSceneOperation[] = [];
    const missing: RenderSceneSlot[] = [];
    const { entry } = host;
    for (const row of this.rows.values()) {
      const current = entry.projection.slot(row.entityKey);
      if (current === undefined) missing.push(row);
      else {
        if (current.slot !== row.slot || current.generation !== row.generation)
          throw new StagedMeshSourceError({ reason: 'session' });
        operations.push({ kind: 'remove', entityKey: row.entityKey });
      }
      rows.push(row);
      if (rows.length === SOURCE_ROWS_PER_RETIREMENT_STEP) break;
    }
    if (operations.length > 0) {
      const before = entry.projection.observedRows;
      host.publish(entry.projection.apply(operations), before);
    }
    for (const row of missing) {
      entry.assetClosure?.replace(row.entityKey, []);
      if (entry.projection.slotAt(row.slot) === undefined) entry.materialDispatch.remove(row.slot);
    }
    for (const row of rows) {
      this.releaseCollection(host, row.entityKey);
      this.rows.delete(row.slot);
    }
  }

  retireStep(): Result<StagedMeshSourceStatus, StagedMeshSourceError> {
    if (this.busy) return err(new StagedMeshSourceError({ reason: 'busy' }));
    if (this.phase === 'retired') return ok(this.inspect());
    this.busy = true;
    try {
      const host = this.host;
      if (host === undefined) throw new StagedMeshSourceError({ reason: 'closed' });
      host.edit(() => {
        this.closeGate();
        this.phase = 'retiring';
        this.retiringRequested = true;
        this.rowsFrame = undefined;
        this.work?.return(undefined);
        this.work = undefined;
        this.preparationCurrent = undefined;
        this.resources?.beginRetirement();
        const pending = this.pendingRows.at(-1);
        if (pending !== undefined) {
          pending.release();
          this.pendingRows.pop();
          this.rowCursor = Math.min(this.rowCursor, this.pendingRows.length);
          return;
        }
        if (this.rows.size > 0) {
          this.retireRows(host);
          return;
        }
        const collection = this.collections.keys().next().value as number | undefined;
        if (collection !== undefined) {
          this.releaseCollection(host, collection);
          return;
        }
        if (this.input?.stopped() !== true) return;
        if (host.entry.topology.hasResidencyGroup(this.group))
          host.entry.topology.retireResidencyGroup(this.group);
        if (this.resources !== undefined && !this.resources.retireStep()) return;
        this.phase = 'retired';
        host.release(this);
        this.resources = undefined;
        this.host = undefined;
        this.input?.dispose();
        this.input = undefined;
        this.members.clear();
        this.versions.clear();
        this.canonical.clear();
        this.contentCurrent = undefined;
      });
      return ok(this.inspect());
    } catch (cause) {
      if (cause instanceof StagedMeshSourceError && cause.detail.reason === 'busy')
        return err(cause);
      return err(this.failure(cause));
    } finally {
      this.busy = false;
    }
  }
  private releaseCollection(host: MeshSourceStageHost, entity: number): void {
    const expected = this.collections.get(entity);
    if (expected !== undefined) {
      const input = this.input;
      if (input === undefined) throw new StagedMeshSourceError({ reason: 'closed' });
      host.instances?.discardProjection(input.namespace, entity, expected);
      host.instances?.release(input.namespace, entity, expected);
    }
    this.collections.delete(entity);
  }
  inspect(): StagedMeshSourceStatus {
    return {
      phase: this.phase,
      members: this.memberCount,
      admitted: this.admitted,
      reserved: this.pendingRows.length - this.rowCursor,
      ...(this.resources === undefined
        ? {}
        : { resources: this.resources.inspect(), pending: this.resources.pending }),
    };
  }
}

/** The exact same material/topology route used by ordinary source admission. */
export function publishStagedMeshRows(
  entry: CompositionEntry,
  delta: RenderSceneApplyResult,
): void {
  adoptSceneMaterials(entry, {
    retired: retiredSlots(delta),
    bound: publishedRows(delta),
    topology: delta,
    materialUpdates: [],
  });
}
