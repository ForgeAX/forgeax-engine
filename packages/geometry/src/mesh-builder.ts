import { box3 } from '@forgeax/engine-math';
import {
  ASSET_ERROR_HINTS,
  AssetError,
  err,
  isStripTopology,
  type MeshAsset,
  type MeshMaterialSlot,
  ok,
  type PrimitiveTopology,
  type Result,
  type Submesh,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import {
  deriveVertexLayoutProjection,
  packInterleavedVertexAttributes,
  type VertexLayoutProjectionAttribute,
} from './vertex-attribute-layout';

type AttributeKey = VertexLayoutProjectionAttribute['key'];
type AttributeSource = NonNullable<VertexAttributeMap[AttributeKey]>;
type AttributeView = Float32Array | Uint16Array;

const TOPOLOGIES: readonly PrimitiveTopology[] = [
  'point-list',
  'line-list',
  'line-strip',
  'triangle-list',
  'triangle-strip',
];

/** Input shape for one independently drawn submesh. */
export type MeshBuilderSubmesh = Partial<Submesh> & {
  readonly topology?: PrimitiveTopology;
};

/** All authoring facts accepted by {@link createMeshBuilder}. */
export interface MeshBuilderOptions {
  readonly attributes?: VertexAttributeMap;
  readonly indices?: ArrayLike<number>;
  readonly submeshes?: readonly MeshBuilderSubmesh[];
  readonly materialSlots?: readonly MeshMaterialSlot[];
}

export interface MeshBuilder {
  /** Append one equally-cardinal attribute batch to the accumulated source. */
  appendVertices(attributes: VertexAttributeMap): Result<void, AssetError>;
  /** Append raw index values; width is derived during build. */
  appendIndices(indices: ArrayLike<number>): Result<void, AssetError>;
  /** Add a draw range; omitted ranges are completed from the final source. */
  addSubmesh(submesh: MeshBuilderSubmesh): Result<void, AssetError>;
  /** Derive one immutable MeshAsset from the accumulated source. */
  build(): Result<MeshAsset, AssetError>;
}

function failure(field: string, value: unknown, reason: string): Result<never, AssetError> {
  return err(
    new AssetError({
      code: 'asset-invalid-value',
      expected: `valid MeshBuilder ${field}: ${reason}`,
      hint: ASSET_ERROR_HINTS['asset-invalid-value'],
      detail: { field, value, reason },
    }),
  );
}

function sourceView(key: AttributeKey, value: AttributeSource): AttributeView | undefined {
  if (key === 'skinIndex') {
    if (value instanceof Uint16Array) return value;
    if (value instanceof ArrayBuffer && value.byteLength % Uint16Array.BYTES_PER_ELEMENT === 0) {
      return new Uint16Array(value);
    }
    return undefined;
  }
  if (value instanceof Float32Array) return value;
  if (value instanceof ArrayBuffer && value.byteLength % Float32Array.BYTES_PER_ELEMENT === 0) {
    return new Float32Array(value);
  }
  return undefined;
}

function cloneAttribute(key: AttributeKey, value: AttributeSource): AttributeView | undefined {
  const view = sourceView(key, value);
  if (view === undefined) return undefined;
  return view.slice();
}

function attributeKeys(attributes: VertexAttributeMap): AttributeKey[] {
  return deriveVertexLayoutProjection(attributes).attributes.map((attribute) => attribute.key);
}

function appendArray(target: AttributeView, source: AttributeView): AttributeView {
  if (target instanceof Uint16Array && source instanceof Uint16Array) {
    const output = new Uint16Array(target.length + source.length);
    output.set(target, 0);
    output.set(source, target.length);
    return output;
  }
  if (target instanceof Float32Array && source instanceof Float32Array) {
    const output = new Float32Array(target.length + source.length);
    output.set(target, 0);
    output.set(source, target.length);
    return output;
  }
  // The caller groups batches by canonical key, so this branch only protects
  // against an internally inconsistent future storage change.
  return target;
}

function copySlots(slots: readonly MeshMaterialSlot[] | undefined): MeshMaterialSlot[] {
  return (slots ?? [{ slotName: 'Default' }]).map((slot) => ({
    slotName: slot.slotName,
    ...(slot.sourceKey === undefined ? {} : { sourceKey: slot.sourceKey }),
    ...(slot.defaultMaterial === undefined ? {} : { defaultMaterial: slot.defaultMaterial }),
  }));
}

function validateAttributeBatch(
  attributes: VertexAttributeMap,
): Result<{ readonly keys: readonly AttributeKey[]; readonly vertexCount: number }, AssetError> {
  const keys = attributeKeys(attributes);
  if (keys.length === 0)
    return failure('attributes', [], 'at least one canonical attribute is required');
  const position = attributes.position;
  if (position === undefined)
    return failure('attributes.position', undefined, 'position is required');
  const positionView = sourceView('position', position);
  if (positionView === undefined) {
    return failure(
      'attributes.position',
      typeof position,
      'position must use Float32Array or ArrayBuffer',
    );
  }
  if (positionView.length === 0 || positionView.length % 3 !== 0) {
    return failure(
      'attributes.position',
      positionView.length,
      'position cardinality must be a non-zero multiple of 3',
    );
  }
  const vertexCount = positionView.length / 3;
  for (const { key, byteLength, format } of deriveVertexLayoutProjection(attributes).attributes) {
    const value = attributes[key];
    if (value === undefined) continue;
    const view = sourceView(key, value);
    if (view === undefined) {
      return failure(
        key,
        typeof value,
        key === 'skinIndex' ? 'storage must be Uint16Array' : 'storage must be Float32Array',
      );
    }
    const expectedLength = vertexCount * (byteLength / (format === 'uint16x4' ? 2 : 4));
    if (view.length !== expectedLength) {
      return failure(key, view.length, `cardinality must be ${expectedLength}`);
    }
    for (let elementIndex = 0; elementIndex < view.length; elementIndex += 1) {
      const valueAt = view[elementIndex];
      if (valueAt === undefined || !Number.isFinite(valueAt)) {
        return failure(key, valueAt, `${key}[${elementIndex}] must be finite`);
      }
      if (key === 'skinIndex' && (!Number.isInteger(valueAt) || valueAt < 0 || valueAt > 0xffff)) {
        return failure(key, valueAt, `${key}[${elementIndex}] must be an integer in [0, 65535]`);
      }
    }
  }
  return ok({ keys, vertexCount });
}

function validateSlots(slots: readonly MeshMaterialSlot[]): Result<void, AssetError> {
  if (slots.length === 0)
    return failure('materialSlots', slots.length, 'at least one material slot is required');
  const names = new Set<string>();
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const name = slot?.slotName.trim() ?? '';
    if (name.length === 0 || names.has(name)) {
      return failure(`materialSlots[${index}].slotName`, name, 'must be non-empty and unique');
    }
    names.add(name);
  }
  return ok(undefined);
}

function completedSubmeshes(
  requested: readonly MeshBuilderSubmesh[],
  vertexCount: number,
  indexCount: number,
  materialSlotCount: number,
): Result<readonly Submesh[], AssetError> {
  const source =
    requested.length === 0
      ? [
          {
            indexOffset: 0,
            indexCount,
            vertexCount,
            topology: 'triangle-list' as const,
            materialSlot: 0,
          },
        ]
      : requested;
  const output: Submesh[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const candidate = source[index];
    if (candidate === undefined)
      return failure(`submeshes[${index}]`, undefined, 'entry is required');
    const indexOffset = candidate.indexOffset ?? 0;
    const submeshIndexCount = candidate.indexCount ?? (indexCount > 0 ? indexCount : 0);
    const submeshVertexCount = candidate.vertexCount ?? vertexCount;
    const topology = candidate.topology ?? 'triangle-list';
    const materialSlot = candidate.materialSlot ?? index;
    if (!TOPOLOGIES.includes(topology)) {
      return failure(
        `submeshes[${index}].topology`,
        topology,
        'must be a WebGPU primitive topology',
      );
    }
    if (
      !Number.isInteger(indexOffset) ||
      indexOffset < 0 ||
      !Number.isInteger(submeshIndexCount) ||
      submeshIndexCount < 0 ||
      !Number.isInteger(submeshVertexCount) ||
      submeshVertexCount < 0 ||
      submeshVertexCount > vertexCount ||
      !Number.isInteger(materialSlot) ||
      materialSlot < 0 ||
      materialSlot >= materialSlotCount
    ) {
      return failure(
        `submeshes[${index}]`,
        JSON.stringify(candidate),
        'range and material slot are invalid',
      );
    }
    if (indexCount === 0 && (indexOffset !== 0 || submeshIndexCount !== 0)) {
      return failure(
        `submeshes[${index}]`,
        JSON.stringify(candidate),
        'non-indexed meshes use indexOffset=0 and indexCount=0',
      );
    }
    if (indexCount > 0 && indexOffset + submeshIndexCount > indexCount) {
      return failure(
        `submeshes[${index}]`,
        JSON.stringify(candidate),
        'index range exceeds the accumulated index buffer',
      );
    }
    if (indexCount === 0 && isStripTopology(topology)) {
      return failure(
        `submeshes[${index}].topology`,
        topology,
        'strip topology requires an index buffer',
      );
    }
    output.push({
      indexOffset,
      indexCount: submeshIndexCount,
      vertexCount: submeshVertexCount,
      topology,
      materialSlot,
    });
  }
  return ok(Object.freeze(output));
}

/**
 * Create a geometry-owned builder. All derived facts are computed once in
 * `build()` from the accumulated canonical attribute source.
 */
export function createMeshBuilder(options: MeshBuilderOptions = {}): MeshBuilder {
  const attributes: Partial<Record<AttributeKey, AttributeView>> = {};
  const indices: number[] = [];
  const submeshes: MeshBuilderSubmesh[] = [];
  const materialSlots = copySlots(options.materialSlots);

  const appendVertices = (batch: VertexAttributeMap): Result<void, AssetError> => {
    const checked = validateAttributeBatch(batch);
    if (!checked.ok) return checked;
    const incomingKeys = checked.value.keys;
    const existingKeys = Object.keys(attributes);
    if (existingKeys.length > 0 && existingKeys.join('|') !== incomingKeys.join('|')) {
      return failure(
        'attributes',
        incomingKeys.join(','),
        'every appended batch must carry the same canonical keys',
      );
    }
    for (const key of incomingKeys) {
      const value = batch[key];
      if (value === undefined) continue;
      const cloned = cloneAttribute(key, value);
      if (cloned === undefined) return failure(key, typeof value, 'storage could not be cloned');
      const previous = attributes[key];
      attributes[key] = previous === undefined ? cloned : appendArray(previous, cloned);
    }
    return ok(undefined);
  };

  const appendIndices = (batch: ArrayLike<number>): Result<void, AssetError> => {
    for (let index = 0; index < batch.length; index += 1) {
      const value = Number(batch[index]);
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        return failure('indices', value, `indices[${index}] must be an integer in [0, 2^32-1]`);
      }
      indices.push(value);
    }
    return ok(undefined);
  };

  const addSubmesh = (submesh: MeshBuilderSubmesh): Result<void, AssetError> => {
    if (submesh === null || typeof submesh !== 'object') {
      return failure('submeshes', submesh, 'entry must be an object');
    }
    submeshes.push({ ...submesh });
    return ok(undefined);
  };

  const build = (): Result<MeshAsset, AssetError> => {
    const source = attributes as VertexAttributeMap;
    const checked = validateAttributeBatch(source);
    if (!checked.ok) return checked;
    const slotCheck = validateSlots(materialSlots);
    if (!slotCheck.ok) return slotCheck;
    const vertexCount = checked.value.vertexCount;
    const position = source.position;
    if (position === undefined)
      return failure('attributes.position', undefined, 'position is required');
    const positionView = sourceView('position', position);
    if (!(positionView instanceof Float32Array)) {
      return failure('attributes.position', typeof position, 'position storage is invalid');
    }

    let maxIndex = 0;
    for (const value of indices) maxIndex = Math.max(maxIndex, value);
    const indexArray =
      indices.length === 0
        ? undefined
        : maxIndex <= 0xffff
          ? new Uint16Array(indices)
          : new Uint32Array(indices);
    if (indexArray !== undefined) {
      for (let index = 0; index < indexArray.length; index += 1) {
        const value = indexArray[index];
        if (value === undefined || value >= vertexCount) {
          return failure(
            'indices',
            value ?? -1,
            `indices[${index}] must be less than vertexCount (${vertexCount})`,
          );
        }
      }
    }

    const packed = packInterleavedVertexAttributes(source, vertexCount);
    if (!packed.ok) return packed;
    const ranges = completedSubmeshes(
      submeshes,
      vertexCount,
      indexArray?.length ?? 0,
      materialSlots.length,
    );
    if (!ranges.ok) return ranges;
    const aabb = box3.fromPositions(box3.create(), positionView);
    const copiedAttributes: VertexAttributeMap = {};
    for (const key of checked.value.keys) {
      const value = source[key];
      if (value === undefined) continue;
      const cloned = cloneAttribute(key, value);
      if (cloned === undefined) return failure(key, typeof value, 'storage could not be cloned');
      if (key === 'skinIndex') {
        if (!(cloned instanceof Uint16Array)) {
          return failure(key, typeof value, 'skinIndex storage must be Uint16Array');
        }
        copiedAttributes.skinIndex = cloned;
      } else {
        if (!(cloned instanceof Float32Array)) {
          return failure(key, typeof value, `${key} storage must be Float32Array`);
        }
        copiedAttributes[key] = cloned;
      }
    }
    const mesh: MeshAsset = {
      kind: 'mesh',
      vertices: packed.value.vertices.slice(),
      ...(indexArray === undefined ? {} : { indices: indexArray.slice() }),
      attributes: copiedAttributes,
      aabb: Float32Array.from(aabb),
      submeshes: ranges.value,
      materialSlots: Object.freeze(materialSlots.map((slot) => ({ ...slot }))),
    };
    return ok(Object.freeze(mesh));
  };

  if (options.attributes !== undefined) {
    const result = appendVertices(options.attributes);
    if (!result.ok) {
      // Keep construction side-effect free; the structured error is surfaced
      // by build() because the builder itself intentionally has no throw path.
      const constructionError = result.error;
      return {
        appendVertices,
        appendIndices,
        addSubmesh,
        build: () => err(constructionError),
      };
    }
  }
  if (options.indices !== undefined) {
    const result = appendIndices(options.indices);
    if (!result.ok) {
      const constructionError = result.error;
      return {
        appendVertices,
        appendIndices,
        addSubmesh,
        build: () => err(constructionError),
      };
    }
  }
  for (const submesh of options.submeshes ?? []) submeshes.push({ ...submesh });
  return { appendVertices, appendIndices, addSubmesh, build };
}
