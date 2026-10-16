import type { BufferViewJson } from './accessor/decode-accessor.js';
import {
  err,
  GLTF_MESHOPT_FILTERS,
  GLTF_MESHOPT_MODES,
  type GltfError,
  type GltfMeshoptFilter,
  type GltfMeshoptMode,
  gltfErr,
  ok,
  type Result,
} from './errors.js';

export type MeshoptMode = GltfMeshoptMode;
export type MeshoptFilter = GltfMeshoptFilter;

export interface MeshoptCompressionJson {
  readonly buffer: number;
  readonly byteOffset?: number;
  readonly byteLength: number;
  readonly byteStride: number;
  readonly count: number;
  readonly mode: MeshoptMode;
  readonly filter?: MeshoptFilter;
}

export interface MeshoptBufferViewJson extends BufferViewJson {
  readonly extensions?: {
    readonly EXT_meshopt_compression?: MeshoptCompressionJson;
  };
}

export interface GltfBufferViewDecodeCapability {
  readonly decode: (input: {
    readonly source: Uint8Array;
    readonly count: number;
    readonly stride: number;
    readonly mode: MeshoptMode;
    readonly filter: MeshoptFilter;
  }) => Uint8Array | Promise<Uint8Array>;
}

export interface MeshoptProjection {
  readonly bufferViews: readonly MeshoptBufferViewJson[];
  readonly buffers: readonly Uint8Array[];
  readonly decodedCount: number;
}

function viewBytes(
  view: MeshoptBufferViewJson,
  buffers: readonly Uint8Array[],
): Uint8Array | undefined {
  const buffer = buffers[view.buffer];
  const offset = view.byteOffset ?? 0;
  if (
    buffer === undefined ||
    view.byteLength <= 0 ||
    offset < 0 ||
    offset + view.byteLength > buffer.length
  ) {
    return undefined;
  }
  return buffer.subarray(offset, offset + view.byteLength);
}

function validMode(mode: string): mode is MeshoptMode {
  return GLTF_MESHOPT_MODES.some((candidate) => candidate === mode);
}

function validFilter(filter: string): filter is MeshoptFilter {
  return GLTF_MESHOPT_FILTERS.some((candidate) => candidate === filter);
}

function filterAllowed(mode: MeshoptMode, filter: MeshoptFilter): boolean {
  return mode === 'ATTRIBUTES' || filter === 'NONE';
}

/**
 * Resolve EXT_meshopt_compression bufferViews before any accessor consumer.
 * Optional assets keep a valid core bufferView fallback when no decoder is
 * installed; required or compressed-only assets fail with a structured error.
 */
export async function projectMeshoptBufferViews(
  inputViews: readonly MeshoptBufferViewJson[],
  inputBuffers: readonly Uint8Array[],
  extensionsRequired: readonly string[],
  capability?: GltfBufferViewDecodeCapability,
): Promise<Result<MeshoptProjection, GltfError>> {
  const buffers = [...inputBuffers];
  const bufferViews = inputViews.map((view) => ({ ...view }));
  let decodedCount = 0;

  for (let index = 0; index < bufferViews.length; index++) {
    const view = bufferViews[index];
    if (view === undefined) continue;
    const extension = view.extensions?.EXT_meshopt_compression;
    if (extension === undefined) continue;

    const filter = extension.filter ?? 'NONE';
    if (
      !validMode(extension.mode) ||
      !validFilter(filter) ||
      !filterAllowed(extension.mode, filter) ||
      !Number.isInteger(extension.byteStride) ||
      extension.byteStride <= 0 ||
      !Number.isInteger(extension.count) ||
      extension.count <= 0 ||
      !Number.isInteger(extension.byteLength) ||
      extension.byteLength <= 0
    ) {
      return err(
        gltfErr('gltf-meshopt-decode-failed', {
          bufferView: index,
          actual: 'invalid mode/filter/stride/count/byteLength',
          mode: validMode(extension.mode) ? extension.mode : 'ATTRIBUTES',
          filter: validFilter(filter) ? filter : 'NONE',
        }),
      );
    }

    const fallback = viewBytes(view, buffers);
    const required = extensionsRequired.includes('EXT_meshopt_compression');
    if (capability === undefined && !required && fallback !== undefined) continue;
    if (capability === undefined) {
      return err(
        gltfErr('gltf-meshopt-decoder-required', {
          bufferView: index,
          actual: required ? 'required' : 'compressed-only',
          hasCoreFallback: fallback !== undefined,
        }),
      );
    }

    const compressedBuffer = buffers[extension.buffer];
    const compressedOffset = extension.byteOffset ?? 0;
    if (
      compressedBuffer === undefined ||
      !Number.isInteger(compressedOffset) ||
      compressedOffset < 0 ||
      compressedOffset + extension.byteLength > compressedBuffer.length
    ) {
      return err(
        gltfErr('gltf-meshopt-decode-failed', {
          bufferView: index,
          actual: 'compressed range out of bounds',
          mode: extension.mode,
          filter,
        }),
      );
    }

    let decoded: Uint8Array;
    try {
      decoded = await capability.decode({
        source: compressedBuffer.subarray(
          compressedOffset,
          compressedOffset + extension.byteLength,
        ),
        count: extension.count,
        stride: extension.byteStride,
        mode: extension.mode,
        filter,
      });
    } catch (cause) {
      return err(
        gltfErr('gltf-meshopt-decode-failed', {
          bufferView: index,
          actual: `decoder rejected compressed range: ${cause instanceof Error ? cause.message : String(cause)}`,
          mode: extension.mode,
          filter,
        }),
      );
    }

    const expectedLength = extension.count * extension.byteStride;
    if (!(decoded instanceof Uint8Array) || decoded.byteLength !== expectedLength) {
      return err(
        gltfErr('gltf-meshopt-decode-failed', {
          bufferView: index,
          actual: `decoded byteLength=${decoded?.byteLength ?? 'invalid'}, expected=${expectedLength}`,
          mode: extension.mode,
          filter,
        }),
      );
    }

    const decodedBufferIndex = buffers.length;
    buffers.push(decoded);
    const { extensions: _extensions, ...plainView } = view;
    bufferViews[index] = {
      ...plainView,
      buffer: decodedBufferIndex,
      byteOffset: 0,
      byteLength: expectedLength,
    };
    decodedCount++;
  }

  return ok({ bufferViews, buffers, decodedCount });
}
