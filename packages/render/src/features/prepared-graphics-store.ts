import type { TextureFormat } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { DeviceScope, LifecycleResourceSpec } from '../device/device-scope';
import { type RenderError, RenderFeaturePreparationFailedError } from '../errors/render';
import type {
  PreparedGraphicsValidationProjection,
  PreparedKind,
  RenderFeatureBindingsDescriptor,
  RenderFeatureGraphicsPassDescriptor,
  RenderFeatureIndexDataDescriptor,
  RenderFeaturePipelineDescriptor,
  RenderFeaturePreparedGraphicsState,
  RenderFeaturePreparedRef,
  RenderFeatureVertexDataDescriptor,
} from './prepared-graphics';
import {
  RENDER_FEATURE_VERTEX_LAYOUTS,
  validateOwnedRenderFeatureGraphicsPass,
} from './prepared-graphics';
import type { RenderFeatureTargetHandle } from './targets';

export type PreparedGraphicsKind = Exclude<PreparedKind, 'attachment'>;

const PARTICLE_MATERIAL_INPUT_LAYOUTS: ReadonlySet<string> = new Set([
  RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInputInstance,
  RENDER_FEATURE_VERTEX_LAYOUTS.topologySegmentMaterialInputInstance,
  RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInputInstance,
]);

export type PreparedGraphicsRequestByKind = {
  pipeline: RenderFeaturePipelineDescriptor;
  bindings: RenderFeatureBindingsDescriptor;
  'vertex-data': RenderFeatureVertexDataDescriptor;
  'index-data': RenderFeatureIndexDataDescriptor;
};

type PreparedGraphicsSignature = { readonly signature: string };

export type PreparedGraphicsNormalizedDescriptor =
  | (RenderFeaturePipelineDescriptor & { readonly kind: 'pipeline' })
  | (RenderFeatureBindingsDescriptor & { readonly kind: 'bindings' })
  | {
      readonly kind: 'vertex-data';
      readonly layout: string;
      readonly data?: readonly number[];
      readonly buffer?: import('./prepared-gpu-work').RenderFeatureGpuBufferRef;
    }
  | {
      readonly kind: 'index-data';
      readonly format: 'uint16' | 'uint32';
      readonly data?: readonly number[];
      readonly buffer?: import('./prepared-gpu-work').RenderFeatureGpuBufferRef;
    };

export interface PreparedGraphicsItem<Kind extends PreparedGraphicsKind = PreparedGraphicsKind> {
  readonly featureIdentity: string;
  readonly generation: number;
  readonly kind: Kind;
  readonly name: string;
  readonly signature: string;
  readonly reference: RenderFeaturePreparedRef<Kind>;
  readonly descriptor?: PreparedGraphicsNormalizedDescriptor;
  readonly uploadBytes?: readonly number[];
}

export interface PreparedGraphicsStoreSnapshot {
  readonly generation: number;
  readonly items: readonly PreparedGraphicsItem[];
}

export interface PreparedGraphicsTransaction {
  readonly featureIdentity: string;
  readonly generation: number;
  prepare<Kind extends PreparedGraphicsKind>(
    kind: Kind,
    name: string,
    descriptor: PreparedGraphicsRequestByKind[Kind] | PreparedGraphicsSignature,
  ): Result<RenderFeaturePreparedRef<Kind>, RenderError>;
  retainResources(matches: (name: string) => boolean): void;
  committedItems(): readonly PreparedGraphicsItem[];
  overlayItems(): readonly PreparedGraphicsItem[];
  lookup(reference: RenderFeaturePreparedRef): PreparedGraphicsItem | undefined;
  owns(reference: RenderFeaturePreparedRef): boolean;
  graphicsState(
    capabilityAvailable: boolean,
    attachments: readonly {
      readonly resource: string | RenderFeatureTargetHandle;
      readonly format: TextureFormat;
    }[],
  ): RenderFeaturePreparedGraphicsState;
  validateGraphicsPass(
    descriptor: RenderFeatureGraphicsPassDescriptor,
    capabilityAvailable: boolean,
    attachments: RenderFeaturePreparedGraphicsState['attachments'],
  ): Result<RenderFeaturePreparedGraphicsState, RenderError>;
  commit(): Result<PreparedGraphicsStoreSnapshot, RenderError>;
  abort(): void;
}

export interface PreparedGraphicsStore {
  beginFrame(featureIdentity: string, generation: number): PreparedGraphicsTransaction;
  snapshot(featureIdentity: string): PreparedGraphicsStoreSnapshot;
  invalidate(featureIdentity: string, generation: number): void;
  createRecoveryRoot(scope: DeviceScope): LifecycleResourceSpec<unknown>;
}

interface Slot {
  readonly generation: number;
  readonly items: Map<string, PreparedGraphicsItem>;
}

function itemKey(kind: PreparedGraphicsKind, name: string): string {
  return `${kind}:${name}`;
}

function preparationFailure(
  featureIdentity: string,
  generation: number,
  kind: PreparedGraphicsKind,
  name: string,
  reason: string,
): RenderFeaturePreparationFailedError {
  return new RenderFeaturePreparationFailedError(
    featureIdentity,
    generation,
    'prepare-graphics-resource',
    kind,
    name,
    reason,
    'next-frame',
  );
}

function numericViewValues(value: ArrayBufferView): readonly number[] {
  if (value instanceof Float32Array) return Array.from(value);
  if (value instanceof Float64Array) return Array.from(value);
  if (value instanceof Int8Array) return Array.from(value);
  if (value instanceof Uint8Array) return Array.from(value);
  if (value instanceof Uint8ClampedArray) return Array.from(value);
  if (value instanceof Int16Array) return Array.from(value);
  if (value instanceof Uint16Array) return Array.from(value);
  if (value instanceof Int32Array) return Array.from(value);
  if (value instanceof Uint32Array) return Array.from(value);
  if (value instanceof BigInt64Array) return Array.from(value, Number);
  if (value instanceof BigUint64Array) return Array.from(value, Number);
  return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

function immutableValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableValue));
  if (ArrayBuffer.isView(value)) {
    return Object.freeze(numericViewValues(value));
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.freeze(
      Object.fromEntries(
        Object.entries(source).map(([key, entry]) => [key, immutableValue(entry)]),
      ),
    );
  }
  return value;
}

function valuesOf(data: ArrayBufferView | readonly number[]): readonly number[] {
  return Object.freeze(ArrayBuffer.isView(data) ? numericViewValues(data) : [...data]);
}

function uploadBytes(
  data: ArrayBufferView | readonly number[],
  kind: PreparedGraphicsKind,
): readonly number[] {
  if (ArrayBuffer.isView(data)) {
    const bytes = new Uint8Array(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    );
    return Object.freeze(Array.from(bytes));
  }
  const view = kind === 'index-data' ? new Uint16Array(data) : new Float32Array(data);
  return Object.freeze(Array.from(new Uint8Array(view.buffer)));
}

function normalizeDescriptor(
  kind: PreparedGraphicsKind,
  request: PreparedGraphicsRequestByKind[PreparedGraphicsKind] | PreparedGraphicsSignature,
): {
  descriptor: PreparedGraphicsNormalizedDescriptor | undefined;
  signature: string;
  uploadBytes: readonly number[] | undefined;
} {
  if ('signature' in request) {
    return {
      descriptor: undefined,
      signature: request.signature,
      uploadBytes: undefined,
    };
  }
  let descriptor: PreparedGraphicsNormalizedDescriptor;
  let bytes: readonly number[] | undefined;
  switch (kind) {
    case 'pipeline': {
      const pipeline = request as RenderFeaturePipelineDescriptor;
      descriptor = Object.freeze({
        kind,
        shader: pipeline.shader,
        ...(pipeline.preparePipelines === undefined
          ? {}
          : { preparePipelines: pipeline.preparePipelines }),
        vertexLayout: pipeline.vertexLayout,
        ...(pipeline.particleInputLanes === undefined
          ? {}
          : { particleInputLanes: pipeline.particleInputLanes }),
        colorFormats: Object.freeze([...pipeline.colorFormats]),
        ...(pipeline.depthFormat === undefined ? {} : { depthFormat: pipeline.depthFormat }),
        ...(pipeline.sampleCount === undefined ? {} : { sampleCount: pipeline.sampleCount }),
        ...(pipeline.topology === undefined ? {} : { topology: pipeline.topology }),
        ...(pipeline.indexFormat === undefined ? {} : { indexFormat: pipeline.indexFormat }),
        ...(pipeline.renderState === undefined
          ? {}
          : {
              renderState: immutableValue(pipeline.renderState) as NonNullable<
                RenderFeaturePipelineDescriptor['renderState']
              >,
            }),
      });
      break;
    }
    case 'bindings': {
      const bindings = request as RenderFeatureBindingsDescriptor;
      descriptor = Object.freeze({
        kind,
        pipeline: bindings.pipeline,
        values: immutableValue(bindings.values) as Readonly<Record<string, unknown>>,
      });
      break;
    }
    case 'vertex-data': {
      const vertexData = request as RenderFeatureVertexDataDescriptor;
      descriptor = Object.freeze({
        kind,
        layout: vertexData.layout,
        ...('buffer' in vertexData && vertexData.buffer !== undefined
          ? { buffer: vertexData.buffer }
          : { data: valuesOf(vertexData.data) }),
      });
      if ('data' in vertexData && vertexData.data !== undefined) {
        bytes = uploadBytes(vertexData.data, kind);
      }
      break;
    }
    case 'index-data': {
      const indexData = request as RenderFeatureIndexDataDescriptor;
      descriptor = Object.freeze({
        kind,
        format: indexData.format,
        ...('buffer' in indexData && indexData.buffer !== undefined
          ? { buffer: indexData.buffer }
          : { data: valuesOf(indexData.data) }),
      });
      if ('data' in indexData && indexData.data !== undefined) {
        bytes = uploadBytes(indexData.data, kind);
      }
      break;
    }
  }
  return {
    descriptor,
    signature: JSON.stringify(descriptor),
    uploadBytes: bytes,
  };
}

class PreparedGraphicsTransactionImpl implements PreparedGraphicsTransaction {
  private aborted = false;
  private committed = false;
  private readonly overlay = new Map<string, PreparedGraphicsItem>();
  private readonly touchedCommitted = new Set<string>();
  private projection: PreparedGraphicsValidationProjection | undefined;

  constructor(
    private readonly store: PreparedGraphicsStoreImpl,
    readonly featureIdentity: string,
    readonly generation: number,
    private readonly committedSlot: Slot | undefined,
  ) {}

  prepare<Kind extends PreparedGraphicsKind>(
    kind: Kind,
    name: string,
    request: PreparedGraphicsRequestByKind[Kind] | PreparedGraphicsSignature,
  ): Result<RenderFeaturePreparedRef<Kind>, RenderError> {
    if (kind === 'pipeline' && !('signature' in request)) {
      const pipeline = request as RenderFeaturePipelineDescriptor;
      const lanes = pipeline.particleInputLanes;
      const usesParticleMaterialInputs = PARTICLE_MATERIAL_INPUT_LAYOUTS.has(pipeline.vertexLayout);
      const validLanes =
        typeof lanes === 'number' && Number.isInteger(lanes) && lanes >= 1 && lanes <= 4;
      if (
        (usesParticleMaterialInputs && !validLanes) ||
        (!usesParticleMaterialInputs && lanes !== undefined)
      ) {
        return err(
          preparationFailure(
            this.featureIdentity,
            this.generation,
            kind,
            name,
            'particle-input-lanes-require-material-input-layout-and-1-through-4-lanes',
          ),
        );
      }
    }
    const normalized = normalizeDescriptor(kind, request);
    if (this.aborted || this.committed || name.length === 0 || normalized.signature.length === 0) {
      return err(
        preparationFailure(
          this.featureIdentity,
          this.generation,
          kind,
          name,
          'transaction-is-not-preparable',
        ),
      );
    }
    const key = itemKey(kind, name);
    const committed = this.committedSlot?.items.get(key);
    const sameReferences = (item: PreparedGraphicsItem): boolean => {
      const previous = item.descriptor;
      const next = normalized.descriptor;
      if (previous?.kind === 'bindings' && next?.kind === 'bindings')
        return previous.pipeline === next.pipeline;
      if (
        (previous?.kind === 'vertex-data' && next?.kind === 'vertex-data') ||
        (previous?.kind === 'index-data' && next?.kind === 'index-data')
      )
        return previous.buffer === next.buffer;
      return true;
    };
    if (
      committed !== undefined &&
      committed.signature === normalized.signature &&
      sameReferences(committed)
    ) {
      this.touchedCommitted.add(key);
      return ok(committed.reference as RenderFeaturePreparedRef<Kind>);
    }
    const existing = this.overlay.get(key);
    if (existing !== undefined) {
      if (existing.signature !== normalized.signature || !sameReferences(existing)) {
        return err(
          preparationFailure(
            this.featureIdentity,
            this.generation,
            kind,
            name,
            'duplicate-prepared-signature',
          ),
        );
      }
      return ok(existing.reference as RenderFeaturePreparedRef<Kind>);
    }
    const reference = Object.freeze({
      kind,
      generation: this.generation,
    }) as RenderFeaturePreparedRef<Kind>;
    const item: PreparedGraphicsItem<Kind> = {
      featureIdentity: this.featureIdentity,
      generation: this.generation,
      kind,
      name,
      signature: normalized.signature,
      reference,
      ...(normalized.descriptor === undefined ? {} : { descriptor: normalized.descriptor }),
      ...(normalized.uploadBytes === undefined ? {} : { uploadBytes: normalized.uploadBytes }),
    };
    this.store.registerReference(reference, item);
    this.overlay.set(key, item);
    return ok(reference);
  }

  retainResources(matches: (name: string) => boolean): void {
    const retain = (item: PreparedGraphicsItem): void => {
      const key = itemKey(item.kind, item.name);
      if (this.touchedCommitted.has(key)) return;
      this.touchedCommitted.add(key);
      if (item.descriptor?.kind === 'bindings') {
        const pipeline = this.store.itemFor(item.descriptor.pipeline);
        if (pipeline !== undefined) retain(pipeline);
      }
    };
    for (const item of this.committedSlot?.items.values() ?? []) {
      if (matches(item.name)) retain(item);
    }
  }

  committedItems(): readonly PreparedGraphicsItem[] {
    return Object.freeze(
      [...this.touchedCommitted].flatMap((key) => {
        const item = this.committedSlot?.items.get(key);
        return item === undefined ? [] : [item];
      }),
    );
  }

  overlayItems(): readonly PreparedGraphicsItem[] {
    return Object.freeze([...this.overlay.values()]);
  }

  lookup(reference: RenderFeaturePreparedRef): PreparedGraphicsItem | undefined {
    // Reuse the store's reference authority. A reference alone is insufficient:
    // this transaction must have touched its captured slot or own its overlay.
    // Captured slots remain valid for held frames even after a later publication.
    const item = this.store.itemFor(reference);
    if (
      item?.featureIdentity === this.featureIdentity &&
      item.generation === this.generation &&
      ((this.touchedCommitted.has(itemKey(item.kind, item.name)) &&
        this.committedSlot?.items.get(itemKey(item.kind, item.name)) === item) ||
        this.overlay.get(itemKey(item.kind, item.name)) === item)
    )
      return item;
    return undefined;
  }

  owns(reference: RenderFeaturePreparedRef): boolean {
    return this.lookup(reference) !== undefined;
  }

  graphicsState(
    capabilityAvailable: boolean,
    attachments: readonly {
      readonly resource: string | RenderFeatureTargetHandle;
      readonly format: TextureFormat;
    }[],
  ): RenderFeaturePreparedGraphicsState {
    const projection = this.preparedProjection();
    return {
      capabilityAvailable,
      generation: this.generation,
      attachments,
      pipeline: projection.pipelines[0],
      pipelines: projection.pipelines,
      bindings: projection.bindings,
      vertexData: projection.vertexData,
      indexData: projection.indexData,
    };
  }

  validateGraphicsPass(
    descriptor: RenderFeatureGraphicsPassDescriptor,
    capabilityAvailable: boolean,
    attachments: RenderFeaturePreparedGraphicsState['attachments'],
  ): Result<RenderFeaturePreparedGraphicsState, RenderError> {
    const state = this.graphicsState(capabilityAvailable, attachments);
    const validated = validateOwnedRenderFeatureGraphicsPass(
      this.featureIdentity,
      descriptor,
      state,
      this.preparedProjection(),
    );
    return validated.ok ? ok(state) : validated;
  }

  private preparedProjection(): PreparedGraphicsValidationProjection {
    if (this.projection?.isCurrent()) return this.projection;
    const committedSize = this.touchedCommitted.size;
    const overlaySize = this.overlay.size;
    const pipelines: RenderFeaturePreparedRef[] = [];
    const bindings: RenderFeaturePreparedRef[] = [];
    const vertexData: RenderFeaturePreparedRef[] = [];
    const indexData: RenderFeaturePreparedRef[] = [];
    let validReferences = true;
    const columns = {
      pipeline: pipelines,
      bindings,
      'vertex-data': vertexData,
      'index-data': indexData,
    };
    const append = (item: PreparedGraphicsItem): void => {
      columns[item.kind]?.push(item.reference);
      if (item.reference.kind !== item.kind || item.reference.generation !== this.generation)
        validReferences = false;
    };
    // Captured committed slots are immutable publications. Touched keys only
    // grow; overlay rows only grow until abort clears them and prevents prepare.
    // The two existing cardinalities separately fence the exact row set; a sum
    // would miss abort followed by an equal number of committed retains.
    for (const key of this.touchedCommitted) {
      const item = this.committedSlot?.items.get(key);
      if (item !== undefined) append(item);
    }
    for (const item of this.overlay.values()) append(item);
    const projection: PreparedGraphicsValidationProjection = {
      generation: this.generation,
      pipelines: Object.freeze(pipelines),
      bindings: Object.freeze(bindings),
      vertexData: Object.freeze(vertexData),
      indexData: Object.freeze(indexData),
      validReferences,
      isCurrent: () =>
        this.touchedCommitted.size === committedSize && this.overlay.size === overlaySize,
      owns: (reference) => this.owns(reference),
    };
    this.projection = projection;
    return projection;
  }

  commit(): Result<PreparedGraphicsStoreSnapshot, RenderError> {
    if (this.aborted || this.committed) {
      return err(
        preparationFailure(
          this.featureIdentity,
          this.generation,
          'pipeline',
          'transaction',
          'transaction-already-closed',
        ),
      );
    }
    this.committed = true;
    return ok(
      this.store.commit(this.featureIdentity, this.generation, this.committedItems(), this.overlay),
    );
  }

  abort(): void {
    if (this.committed) return;
    this.aborted = true;
    this.overlay.clear();
    // Do not retain overlay refs through an aborted transaction's memo.
    // Previously returned immutable states retain only their own publications.
    this.projection = undefined;
  }
}

class PreparedGraphicsStoreImpl implements PreparedGraphicsStore {
  private readonly slots = new Map<string, Slot>();
  private readonly references = new WeakMap<object, PreparedGraphicsItem>();

  beginFrame(featureIdentity: string, generation: number): PreparedGraphicsTransaction {
    const slot = this.slots.get(featureIdentity);
    const committedSlot = slot?.generation === generation ? slot : undefined;
    return new PreparedGraphicsTransactionImpl(this, featureIdentity, generation, committedSlot);
  }

  snapshot(featureIdentity: string): PreparedGraphicsStoreSnapshot {
    const slot = this.slots.get(featureIdentity);
    return {
      generation: slot?.generation ?? -1,
      items: Object.freeze([...(slot?.items.values() ?? [])]),
    };
  }

  invalidate(featureIdentity: string, generation: number): void {
    const slot = this.slots.get(featureIdentity);
    if (slot !== undefined && slot.generation < generation) {
      this.slots.delete(featureIdentity);
    }
  }

  createRecoveryRoot(scope: DeviceScope): LifecycleResourceSpec<unknown> {
    return {
      kind: 'buffer',
      create: () => {
        if (!scope.isAlive()) throw new Error('Prepared graphics candidate scope is not active.');
        const itemCount = [...this.slots.values()].reduce(
          (count, slot) => count + slot.items.size,
          0,
        );
        return Object.freeze({ generation: scope.generation, itemCount });
      },
      cleanup: () => undefined,
    };
  }

  registerReference(reference: object, item: PreparedGraphicsItem): void {
    this.references.set(reference, item);
  }

  itemFor(reference: object): PreparedGraphicsItem | undefined {
    return this.references.get(reference);
  }

  commit(
    featureIdentity: string,
    generation: number,
    activeCommitted: readonly PreparedGraphicsItem[],
    overlay: ReadonlyMap<string, PreparedGraphicsItem>,
  ): PreparedGraphicsStoreSnapshot {
    const items = new Map<string, PreparedGraphicsItem>();
    for (const item of activeCommitted) items.set(itemKey(item.kind, item.name), item);
    for (const [key, item] of overlay) items.set(key, item);
    const slot: Slot = { generation, items };
    this.slots.set(featureIdentity, slot);
    return {
      generation,
      items: Object.freeze([...items.values()]),
    };
  }
}

export function createPreparedGraphicsStore(): PreparedGraphicsStore {
  return new PreparedGraphicsStoreImpl();
}
