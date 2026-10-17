import type {
  Buffer,
  RhiDevice,
  Texture,
  TextureDescriptor,
  TextureView,
  Tlas,
} from '@forgeax/engine-rhi';
import { ok } from './errors.js';
import type {
  GraphAccelerationStructure,
  GraphAccess,
  GraphBuffer,
  GraphBufferDescriptor,
  GraphPass,
  GraphResourceKind,
  GraphResourceOrigin,
  GraphTexture,
  GraphTextureDescriptor,
  GraphTextureView,
  GraphTextureViewDescriptor,
  ImportedAccelerationStructureDescriptor,
  ImportedBufferDescriptor,
  ImportedTextureDescriptor,
  ImportedTextureViewResolver,
  RenderGraphFrame,
} from './types.js';

export interface TextureHandleData {
  readonly owner: object;
  readonly id: number;
  readonly kind: 'texture';
}

export interface TextureViewHandleData {
  readonly owner: object;
  readonly id: number;
  readonly kind: 'texture-view';
  readonly textureId: number;
}

export interface BufferHandleData {
  readonly owner: object;
  readonly id: number;
  readonly kind: 'buffer';
}

export interface AccelerationStructureHandleData {
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

interface ResourceRecordBase {
  readonly id: number;
  readonly label: string;
  readonly kind: GraphResourceKind;
  readonly origin: GraphResourceOrigin;
}

export interface CreatedTextureRecord extends ResourceRecordBase {
  readonly kind: 'texture';
  readonly origin: 'created';
  readonly descriptor: GraphTextureDescriptor;
}

export interface ImportedTextureRecord<FrameCtx> extends ResourceRecordBase {
  readonly kind: 'texture';
  readonly origin: 'imported';
  readonly descriptor: ImportedTextureDescriptor;
  readonly resolve: (frame: FrameCtx) => Texture;
}

export interface CreatedBufferRecord extends ResourceRecordBase {
  readonly kind: 'buffer';
  readonly origin: 'created';
  readonly descriptor: GraphBufferDescriptor;
}

export interface ImportedBufferRecord<FrameCtx> extends ResourceRecordBase {
  readonly kind: 'buffer';
  readonly origin: 'imported';
  readonly descriptor: ImportedBufferDescriptor;
  readonly resolve: (frame: FrameCtx) => Buffer;
}

export interface ImportedAccelerationStructureRecord<FrameCtx> extends ResourceRecordBase {
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
  readonly textureAllocation?: GraphTextureAllocation | undefined;
  readonly buffer?: Buffer | undefined;
}

export interface GraphTextureAllocation {
  readonly texture: Texture;
  readonly signature: string;
  references: number;
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

export interface CompiledPass<FrameCtx extends RenderGraphFrame> extends PassRecord<FrameCtx> {
  readonly dependencies: readonly number[];
  readonly resourceIds: ReadonlySet<number>;
  readonly viewIds: ReadonlySet<number>;
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
      const commands = descriptor.commands;
      return {
        kind: 'subgraph',
        descriptor: Object.freeze({
          accesses,
          ...(commands === undefined
            ? (() => {
                const child = descriptor.child;
                if (child === undefined) throw new TypeError('Missing subgraph execution callback');
                return { child: child.bind(descriptor) };
              })()
            : { commands: commands.bind(descriptor) }),
          executeIf: descriptor.executeIf?.bind(descriptor),
        }),
      };
    }
    case 'copy': {
      const descriptor = pass.descriptor;
      return {
        kind: 'copy',
        descriptor: Object.freeze({
          ...descriptor,
          accesses,
          encode: descriptor.encode.bind(descriptor),
          executeIf: descriptor.executeIf?.bind(descriptor),
        }),
      };
    }
    case 'compute': {
      const descriptor = pass.descriptor;
      return {
        kind: 'compute',
        descriptor: Object.freeze({
          ...descriptor,
          accesses,
          encode: descriptor.encode.bind(descriptor),
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
          ...descriptor,
          accesses,
          encode: descriptor.encode.bind(descriptor),
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
