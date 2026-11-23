import { type MipmapEncoderWork, prepareMipmaps } from '@forgeax/engine-assets-runtime';
import type { AssetContentLease } from '@forgeax/engine-assets-runtime/internal';
import type { RhiDevice } from '@forgeax/engine-rhi';
import type { Asset, AssetHandle, MeshAsset, Result } from '@forgeax/engine-types';
import type { DeviceScope } from '../device/device-scope';
import type { GpuResidencyCache, MeshGpuHandles } from '../device/gpu-residency';
import type { ResidencyLease } from '../device/residency-lifetime';
import type { GpuViewInputPreparation } from '../gpu-driven/view-input-bindings';
import type { GpuBuffer, GpuTexture } from '../gpu-resource';
import type { GpuScene } from '../gpu-scene';
import type { GpuSceneCapacityPreparation, GpuSceneCapacityStatus } from '../gpu-scene-capacity';
import type { GpuSceneInputPreparation } from '../gpu-scene-inputs';
import type { GpuSceneSourceMeshInput, GpuSceneSourceRow } from '../gpu-scene-source-rows';
import { publicationDependencies } from '../publication/dependencies';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { RenderSystemInternals } from '../record/render-context';
import type { RenderableSnapshot } from '../render-system-extract';
import type { RenderSceneSlot, ReservedSceneRow } from './render-scene-types';

export type MeshSourceContent = Pick<
  AssetContentLease,
  'handles' | 'read' | 'version' | 'matchesCurrent'
>;

export interface MeshSourceResourceInputs {
  readonly renderables: readonly RenderableSnapshot[];
  readonly rows: readonly ReservedSceneRow[];
  readonly content: MeshSourceContent;
  readonly source: RenderResourceScope;
  current(): boolean;
  /** Current C0 consumers in this namespace, including ordinary/shared rows. */
  referenced(handle: number): boolean;
}
export interface MeshSourceResourceStatus {
  readonly phase:
    | 'collecting'
    | 'preparing'
    | 'preparing-capacity'
    | 'preparing-bindings'
    | 'resident'
    | 'data'
    | 'retiring'
    | 'retired';
  readonly meshes: number;
  readonly textures: number;
  readonly released: number;
  readonly capacity?: GpuSceneCapacityStatus;
  readonly inputs?: {
    readonly phase: ReturnType<GpuSceneInputPreparation['inspect']>['phase'];
    readonly byteLength: number;
    readonly resourceRoot: number;
    readonly privatePageBytes: number;
    readonly uploadedBytes: number;
  };
}
export class MeshSourceResourceError extends Error {
  readonly code = 'mesh-source-resource-invalid' as const;
  constructor(
    readonly detail: { readonly reason: 'source' | 'device' | 'version' | 'retirement' },
    cause?: unknown,
  ) {
    super(`Mesh source resources: ${detail.reason}`, { cause });
    this.name = 'MeshSourceResourceError';
  }
}
interface Wait {
  done: boolean;
  failure: { readonly cause: unknown } | undefined;
  readonly wake: Promise<void>;
}
function observe(work: Promise<unknown>): Wait {
  const result: Wait = {
    done: false,
    failure: undefined,
    wake: work.then(
      () => {
        result.done = true;
      },
      (cause) => {
        result.failure = { cause };
        result.done = true;
      },
    ),
  };
  return result;
}
interface Held {
  readonly lease: ResidencyLease;
  readonly mesh?: {
    readonly handle: number;
    readonly asset: MeshAsset;
    readonly entry: MeshGpuHandles;
  };
  readonly current: () => boolean;
  readonly commit: () => boolean;
  readonly resources: readonly (GpuBuffer | GpuTexture)[];
  fence: Wait | undefined;
  mips: MipmapEncoderWork | undefined;
  released: Wait | undefined;
}

/** Private physical phase of the existing Source task, never a native admission issuer. */
export class MeshSourceResources {
  private inputs: MeshSourceResourceInputs | undefined;
  private readonly held: Held[] = [];
  private readonly retiringHolds: Held[] = [];
  private wait: Wait | undefined;
  private retirementFailure: { readonly cause: unknown } | undefined;
  private phase: MeshSourceResourceStatus['phase'] = 'collecting';
  private meshes = 0;
  private textures = 0;
  private released = 0;
  private capacity: GpuSceneCapacityPreparation | undefined;
  private scene: GpuScene | undefined;
  private dataDetached = false;
  private capacityFence: Wait | undefined;
  private bindingInput: GpuSceneInputPreparation | undefined;
  private bindingPreparation: GpuViewInputPreparation | undefined;
  private settleViews:
    | (() => Promise<Result<void, import('@forgeax/engine-rhi').RhiError>>)
    | undefined;
  private viewRetirement: Wait | undefined;
  constructor(
    inputs: MeshSourceResourceInputs,
    private readonly native: {
      readonly store: GpuResidencyCache;
      readonly device: RhiDevice;
      readonly scope: DeviceScope;
      readonly prepareCapacity?:
        | ((
            rows: readonly ReservedSceneRow[],
            capture: (task: GpuSceneCapacityPreparation) => void,
            current: () => boolean,
            meshes: readonly GpuSceneSourceMeshInput[],
          ) => Generator<void, { scene: GpuScene; task: GpuSceneCapacityPreparation }>)
        | undefined;
      readonly prepareBindings?: RenderSystemInternals['prepareSceneInputBindings'];
      readonly prepareAddressCapacity?: RenderSystemInternals['prepareSceneAddressCapacity'];
      current(): boolean;
    },
  ) {
    this.inputs = inputs;
  }

  get pending(): Promise<void> | undefined {
    return this.wait?.done === false ? this.wait.wake : undefined;
  }
  inspect(): MeshSourceResourceStatus {
    const input = this.bindingInput;
    const inputStatus = input?.inspect();
    return {
      phase: this.phase,
      meshes: this.meshes,
      textures: this.textures,
      released: this.released,
      ...(this.capacity === undefined ? {} : { capacity: this.capacity.inspect() }),
      ...(input === undefined || inputStatus === undefined
        ? {}
        : {
            inputs: {
              phase: inputStatus.phase,
              byteLength: input.byteLength,
              resourceRoot: input.resourceRoot,
              privatePageBytes: input.privatePageBytes,
              uploadedBytes: inputStatus.uploadBytes,
            },
          }),
    };
  }
  current(): boolean {
    if (!this.physicalCurrent()) return false;
    return (
      this.phase !== 'data' ||
      (this.capacity !== undefined &&
        this.scene?.sourceDataCurrent(this.capacity) === true &&
        this.physicalCurrent())
    );
  }
  private physicalCurrent(): boolean {
    return (
      this.phase !== 'retiring' &&
      this.phase !== 'retired' &&
      this.inputs?.current() === true &&
      this.native.current() &&
      this.native.scope.isAlive() &&
      this.held.every(
        (item) =>
          item.current() &&
          item.resources.every(
            (resource) => !resource.isDestroyed && resource.destructionFailure === undefined,
          ),
      )
    );
  }
  private assertCurrent(): MeshSourceResourceInputs {
    if (!this.native.current() || !this.native.scope.isAlive())
      throw new MeshSourceResourceError({ reason: 'device' });
    if (!this.current() || this.inputs === undefined)
      throw new MeshSourceResourceError({ reason: 'source' });
    return this.inputs;
  }
  private *awaitWork(wait: Wait): Generator<void> {
    this.wait = wait;
    while (!wait.done) {
      this.assertCurrent();
      yield;
    }
    this.wait = undefined;
    if (wait.failure !== undefined) throw wait.failure.cause;
    this.assertCurrent();
  }
  private fence(item: Held): Wait {
    // A previous fence cannot certify commands submitted after it.
    item.fence = undefined;
    const submitted = this.native.device.queue.onSubmittedWorkDone();
    item.lease.track(submitted);
    const fence = observe(submitted);
    item.fence = fence;
    return fence;
  }
  *prepare(): Generator<void> {
    const needed = new Set<number>();
    const input = this.assertCurrent();
    for (const row of input.renderables) {
      for (const handle of publicationDependencies(row)) if (handle !== 0) needed.add(handle);
      yield;
    }
    this.phase = 'preparing';
    for (const value of needed) {
      const input = this.assertCurrent();
      const handle = value as AssetHandle;
      const version = input.content.version(handle).unwrap();
      const asset = input.content.read<Asset>(handle).unwrap();
      if (input.source.assetRevision(handle) !== version)
        throw new MeshSourceResourceError({ reason: 'version' });
      if (asset.kind === 'mesh') {
        let item: Held | undefined;
        const previous = this.native.store.getMeshGpuHandles(
          handle as AssetHandle<'mesh'>,
          input.source,
        );
        const prepared = this.native.store
          .prepareMeshResidency(
            handle as AssetHandle<'mesh'>,
            asset,
            version,
            input.source,
            undefined,
            (captured) => {
              item = {
                lease: captured.lease,
                mesh: { handle, asset, entry: captured.entry },
                current: captured.current,
                commit: captured.commit,
                resources: [
                  captured.entry.vertexBuffer,
                  ...(captured.entry.indexBuffer === null ? [] : [captured.entry.indexBuffer]),
                ],
                fence: undefined,
                mips: undefined,
                released: undefined,
              };
              this.held.push(item);
              this.meshes++;
            },
            () => !input.referenced(handle),
          )
          .unwrap();
        if (item === undefined) throw new MeshSourceResourceError({ reason: 'source' });
        this.fence(item);
        if (previous !== undefined && prepared.entry !== previous)
          throw new MeshSourceResourceError({ reason: 'version' });
        yield* this.awaitWork(item.fence as Wait);
      } else if (asset.kind === 'texture' || asset.kind === 'gpu-texture') {
        yield* this.prepareTexture(input, handle, asset, version);
      }
      // Material/sampler descriptors are consumed by the later native binding phase.
      yield;
    }
    this.phase = 'resident';
    // Final all-receipt qualification is measured in this resume, not moved
    // into an unmeasured inspection or the first active frame.
    this.assertCurrent();
    yield* this.prepareCapacity();
    this.phase = 'data';
    this.assertCurrent();
  }
  private *prepareTexture(
    input: MeshSourceResourceInputs,
    handle: AssetHandle,
    asset: Extract<Asset, { kind: 'texture' | 'gpu-texture' }>,
    version: number,
  ): Generator<void> {
    let item: Held | undefined;
    const store = this.native.store;
    const prepare = () =>
      store.prepareTextureResidencyForGraph(
        handle as AssetHandle<'texture' | 'gpu-texture'>,
        asset,
        input.source,
        (captured) => {
          item = {
            lease: captured.lease,
            current: captured.current,
            commit: captured.commit,
            resources: [captured.entry.texture],
            fence: undefined,
            mips: undefined,
            released: undefined,
          };
          this.held.push(item);
          this.textures++;
        },
        version,
        () => !input.referenced(handle),
      );
    const release = store.holdGraphTexture(handle);
    let texture: ReturnType<typeof prepare>;
    try {
      texture = prepare();
      while (
        !texture.ok &&
        texture.error.code === 'asset-not-ready' &&
        store.isTexturePreparing(handle, input.source)
      ) {
        yield* this.awaitWork(observe(store.waitTextureData(handle, input.source)));
        texture = prepare();
      }
    } finally {
      release();
    }
    const prepared = texture.unwrap();
    if (item === undefined) throw new MeshSourceResourceError({ reason: 'source' });
    if (prepared.accepted !== undefined) {
      yield* this.awaitWork(
        observe(
          prepared.accepted.then((accepted) => {
            if (!accepted) throw new MeshSourceResourceError({ reason: 'source' });
          }),
        ),
      );
    }
    this.fence(item);
    if (prepared.entry.receipt.sourceRevision !== version)
      throw new MeshSourceResourceError({ reason: 'version' });
    if (prepared.needsMipmaps) {
      yield* this.awaitWork(
        observe(
          this.native.store
            .prewarmMipmapPipeline(this.native.device, [prepared.entry.receipt.format])
            .then((result) => {
              result.unwrap();
            }),
        ),
      );
      const receipt = prepared.entry.receipt;
      const mipItem = item;
      item.mips = prepareMipmaps(
        this.native.device,
        prepared.entry.texture.handle,
        {
          width: receipt.extent.width,
          height: receipt.extent.height,
          format: receipt.format,
          levels: receipt.mipLevelCount,
          arrayLayerCount: receipt.extent.depthOrArrayLayers,
        },
        (work) => {
          mipItem.mips = work;
        },
      ).unwrap();
      const command = item.mips.finish().unwrap();
      let submissionFailure: { readonly cause: unknown } | undefined;
      try {
        if (command !== undefined) this.native.device.queue.submit([command]).unwrap();
      } catch (cause) {
        submissionFailure = { cause };
      }
      try {
        this.fence(item);
      } catch (cause) {
        throw submissionFailure === undefined
          ? cause
          : new AggregateError(
              [submissionFailure.cause, cause],
              'mipmap submit and completion observation failed',
            );
      }
      if (submissionFailure !== undefined) throw submissionFailure.cause;
    }
    yield* this.awaitWork(item.fence as Wait);
    this.discardMips(item);
  }
  private *prepareCapacity(): Generator<void> {
    if (this.native.prepareCapacity !== undefined) {
      this.phase = 'preparing-capacity';
      const input = this.assertCurrent();
      const meshes: GpuSceneSourceMeshInput[] = [];
      for (const item of this.held) {
        if (item.mesh === undefined) continue;
        const revision = input.source.assetRevision(item.mesh.handle);
        if (revision === undefined) throw new MeshSourceResourceError({ reason: 'version' });
        meshes.push({
          handle: item.mesh.handle,
          asset: item.mesh.asset,
          identity: input.source.identity,
          revision,
        });
        yield;
        this.assertCurrent();
      }
      const prepared = yield* this.native.prepareCapacity(
        input.rows,
        (task) => {
          this.capacity = task;
        },
        () => this.physicalCurrent(),
        meshes,
      );
      this.scene = prepared.scene;
      if (prepared.task.inspect().tables > 0)
        yield* this.prepareBindings(prepared.scene, prepared.task);
      else yield* prepared.scene.prepareSourceData(prepared.task);
    }
  }
  private *prepareBindings(
    scene: GpuScene,
    capacity: GpuSceneCapacityPreparation,
  ): Generator<void> {
    const prepare = this.native.prepareBindings;
    if (prepare === undefined) throw new MeshSourceResourceError({ reason: 'source' });
    this.phase = 'preparing-bindings';
    yield* scene.prepareSourceData(capacity);
    const extent = scene.preparedAddressExtent(capacity);
    if (extent === undefined || this.native.prepareAddressCapacity === undefined)
      throw new MeshSourceResourceError({ reason: 'source' });
    yield* this.native.prepareAddressCapacity(
      scene,
      extent,
      () => this.physicalCurrent() && capacity.isValid(),
      (settle) => {
        this.settleViews = settle;
      },
    );
    let input = yield* this.copySourceInputs(scene, capacity);
    yield* this.awaitWork(observe(this.native.device.queue.onSubmittedWorkDone()));
    for (const item of this.held) {
      this.assertCurrent();
      if (!item.commit()) throw new MeshSourceResourceError({ reason: 'version' });
      yield;
    }
    for (;;) {
      this.assertCurrent();
      if (!capacity.isCurrent()) capacity.step().unwrap();
      if (input.superseded()) input = yield* this.copySourceInputs(scene, capacity, input);
      if (!input.isCurrent()) input.step(64 * 1024).unwrap();
      if (capacity.isCurrent() && input.isCurrent()) break;
      yield;
    }
    const target = scene.prepareCapacityBindingTarget(capacity).unwrap();
    // Prepare and consume the real Camera owners in this same exclusive
    // quantum. The Source execution gate stays closed for later C1 work.
    try {
      this.bindingPreparation = prepare(scene, input, target).unwrap();
      if (!this.bindingPreparation.isCurrent())
        throw new MeshSourceResourceError({ reason: 'source' });
      this.bindingPreparation.publish().unwrap();
    } finally {
      this.bindingPreparation?.release();
      this.bindingPreparation = undefined;
    }
  }

  private *copySourceInputs(
    scene: GpuScene,
    capacity: GpuSceneCapacityPreparation,
    stale?: GpuSceneInputPreparation,
  ): Generator<void, GpuSceneInputPreparation> {
    for (;;) {
      if (stale !== undefined) yield* this.retireSourceInputs(stale);
      this.assertCurrent();
      try {
        const input = yield* scene.prepareSourceInputs(
          capacity,
          (value) => {
            this.bindingInput = value;
          },
          () => this.physicalCurrent(),
          stale,
        );
        // Ordinary recording can grow the live Inputs while this copy yields.
        // Retire the superseded copy, preserving the sealed Source's rows.
        while (!input.isCurrent() && !input.superseded()) {
          input.step(64 * 1024).unwrap();
          yield;
        }
        if (input.isCurrent()) return input;
        stale = input;
      } catch (cause) {
        const input = this.bindingInput;
        if (input === undefined || input === stale || !input.superseded()) throw cause;
        stale = input;
      }
    }
  }

  private *retireSourceInputs(input: GpuSceneInputPreparation): Generator<void> {
    input.release();
    for (;;) {
      const progress = input.retirement().unwrap();
      if (progress.done) return;
      if (progress.pending === undefined) yield;
      else yield* this.awaitWork(observe(progress.pending));
    }
  }

  row(index: number): GpuSceneSourceRow {
    const value =
      this.capacity === undefined ? undefined : this.scene?.sourceRowAt(this.capacity, index);
    if (this.phase !== 'data' || value === undefined)
      throw new MeshSourceResourceError({ reason: 'source' });
    return value;
  }

  acceptRow(index: number, row: RenderSceneSlot): void {
    if (this.phase !== 'data' || this.scene === undefined || this.capacity === undefined)
      throw new MeshSourceResourceError({ reason: 'source' });
    this.scene.acceptSourceRow(this.capacity, index, row).unwrap();
  }
  private discardMips(item: Held): void {
    try {
      item.mips?.discard();
      item.mips = undefined;
    } catch (cause) {
      this.retirementFailure = { cause };
      throw cause;
    }
  }
  /** Stop preparation immediately; exact rows still own resource custody until they detach. */
  beginRetirement(): void {
    if (this.retirementFailure !== undefined) throw this.retirementFailure.cause;
    if (this.phase === 'retiring' || this.phase === 'retired') return;
    this.phase = 'retiring';
    try {
      if (this.capacity !== undefined) {
        this.capacity.invalidate();
        this.capacityFence ??= observe(this.native.device.queue.onSubmittedWorkDone());
        if (!this.capacityFence.done) this.wait = this.capacityFence;
      }
    } catch (cause) {
      this.retirementFailure = { cause };
      throw cause;
    }
  }
  private retireCapacity(): boolean {
    if (this.capacity !== undefined) {
      this.capacity.invalidate();
      try {
        if (!this.dataDetached && this.capacity.inspect().transferredTables > 0) {
          if (this.scene === undefined) throw new MeshSourceResourceError({ reason: 'retirement' });
          if (!this.scene.detachSourceData(this.capacity).unwrap().done) return false;
          this.dataDetached = true;
          // The earlier preparation/stop fence does not cover these clears.
          this.capacityFence = undefined;
          return false;
        }
        this.capacityFence ??= observe(this.native.device.queue.onSubmittedWorkDone());
        if (!this.capacityFence.done) {
          this.wait = this.capacityFence;
          return false;
        }
        if (this.capacityFence.failure !== undefined) throw this.capacityFence.failure.cause;
        if (!this.capacity.retireStep()) return false;
        this.capacity = undefined;
        this.scene = undefined;
        this.capacityFence = undefined;
      } catch (cause) {
        this.retirementFailure = { cause };
        throw cause;
      }
    }
    return true;
  }
  private retireViews(): boolean {
    if (this.settleViews === undefined) return true;
    try {
      this.viewRetirement ??= observe(this.settleViews().then((result) => result.unwrap()));
      if (!this.viewRetirement.done) {
        this.wait = this.viewRetirement;
        return false;
      }
      if (this.viewRetirement.failure !== undefined) throw this.viewRetirement.failure.cause;
      this.viewRetirement = undefined;
      this.settleViews = undefined;
      return true;
    } catch (cause) {
      this.retirementFailure = { cause };
      throw cause;
    }
  }
  private retireInputs(): boolean {
    const input = this.bindingInput;
    if (input === undefined) return true;
    try {
      input.release();
      const retired = input.retirement().unwrap();
      if (!retired.done) {
        if (retired.pending !== undefined) this.wait = observe(retired.pending);
        return false;
      }
      this.bindingInput = undefined;
      return true;
    } catch (cause) {
      this.retirementFailure = { cause };
      throw cause;
    }
  }

  private releaseHold(item: Held): void {
    const fence = item.fence ?? this.fence(item);
    if (!fence.done) {
      this.wait = fence;
      return;
    }
    if (fence.failure !== undefined) throw fence.failure.cause;
    this.discardMips(item);
    const completion = item.lease.release(true);
    if (completion !== undefined) item.released = observe(completion);
    this.held.shift();
    this.retiringHolds.push(item);
  }

  private confirmReleasedHold(item: Held): void {
    if (item.released?.done === false) {
      this.wait = item.released;
      return;
    }
    if (item.released?.failure !== undefined) throw item.released.failure.cause;
    for (const resource of item.resources)
      if (resource.destructionFailure !== undefined)
        throw new MeshSourceResourceError({ reason: 'retirement' }, resource.destructionFailure);
    this.retiringHolds.shift();
    this.released++;
  }

  retireStep(): boolean {
    if (this.retirementFailure !== undefined) throw this.retirementFailure.cause;
    this.beginRetirement();
    this.wait = undefined;
    if (!this.retireViews()) return false;
    this.bindingPreparation?.release();
    this.bindingPreparation = undefined;
    if (!this.retireInputs()) return false;
    if (!this.retireCapacity()) return false;
    try {
      const held = this.held[0];
      if (held !== undefined) {
        // Each allocation's lifetime retains its exact submitted work. Issue
        // one release per step while other allocations settle independently.
        this.releaseHold(held);
        return false;
      }
      const retiring = this.retiringHolds[0];
      if (retiring !== undefined) {
        this.confirmReleasedHold(retiring);
        return false;
      }
      this.inputs = undefined;
      this.phase = 'retired';
      return true;
    } catch (cause) {
      this.retirementFailure = { cause };
      throw cause;
    }
  }
}
