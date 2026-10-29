import type { TextureFormat } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
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
  createOwnedPreparedGraphicsState,
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
      readonly offset?: number;
      readonly size?: number;
    }
  | {
      readonly kind: 'index-data';
      readonly format: 'uint16' | 'uint32';
      readonly data?: readonly number[];
      readonly buffer?: import('./prepared-gpu-work').RenderFeatureGpuBufferRef;
      readonly offset?: number;
      readonly size?: number;
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
    native?: true,
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
}

interface Slot {
  readonly snapshot: PreparedGraphicsStoreSnapshot;
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
          ? {
              buffer: vertexData.buffer,
              ...(vertexData.offset === undefined ? {} : { offset: vertexData.offset }),
              ...(vertexData.size === undefined ? {} : { size: vertexData.size }),
            }
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
          ? {
              buffer: indexData.buffer,
              ...(indexData.offset === undefined ? {} : { offset: indexData.offset }),
              ...(indexData.size === undefined ? {} : { size: indexData.size }),
            }
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

/** Exact native input comparison against an already detached store publication.
 * The Host has consumed the Engine-owned work; borrowed/custom requests still
 * normalize and capture before comparison. No frame data or physical ref is
 * retained from the incoming request on this path. */
function isNativeDataRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (frozenNativeData.has(value)) return true;
  const keys = Reflect.ownKeys(value);
  for (let index = 0; index < keys.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, keys[index] as PropertyKey);
    if (descriptor === undefined || !('value' in descriptor)) return false;
  }
  return true;
}

/**
 * Deeply frozen plain data: a frozen ordinary object or array whose own
 * properties are all data properties holding primitives or verified nodes.
 * Such a node can never change, so verification happens once per node.
 */
const frozenNativeData = new WeakSet<object>();
function isFrozenNativeData(value: object): boolean {
  if (frozenNativeData.has(value)) return true;
  if (!Object.isFrozen(value) || ArrayBuffer.isView(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== (Array.isArray(value) ? Array.prototype : Object.prototype) &&
    !(prototype === null && !Array.isArray(value))
  )
    return false;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return false;
    const entry: unknown = descriptor.value;
    if (typeof entry === 'function' || typeof entry === 'symbol') return false;
    if (entry !== null && typeof entry === 'object' && !isFrozenNativeData(entry)) return false;
  }
  frozenNativeData.add(value);
  return true;
}

/**
 * The last immutable request node proven equal to a store-owned normalized node.
 * Both sides are deeply frozen, so the proof holds until either is replaced;
 * keys are store-owned nodes, so a retired item releases its entry.
 */
const provenNativeValues = new WeakMap<object, object>();

function sameNativeValue(previous: unknown, value: unknown): boolean {
  // Functions/toJSON and other non-JSON leaves keep their normalization path.
  if (value === null || typeof value !== 'object')
    return typeof value !== 'function' && typeof value !== 'symbol' && previous === value;
  if (
    previous !== null &&
    typeof previous === 'object' &&
    provenNativeValues.get(previous) === value
  )
    return true;
  if (!sameNativeNode(previous, value)) return false;
  if (previous !== null && typeof previous === 'object' && isFrozenNativeData(value))
    provenNativeValues.set(previous, value);
  return true;
}

function sameNativeNode(previous: unknown, value: object): boolean {
  // Typed views keep their original byte/iterator conversion and live reads.
  if (ArrayBuffer.isView(value)) return false;
  if (
    value === null ||
    typeof value !== 'object' ||
    previous === null ||
    typeof previous !== 'object'
  )
    return false;
  const array = Array.isArray(value);
  if (Array.isArray(previous) !== array) return false;
  if (
    array &&
    (Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getPrototypeOf(previous) !== Array.prototype)
  )
    return false;
  const left = previous as Record<PropertyKey, unknown>,
    right = value as Record<PropertyKey, unknown>;
  const keys = Reflect.ownKeys(left),
    nextKeys = Reflect.ownKeys(right);
  if (keys.length !== nextKeys.length) return false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === undefined || key !== nextKeys[i]) return false;
    if (array && key !== 'length') {
      // Array capture uses map or spread. An own iterator, constructor/species,
      // map override or extra property must keep that original conversion.
      const index = typeof key === 'string' ? Number(key) : NaN;
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        String(index) !== key ||
        index >= (value as unknown[]).length
      )
        return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(right, key);
    if (descriptor === undefined || !('value' in descriptor)) return false;
    const captured = array ? Object.getOwnPropertyDescriptor(left, key) : undefined;
    if (array && (captured === undefined || !('value' in captured))) return false;
    if (!sameNativeValue(array ? captured?.value : left[key], descriptor.value)) return false;
  }
  return true;
}

/** The last deeply frozen request proven to match one store item. */
const provenNativeRequests = new WeakMap<PreparedGraphicsItem, object>();

function matchesNativeRequest(
  item: PreparedGraphicsItem,
  kind: PreparedGraphicsKind,
  request: PreparedGraphicsRequestByKind[PreparedGraphicsKind] | PreparedGraphicsSignature,
): boolean {
  if (provenNativeRequests.get(item) === request) return true;
  if (!matchesNativeRequestContent(item, kind, request)) return false;
  if (isFrozenNativeData(request)) provenNativeRequests.set(item, request);
  return true;
}

function matchesNativeRequestContent(
  item: PreparedGraphicsItem,
  kind: PreparedGraphicsKind,
  request: PreparedGraphicsRequestByKind[PreparedGraphicsKind] | PreparedGraphicsSignature,
): boolean {
  if ('signature' in request || !isNativeDataRecord(request)) return false;
  const previous = item.descriptor;
  switch (kind) {
    case 'pipeline': {
      const next = request as RenderFeaturePipelineDescriptor;
      return (
        previous?.kind === kind &&
        previous.shader === next.shader &&
        previous.preparePipelines === next.preparePipelines &&
        previous.vertexLayout === next.vertexLayout &&
        previous.particleInputLanes === next.particleInputLanes &&
        sameNativeValue(previous.colorFormats, next.colorFormats) &&
        previous.depthFormat === next.depthFormat &&
        previous.sampleCount === next.sampleCount &&
        previous.topology === next.topology &&
        previous.indexFormat === next.indexFormat &&
        sameNativeValue(previous.renderState, next.renderState)
      );
    }
    case 'bindings': {
      const next = request as RenderFeatureBindingsDescriptor;
      return (
        previous?.kind === kind &&
        previous.pipeline === next.pipeline &&
        sameNativeValue(previous.values, next.values)
      );
    }
    case 'vertex-data': {
      const next = request as RenderFeatureVertexDataDescriptor;
      return (
        previous?.kind === kind &&
        'buffer' in next &&
        next.buffer !== undefined &&
        previous.buffer === next.buffer &&
        previous.layout === next.layout &&
        previous.offset === next.offset &&
        previous.size === next.size
      );
    }
    case 'index-data': {
      const next = request as RenderFeatureIndexDataDescriptor;
      return (
        previous?.kind === kind &&
        'buffer' in next &&
        next.buffer !== undefined &&
        previous.buffer === next.buffer &&
        previous.format === next.format &&
        previous.offset === next.offset &&
        previous.size === next.size
      );
    }
  }
}

const NO_ITEMS: readonly PreparedGraphicsItem[] = Object.freeze([]);
const NO_OVERLAY: ReadonlyMap<string, PreparedGraphicsItem> = new Map();
const NO_SNAPSHOT: PreparedGraphicsStoreSnapshot = Object.freeze({
  generation: -1,
  items: NO_ITEMS,
});

function sameItems(
  a: readonly PreparedGraphicsItem[],
  b: readonly PreparedGraphicsItem[],
): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

class PreparedGraphicsTransactionImpl implements PreparedGraphicsTransaction {
  private aborted = false;
  private committed = false;
  private overlay: Map<string, PreparedGraphicsItem> | undefined;
  private touchedCommitted: Set<string> | undefined;
  private projection:
    | {
        readonly value: PreparedGraphicsValidationProjection;
        readonly committedSize: number;
        readonly overlaySize: number;
      }
    | undefined;

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
    native?: true,
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
    if (native && !this.aborted && !this.committed && name.length > 0) {
      const key = itemKey(kind, name),
        committed = this.committedSlot?.items.get(key);
      if (committed !== undefined && matchesNativeRequest(committed, kind, request)) {
        this.touch(key);
        return ok(committed.reference as RenderFeaturePreparedRef<Kind>);
      }
      const existing = this.overlay?.get(key);
      if (existing !== undefined && matchesNativeRequest(existing, kind, request))
        return ok(existing.reference as RenderFeaturePreparedRef<Kind>);
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
      this.touch(key);
      return ok(committed.reference as RenderFeaturePreparedRef<Kind>);
    }
    const existing = this.overlay?.get(key);
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
    this.admitItem(key, item);
    return ok(reference);
  }

  /** An actual resource admission creates this frame's overlay and reference. */
  private admitItem(key: string, item: PreparedGraphicsItem): void {
    this.store.registerReference(item.reference, item);
    this.overlay ??= new Map();
    this.overlay.set(key, item);
  }

  retainResources(matches: (name: string) => boolean): void {
    const committed = this.committedSlot?.items;
    if (committed === undefined || committed.size === 0) return;
    const retain = (item: PreparedGraphicsItem): void => {
      const key = itemKey(item.kind, item.name);
      if (this.touchedCommitted?.has(key)) return;
      this.touch(key);
      if (item.descriptor?.kind === 'bindings') {
        const pipeline = this.store.itemFor(item.descriptor.pipeline);
        if (pipeline !== undefined) retain(pipeline);
      }
    };
    for (const item of committed.values()) if (matches(item.name)) retain(item);
  }

  private touch(key: string): void {
    this.touchedCommitted ??= new Set();
    this.touchedCommitted.add(key);
  }

  committedItems(): readonly PreparedGraphicsItem[] {
    if (this.touchedCommitted === undefined || this.touchedCommitted.size === 0) return NO_ITEMS;
    const items: PreparedGraphicsItem[] = [];
    for (const key of this.touchedCommitted) {
      const item = this.committedSlot?.items.get(key);
      if (item !== undefined) items.push(item);
    }
    return Object.freeze(items);
  }

  overlayItems(): readonly PreparedGraphicsItem[] {
    return this.overlay === undefined || this.overlay.size === 0
      ? NO_ITEMS
      : Object.freeze([...this.overlay.values()]);
  }

  lookup(reference: RenderFeaturePreparedRef): PreparedGraphicsItem | undefined {
    // Reuse the store's reference authority. A reference alone is insufficient:
    // this transaction must have touched its captured slot or own its overlay.
    // Captured slots remain valid for held frames even after a later publication.
    const item = this.store.itemFor(reference);
    if (
      item?.featureIdentity === this.featureIdentity &&
      item.generation === this.generation &&
      ((this.touchedCommitted?.has(itemKey(item.kind, item.name)) &&
        this.committedSlot?.items.get(itemKey(item.kind, item.name)) === item) ||
        this.overlay?.get(itemKey(item.kind, item.name)) === item)
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
    return createOwnedPreparedGraphicsState(
      capabilityAvailable,
      attachments,
      this.preparedProjection(),
    );
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
    const committedSize = this.touchedCommitted?.size ?? 0;
    const overlaySize = this.overlay?.size ?? 0;
    if (
      this.projection !== undefined &&
      committedSize === this.projection.committedSize &&
      overlaySize === this.projection.overlaySize
    )
      return this.projection.value;
    const pipelines: RenderFeaturePreparedRef[] = [];
    const bindings: RenderFeaturePreparedRef[] = [];
    const vertexData: RenderFeaturePreparedRef[] = [];
    const indexData: RenderFeaturePreparedRef[] = [];
    const references = new Set<RenderFeaturePreparedRef>();
    let validReferences = true;
    const columns = {
      pipeline: pipelines,
      bindings,
      'vertex-data': vertexData,
      'index-data': indexData,
    };
    const append = (item: PreparedGraphicsItem): void => {
      columns[item.kind]?.push(item.reference);
      references.add(item.reference);
      if (item.reference.kind !== item.kind || item.reference.generation !== this.generation)
        validReferences = false;
    };
    // Captured committed slots are immutable publications. Touched keys only
    // grow; overlay rows only grow until abort clears them and prevents prepare.
    // The two existing cardinalities separately fence the exact row set; a sum
    // would miss abort followed by an equal number of committed retains.
    if (this.touchedCommitted !== undefined)
      for (const key of this.touchedCommitted) {
        const item = this.committedSlot?.items.get(key);
        if (item !== undefined) append(item);
      }
    if (this.overlay !== undefined) for (const item of this.overlay.values()) append(item);
    const projection: PreparedGraphicsValidationProjection = {
      generation: this.generation,
      pipelines: Object.freeze(pipelines),
      bindings: Object.freeze(bindings),
      vertexData: Object.freeze(vertexData),
      indexData: Object.freeze(indexData),
      validReferences,
      owns: (reference) => references.has(reference),
    };
    this.projection = { value: projection, committedSize, overlaySize };
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
      this.store.commit(
        this.featureIdentity,
        this.generation,
        this.committedItems(),
        this.overlay ?? NO_OVERLAY,
      ),
    );
  }

  abort(): void {
    if (this.committed) return;
    this.aborted = true;
    this.overlay?.clear();
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
    const committedSlot = slot?.snapshot.generation === generation ? slot : undefined;
    return new PreparedGraphicsTransactionImpl(this, featureIdentity, generation, committedSlot);
  }

  snapshot(featureIdentity: string): PreparedGraphicsStoreSnapshot {
    return this.slots.get(featureIdentity)?.snapshot ?? NO_SNAPSHOT;
  }

  invalidate(featureIdentity: string, generation: number): void {
    const slot = this.slots.get(featureIdentity);
    if (slot !== undefined && slot.snapshot.generation < generation) {
      this.slots.delete(featureIdentity);
    }
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
    // This commit owns already-admitted items. An unchanged commit keeps the
    // slot's authoritative publication; reads do not validate a second cache.
    const previous = this.slots.get(featureIdentity);
    if (
      previous?.snapshot.generation === generation &&
      overlay.size === 0 &&
      sameItems(previous.snapshot.items, activeCommitted)
    )
      return previous.snapshot;
    const items = new Map<string, PreparedGraphicsItem>();
    for (const item of activeCommitted) items.set(itemKey(item.kind, item.name), item);
    for (const [key, item] of overlay) items.set(key, item);
    const snapshot: PreparedGraphicsStoreSnapshot = Object.freeze({
      generation,
      items: items.size === 0 ? NO_ITEMS : Object.freeze([...items.values()]),
    });
    this.slots.set(featureIdentity, { snapshot, items });
    return snapshot;
  }
}

export function createPreparedGraphicsStore(): PreparedGraphicsStore {
  return new PreparedGraphicsStoreImpl();
}
