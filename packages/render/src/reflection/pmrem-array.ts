import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import type {
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import { ok, type Result, textureFormatBlock } from '@forgeax/engine-types';
import { createPmremAtlas, type PmremAtlas, pmremExtent } from '../ibl/pmrem';
import type { RenderPipelineFrame } from '../render-pipeline';

/** One immutable physical generation. A layer view is also the ordinary Forward PMREM input. */
export interface PmremArrayLayer extends PmremAtlas {
  readonly classKey: string;
  readonly arrayView: TextureView;
  readonly baseArrayLayer: number;
  readonly arrayLayerCount: number;
  readonly generation: number;
}

export interface PmremArrayLease {
  readonly classKey: string;
  readonly key: string;
  readonly layer: number;
}

interface Storage {
  readonly texture: Texture;
  readonly view: TextureView;
  readonly capacity: number;
  readonly generation: number;
  readonly bytes: number;
  readonly layers: Map<number, PmremArrayLayer>;
}

interface ClassState {
  readonly key: string;
  readonly size: number;
  readonly format: TextureFormat;
  readonly layerBytes: number;
  readonly scratch: PmremAtlas;
  readonly leases: Map<string, PmremArrayLease>;
  current: Storage;
  growth?: { readonly ticket: PmremArrayMigration; inFlight: boolean };
}

export interface PmremArrayMigration {
  readonly key: string;
  readonly size: number;
  readonly format: TextureFormat;
  readonly source: Storage;
  readonly target: Storage;
  readonly layers: readonly number[];
}

export interface PmremArrayPoolInspection {
  readonly activeBytes: number;
  readonly migrationBytes: number;
  readonly retiringBytes: number;
  readonly scratchBytes: number;
  readonly totalBytes: number;
  readonly classes: readonly {
    readonly key: string;
    readonly size: number;
    readonly capacity: number;
    readonly leasedLayers: number;
    readonly generation: number;
    readonly pendingGrowth: boolean;
  }[];
  readonly admissionFailure?: 'byte-budget' | 'layer-limit' | 'native-resource-failed';
}

/** Physical arrays, bounded scratch and migration remain with the existing probe producer. */
export class PmremArrayPool {
  private readonly classes = new Map<string, ClassState>();
  private readonly retiring = new Set<Pick<Storage, 'texture' | 'bytes'>>();
  private disposed = false;
  private nextGeneration = 1;
  private admissionFailure: PmremArrayPoolInspection['admissionFailure'];

  constructor(
    private readonly device: RhiDevice,
    private readonly onError: (error: RhiError) => void,
  ) {}

  inspect(): PmremArrayPoolInspection {
    let activeBytes = 0,
      migrationBytes = 0,
      scratchBytes = 0,
      retiringBytes = 0;
    for (const state of this.classes.values()) {
      activeBytes += state.current.bytes;
      migrationBytes += state.growth?.ticket.target.bytes ?? 0;
      scratchBytes += state.layerBytes;
    }
    for (const storage of this.retiring) retiringBytes += storage.bytes;
    return {
      activeBytes,
      migrationBytes,
      retiringBytes,
      scratchBytes,
      totalBytes: activeBytes + migrationBytes + retiringBytes + scratchBytes,
      classes: [...this.classes.values()].map((state) => ({
        key: state.key,
        size: state.size,
        capacity: state.current.capacity,
        leasedLayers: state.leases.size,
        generation: state.current.generation,
        pendingGrowth: state.growth !== undefined,
      })),
      ...(this.admissionFailure === undefined ? {} : { admissionFailure: this.admissionFailure }),
    };
  }

  acquire(
    key: string,
    size: number,
    format: TextureFormat,
    capacity: number,
    budgetBytes: number,
  ): PmremArrayLease | undefined {
    if (this.disposed) return undefined;
    const classKey = `${format}:${size}`;
    let state = this.classes.get(classKey);
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      capacity > this.device.limits.maxTextureArrayLayers
    ) {
      this.admissionFailure = 'layer-limit';
      return undefined;
    }
    const extent = pmremExtent(size);
    const layerBytes = extent.width * extent.height * textureFormatBlock(format).bytesPerBlock;
    if (state === undefined) {
      if (this.inspect().totalBytes + layerBytes * (capacity + 1) > budgetBytes) {
        this.admissionFailure = 'byte-budget';
        return undefined;
      }
      const current = this.createStorage(
        classKey,
        size,
        format,
        capacity,
        this.nextGeneration++,
        layerBytes,
      );
      if (current === undefined) return undefined;
      const scratch = createPmremAtlas(
        this.device,
        `reflection-pmrem.${classKey}.scratch`,
        size,
        format,
      );
      if (!scratch.ok) {
        this.destroy(current);
        this.onError(scratch.error);
        this.admissionFailure = 'native-resource-failed';
        return undefined;
      }
      state = {
        key: classKey,
        size,
        format,
        layerBytes,
        scratch: scratch.value,
        leases: new Map(),
        current,
      };
      this.classes.set(classKey, state);
    }
    if (capacity > state.current.capacity && state.growth === undefined) {
      // Old, new, scratch and not-yet-retired arrays all count during growth.
      if (this.inspect().totalBytes + layerBytes * capacity > budgetBytes) {
        this.admissionFailure = 'byte-budget';
        return undefined;
      }
      const target = this.createStorage(
        classKey,
        size,
        format,
        capacity,
        this.nextGeneration++,
        layerBytes,
      );
      if (target === undefined) return undefined;
      state.growth = {
        inFlight: false,
        ticket: {
          key: classKey,
          size,
          format,
          source: state.current,
          target,
          layers: Object.freeze([...state.leases.values()].map((lease) => lease.layer)),
        },
      };
    }
    // Freeze writes while an immutable old generation is copied. Sampling keeps its LKG.
    if (state.growth !== undefined) return undefined;
    const existing = state.leases.get(key);
    if (existing !== undefined) return existing;
    const occupied = new Set([...state.leases.values()].map((lease) => lease.layer));
    let layer = 0;
    while (occupied.has(layer)) layer++;
    if (layer >= state.current.capacity) return undefined;
    const lease = Object.freeze({ classKey, key, layer });
    state.leases.set(key, lease);
    this.admissionFailure = undefined;
    return lease;
  }

  snapshot(lease: PmremArrayLease): PmremArrayLayer | undefined {
    const state = this.classes.get(lease.classKey);
    if (state?.leases.get(lease.key) !== lease) return undefined;
    const storage = state.current;
    let layer = storage.layers.get(lease.layer);
    if (layer !== undefined) return layer;
    const view = this.device.createTextureView(storage.texture, {
      dimension: '2d',
      baseArrayLayer: lease.layer,
      arrayLayerCount: 1,
      label: `reflection-pmrem.${lease.classKey}.${storage.generation}.layer-${lease.layer}`,
    });
    if (!view.ok) {
      this.onError(view.error);
      return undefined;
    }
    layer = Object.freeze({
      texture: storage.texture,
      view: view.value,
      size: state.size,
      classKey: state.key,
      arrayView: storage.view,
      baseArrayLayer: lease.layer,
      arrayLayerCount: storage.capacity,
      generation: storage.generation,
    });
    storage.layers.set(lease.layer, layer);
    return layer;
  }

  scratch(lease: PmremArrayLease): PmremAtlas | undefined {
    return this.classes.get(lease.classKey)?.scratch;
  }
  canWrite(lease: PmremArrayLease): boolean {
    const state = this.classes.get(lease.classKey);
    return state?.growth === undefined && state?.leases.get(lease.key) === lease;
  }
  release(lease: PmremArrayLease): void {
    const state = this.classes.get(lease.classKey);
    if (state?.leases.get(lease.key) === lease) state.leases.delete(lease.key);
  }

  takeMigrations(): readonly PmremArrayMigration[] {
    const tickets: PmremArrayMigration[] = [];
    for (const state of this.classes.values()) {
      if (state.growth === undefined || state.growth.inFlight) continue;
      state.growth.inFlight = true;
      tickets.push(state.growth.ticket);
    }
    return tickets;
  }

  complete(migration: PmremArrayMigration, submitted: boolean): void {
    const state = this.classes.get(migration.key);
    if (state?.growth?.ticket !== migration) return;
    if (!submitted) {
      state.growth.inFlight = false;
      return;
    }
    state.current = migration.target;
    delete state.growth;
    this.retire(migration.source);
  }

  prune(): void {
    for (const [key, state] of this.classes) {
      if (state.leases.size !== 0) continue;
      this.classes.delete(key);
      this.retire(state.current);
      if (state.growth !== undefined) this.retire(state.growth.ticket.target);
      this.retire({ texture: state.scratch.texture, bytes: state.layerBytes });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.classes.values()) {
      this.destroy(state.current);
      if (state.growth !== undefined) this.destroy(state.growth.ticket.target);
      this.destroy({ texture: state.scratch.texture, bytes: state.layerBytes });
    }
    for (const storage of this.retiring) this.destroy(storage);
    this.retiring.clear();
    this.classes.clear();
  }

  private createStorage(
    key: string,
    size: number,
    format: TextureFormat,
    capacity: number,
    generation: number,
    layerBytes: number,
  ): Storage | undefined {
    const texture = this.device.createTexture({
      label: `reflection-pmrem.${key}.${generation}`,
      format,
      size: { ...pmremExtent(size), depthOrArrayLayers: capacity },
      textureBindingViewDimension: '2d-array',
      usage: 0x17,
    });
    if (!texture.ok) {
      this.onError(texture.error);
      this.admissionFailure = 'native-resource-failed';
      return undefined;
    }
    const view = this.device.createTextureView(texture.value, {
      dimension: '2d-array',
      arrayLayerCount: capacity,
    });
    if (!view.ok) {
      this.destroy({ texture: texture.value, bytes: capacity * layerBytes });
      this.onError(view.error);
      this.admissionFailure = 'native-resource-failed';
      return undefined;
    }
    return {
      texture: texture.value,
      view: view.value,
      capacity,
      generation,
      bytes: capacity * layerBytes,
      layers: new Map(),
    };
  }
  private retire(storage: Pick<Storage, 'texture' | 'bytes'>): void {
    this.retiring.add(storage);
    const release = () => {
      if (this.retiring.has(storage) && this.destroy(storage)) this.retiring.delete(storage);
    };
    void this.device.queue.onSubmittedWorkDone().then(release, release);
  }
  private destroy(storage: Pick<Storage, 'texture' | 'bytes'>): boolean {
    const result = this.device.destroyTexture(storage.texture);
    if (result.ok) return true;
    this.retiring.add(storage);
    this.admissionFailure = 'native-resource-failed';
    this.onError(result.error);
    return false;
  }
}

export function pmremMigrationName(migration: PmremArrayMigration): string {
  return `reflection-pmrem.${migration.key}.migrate-${migration.target.generation}`;
}

/** Only the migration ticket's live layers move to the new physical array. */
export function copyPmremLayers(
  encoder: RhiCommandEncoder,
  migration: PmremArrayMigration,
  source: Texture,
  target: Texture,
): void {
  const size = { ...pmremExtent(migration.size), depthOrArrayLayers: 1 };
  for (const layer of migration.layers)
    encoder.copyTextureToTexture(
      { texture: source, origin: [0, 0, layer] },
      { texture: target, origin: [0, 0, layer] },
      size,
    );
}

/** GPU copies share the physical frame encoder; no readback or detached submission. */
export function addPmremArrayMigrations(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  migrations: readonly PmremArrayMigration[],
): Result<void, RenderGraphError> {
  for (const migration of migrations) {
    const targets = [migration.source, migration.target].map((storage, index) =>
      graph.importTexture(
        `reflection-pmrem.${migration.key}.migration-${migration.target.generation}-${index}`,
        {
          format: migration.format,
          size: { ...pmremExtent(migration.size), depthOrArrayLayers: storage.capacity },
          usage: 0x17,
        },
        () => storage.texture,
      ),
    );
    const source = targets[0],
      target = targets[1];
    if (source === undefined || target === undefined)
      throw new Error('PMREM migration requires source and target');
    if (!source.ok) return source;
    if (!target.ok) return target;
    const sourceView = graph.importView(
      source.value,
      { dimension: '2d-array', arrayLayerCount: migration.source.capacity },
      () => migration.source.view,
    );
    const targetView = graph.importView(
      target.value,
      { dimension: '2d-array', arrayLayerCount: migration.target.capacity },
      () => migration.target.view,
    );
    if (!sourceView.ok) return sourceView;
    if (!targetView.ok) return targetView;
    const added = graph.addCopyPass(pmremMigrationName(migration), {
      accesses: [
        { resource: sourceView.value, usage: 'copy-src' },
        { resource: targetView.value, usage: 'copy-dst' },
      ],
      encodeDirect: (encoder, _frame, resources) => {
        copyPmremLayers(
          encoder,
          migration,
          resources.texture(source.value).unwrap(),
          resources.texture(target.value).unwrap(),
        );
      },
    });
    if (!added.ok) return added;
  }
  return ok(undefined);
}
