import type {
  Buffer,
  RhiDevice,
  Texture,
  TextureDescriptor,
  TextureView,
  Tlas,
} from '@forgeax/engine-rhi';
import { ok } from './errors.js';
import type { ResolvedColorTargetDescriptor } from './graph.js';
import type {
  GraphAccelerationStructure,
  GraphAccess,
  GraphBuffer,
  GraphBufferDescriptor,
  GraphPass,
  GraphResourceKind,
  GraphResourceOrigin,
  GraphTexture,
  GraphTextureContentRange,
  GraphTextureDescriptor,
  GraphTextureView,
  GraphTextureViewDescriptor,
  ImportedAccelerationStructureDescriptor,
  ImportedBufferDescriptor,
  ImportedTextureDescriptor,
  ImportedTextureViewResolver,
  RenderGraphFrame,
} from './types.js';

interface TextureHandleData {
  readonly owner: object;
  readonly id: number;
  readonly kind: 'texture';
}

interface TextureViewHandleData {
  readonly owner: object;
  readonly id: number;
  readonly kind: 'texture-view';
  readonly textureId: number;
}

interface BufferHandleData {
  readonly owner: object;
  readonly id: number;
  readonly kind: 'buffer';
}

interface AccelerationStructureHandleData {
  readonly owner: object;
  readonly id: number;
  readonly kind: 'acceleration-structure';
}

export type ResourceHandleData =
  | TextureHandleData
  | TextureViewHandleData
  | BufferHandleData
  | AccelerationStructureHandleData;

export function textureHandle(owner: object, id: number): GraphTexture {
  return Object.freeze({ owner, id, kind: 'texture' }) as unknown as GraphTexture;
}

export function textureViewHandle(owner: object, id: number, textureId: number): GraphTextureView {
  return Object.freeze({
    owner,
    id,
    kind: 'texture-view',
    textureId,
  }) as unknown as GraphTextureView;
}

export function bufferHandle(owner: object, id: number): GraphBuffer {
  return Object.freeze({ owner, id, kind: 'buffer' }) as unknown as GraphBuffer;
}

export function accelerationStructureHandle(owner: object, id: number): GraphAccelerationStructure {
  return Object.freeze({
    owner,
    id,
    kind: 'acceleration-structure',
  }) as unknown as GraphAccelerationStructure;
}

export function handleData(resource: unknown): ResourceHandleData | undefined {
  if (typeof resource !== 'object' || resource === null) return undefined;
  const candidate = resource as Partial<ResourceHandleData>;
  if (typeof candidate.id !== 'number' || typeof candidate.owner !== 'object') return undefined;
  if (
    candidate.kind !== 'texture' &&
    candidate.kind !== 'texture-view' &&
    candidate.kind !== 'buffer' &&
    candidate.kind !== 'acceleration-structure'
  ) {
    return undefined;
  }
  return candidate as ResourceHandleData;
}

/** Resource identity across typed views, including reinterpreted formats and subresources. */
export function sameGraphTexture(
  view: GraphTextureView,
  resource: GraphAccess['resource'],
): boolean {
  const a = handleData(view);
  const b = handleData(resource);
  return (
    a?.kind === 'texture-view' &&
    b?.kind === 'texture-view' &&
    a.owner === b.owner &&
    a.textureId === b.textureId
  );
}

interface ResourceRecordBase {
  readonly id: number;
  readonly label: string;
  readonly kind: GraphResourceKind;
  readonly origin: GraphResourceOrigin;
}

interface CreatedTextureRecord extends ResourceRecordBase {
  readonly kind: 'texture';
  readonly origin: 'created';
  readonly descriptor: GraphTextureDescriptor;
}

interface ImportedTextureRecord<FrameCtx> extends ResourceRecordBase {
  readonly kind: 'texture';
  readonly origin: 'imported';
  readonly descriptor: ImportedTextureDescriptor;
  readonly resolve: (frame: FrameCtx) => Texture;
  readonly native?: import('./types.js').NativeTextureImport;
}

interface CreatedBufferRecord extends ResourceRecordBase {
  readonly kind: 'buffer';
  readonly origin: 'created';
  readonly descriptor: GraphBufferDescriptor;
}

interface ImportedBufferRecord<FrameCtx> extends ResourceRecordBase {
  readonly kind: 'buffer';
  readonly origin: 'imported';
  readonly descriptor: ImportedBufferDescriptor;
  readonly resolve: (frame: FrameCtx) => Buffer;
}

interface ImportedAccelerationStructureRecord<FrameCtx> extends ResourceRecordBase {
  readonly kind: 'acceleration-structure';
  readonly origin: 'imported';
  readonly descriptor: ImportedAccelerationStructureDescriptor;
  readonly resolve: (frame: FrameCtx) => Tlas;
}

export type ResourceRecord<FrameCtx> =
  | CreatedTextureRecord
  | ImportedTextureRecord<FrameCtx>
  | CreatedBufferRecord
  | ImportedBufferRecord<FrameCtx>
  | ImportedAccelerationStructureRecord<FrameCtx>;

export interface TextureViewRecord<FrameCtx extends RenderGraphFrame = RenderGraphFrame> {
  readonly id: number;
  readonly label: string;
  readonly textureId: number;
  readonly range: GraphTextureContentRange;
  readonly descriptor: GraphTextureViewDescriptor;
  readonly resolve?: ImportedTextureViewResolver<FrameCtx> | undefined;
}

export interface PassRecord<FrameCtx extends RenderGraphFrame> {
  readonly id: number;
  readonly name: string;
  readonly pass: GraphPass<FrameCtx>;
}

export interface CompiledResource<FrameCtx> {
  readonly record: ResourceRecord<FrameCtx>;
  readonly usage: number;
  readonly firstUse: number | null;
  readonly lastUse: number | null;
  readonly texture?: Texture | undefined;
  /** The normalized allocation descriptor also owns imported texture extents. */
  readonly textureDescriptor?:
    | (TextureDescriptor & {
        readonly size: {
          readonly width: number;
          readonly height: number;
          readonly depthOrArrayLayers: number;
        };
      })
    | undefined;
  /** Actual size supplied by the current imported allocation, separate from its declaration. */
  resolvedDescriptor?: CompiledResource<FrameCtx>['textureDescriptor'];
  resolvedViewExtent?: ReturnType<import('./types.js').GraphResourceResolver['textureViewExtent']>;
  readonly textureAllocation?: GraphTextureAllocation | undefined;
  /** Materialized only for a named read of a graph-owned texture. */
  colorTarget?: ResolvedColorTargetDescriptor;
  readonly borrowedTextureSlot?: true;
  readonly passLocal?: true;
  readonly buffer?: Buffer | undefined;
}

export interface GraphTextureAllocation {
  readonly texture: Texture;
  readonly signature: string;
  references: number;
  /** Shared by every graph lease of this physical allocation. */
  readonly committedContentRanges: GraphTextureContentRange[];
}

export function releaseGraphTexture(device: RhiDevice, allocation: GraphTextureAllocation) {
  if (allocation.references > 1) {
    allocation.references -= 1;
    return ok(undefined);
  }
  const result = device.destroyTexture(allocation.texture);
  if (result.ok) allocation.references = 0;
  return result;
}

const allocationKeys = new WeakMap<object, string>();
let nextAllocationKey = 1;

export function physicalAllocationKey(handle: object): string {
  let key = allocationKeys.get(handle);
  if (key === undefined) {
    key = `allocation-${nextAllocationKey++}`;
    allocationKeys.set(handle, key);
  }
  return key;
}

export interface CompiledView<FrameCtx extends RenderGraphFrame = RenderGraphFrame> {
  readonly record: TextureViewRecord<FrameCtx>;
  readonly view?: TextureView | undefined;
}

/** Builder handle ids occupy one dense namespace shared by resources and views. */
export class PhysicalGraphSlots<Frame extends RenderGraphFrame> {
  private readonly rows: (CompiledResource<Frame> | CompiledView<Frame> | undefined)[] = [];

  get addressCount(): number {
    return this.rows.length;
  }

  insert(row: CompiledResource<Frame> | CompiledView<Frame>): void {
    this.rows[row.record.id] = row;
  }

  resource(id: number): CompiledResource<Frame> | undefined {
    const row = this.rows[id];
    return row !== undefined && 'usage' in row ? row : undefined;
  }

  view(id: number): CompiledView<Frame> | undefined {
    const row = this.rows[id];
    return row !== undefined && !('usage' in row) ? row : undefined;
  }

  *resources(): IterableIterator<CompiledResource<Frame>> {
    for (const row of this.rows) if (row !== undefined && 'usage' in row) yield row;
  }

  *views(): IterableIterator<CompiledView<Frame>> {
    for (const row of this.rows) if (row !== undefined && !('usage' in row)) yield row;
  }
}

/** Short pass ranges stay in declaration order. Longer ranges are sorted on seal. */
export const LINEAR_PASS_ACCESS_LIMIT = 12;

export interface CompiledPass<FrameCtx extends RenderGraphFrame> extends PassRecord<FrameCtx> {
  readonly accessStart: number;
  readonly accessEnd: number;
  readonly textureWrites: readonly {
    readonly resourceId: number;
    readonly range: GraphTextureContentRange;
    readonly stored: boolean;
  }[];
}

export function accessResourceId(access: GraphAccess): number | undefined {
  const data = handleData(access.resource);
  if (data?.kind === 'texture-view') return data.textureId;
  return data?.id;
}

export function snapshotTextureDescriptor<T extends GraphTextureDescriptor>(descriptor: T): T {
  return Object.freeze({
    ...descriptor,
    size:
      typeof descriptor.size === 'string' ? descriptor.size : Object.freeze({ ...descriptor.size }),
    ...(descriptor.viewFormats === undefined
      ? {}
      : { viewFormats: Object.freeze([...descriptor.viewFormats]) }),
  });
}

/** Own descriptor data while retaining opaque handles and explicit frame callbacks. */
export function snapshotPass<FrameCtx extends RenderGraphFrame>(
  pass: GraphPass<FrameCtx>,
): GraphPass<FrameCtx> {
  const accesses = Object.freeze(
    pass.descriptor.accesses.map((access) => Object.freeze({ ...access })),
  );
  switch (pass.kind) {
    case 'subgraph': {
      const descriptor = pass.descriptor;
      const direct = descriptor.commandsDirect;
      const commands = direct === undefined ? descriptor.commands : undefined;
      const encoding = () => {
        if (direct !== undefined) return { commandsDirect: direct.bind(descriptor) };
        if (commands !== undefined) return { commands: commands.bind(descriptor) };
        const child = descriptor.child;
        if (child === undefined) throw new TypeError('Missing subgraph execution callback');
        return { child: child.bind(descriptor) };
      };
      const prepare = descriptor.prepareResources?.bind(descriptor);
      const prepared = descriptor.preparedResourcesCurrent?.bind(descriptor);
      const names =
        direct !== undefined || commands !== undefined
          ? descriptor.appendPassNames?.bind(descriptor)
          : undefined;
      return {
        kind: 'subgraph',
        descriptor: Object.freeze({
          accesses,
          ...encoding(),
          ...(prepare === undefined ? {} : { prepareResources: prepare }),
          ...(prepared === undefined ? {} : { preparedResourcesCurrent: prepared }),
          ...(names === undefined ? {} : { appendPassNames: names }),
          profilePasses: descriptor.profilePasses?.bind(descriptor),
          executeIf: descriptor.executeIf?.bind(descriptor),
        }),
      };
    }
    case 'copy': {
      const descriptor = pass.descriptor;
      return {
        kind: 'copy',
        descriptor: Object.freeze({
          ...snapshotEncoding(descriptor),
          accesses,
          executeIf: descriptor.executeIf?.bind(descriptor),
        }),
      };
    }
    case 'compute': {
      const descriptor = pass.descriptor;
      return {
        kind: 'compute',
        descriptor: Object.freeze({
          ...snapshotEncoding(descriptor),
          accesses,
          executeIf: descriptor.executeIf?.bind(descriptor),
          begin: descriptor.begin?.bind(descriptor),
          onBeginError: descriptor.onBeginError?.bind(descriptor),
          after: descriptor.after?.bind(descriptor),
        }),
      };
    }
    case 'raster': {
      const descriptor = pass.descriptor;
      const querySet = descriptor.occlusionQuerySet;
      return {
        kind: 'raster',
        descriptor: Object.freeze({
          ...snapshotEncoding(descriptor),
          accesses,
          executeIf: descriptor.executeIf?.bind(descriptor),
          occlusionQuerySet: typeof querySet === 'function' ? querySet.bind(descriptor) : querySet,
          colorAttachments: Object.freeze(
            descriptor.colorAttachments.map((attachment) => {
              const color = attachment.clearValue;
              return Object.freeze({
                ...attachment,
                ...(color === undefined
                  ? {}
                  : {
                      clearValue:
                        typeof color === 'function' ? color.bind(attachment) : snapshotColor(color),
                    }),
              });
            }),
          ),
          ...(descriptor.depthStencilAttachment === undefined
            ? {}
            : {
                depthStencilAttachment: Object.freeze({ ...descriptor.depthStencilAttachment }),
              }),
        }),
      };
    }
  }
}

function snapshotColor(color: GPUColor): GPUColor {
  const copy = Array.isArray(color) ? [...color] : { ...color };
  Object.freeze(copy);
  return copy;
}

function snapshotEncoding<
  T extends {
    readonly encode?: (...args: never[]) => unknown;
    readonly encodeDirect?: (...args: never[]) => unknown;
  },
>(descriptor: T): T {
  const captured = { ...descriptor };
  const direct = descriptor.encodeDirect;
  if (typeof direct === 'function')
    Object.assign(captured, { encodeDirect: direct.bind(descriptor) });
  else if (direct === undefined) {
    const encode = descriptor.encode;
    if (typeof encode === 'function') Object.assign(captured, { encode: encode.bind(descriptor) });
  }
  return captured;
}
