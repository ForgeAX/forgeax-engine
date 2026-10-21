import type { AssetVersionDelta } from '@forgeax/engine-assets-runtime/internal';
import { mat4 } from '@forgeax/engine-math';
import { ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import {
  VFX_FORCE_FIELD_BYTES_LIMIT,
  type VfxForceField,
  type VfxForceFieldError,
  validateVfxForceFields,
  vfxForceFieldFailure,
} from '@forgeax/engine-vfx';
import { validateVfxVectorFieldRanges } from '@forgeax/engine-vfx/internal';

interface Upload {
  readonly offset: number;
  readonly data: Uint8Array;
}
export interface PreparedVfxForceFields {
  readonly revision: number;
  readonly byteLength: number;
  /** Full fixed-source spans; no repacking/copying of vector samples. */
  readonly uploads: readonly Upload[];
  readonly delta?: { readonly from: number; readonly uploads: readonly Upload[] };
  /** Explicit observation only; normal plans consume spans directly. */
  readonly data: Float32Array;
}
interface Source {
  readonly handle: number;
  readonly revision: number;
  readonly value: TextureAsset;
  readonly delta?: AssetVersionDelta;
}

function spans(
  source: Source,
  previous: Source | undefined,
): readonly { byteOffset: number; byteLength: number }[] | undefined {
  if (previous === undefined || source.handle !== previous.handle) return undefined;
  if (source.revision === previous.revision) return [];
  const delta = source.delta;
  if (
    delta?.from !== previous.revision ||
    delta.fields.length !== 0 ||
    delta.ranges.some((range) => range.path.length !== 1 || range.path[0] !== 'data')
  )
    return undefined;
  const ranges = [];
  for (const range of delta.ranges) {
    const rowBytes = range.rowBytes ?? range.byteLength,
      stride = range.byteStride ?? rowBytes;
    for (let offset = 0; offset < range.byteLength; offset += stride) {
      const start = Math.floor((range.byteOffset + offset) / 4) * 4;
      const end = Math.min(
        source.value.data.byteLength,
        Math.ceil((range.byteOffset + offset + rowBytes) / 4) * 4,
      );
      ranges.push({ byteOffset: start, byteLength: end - start });
    }
  }
  return ranges;
}

/** Exact fixed versions select weakly cached projections; only changed f32 words are revalidated. */
export function createVfxForceFieldPreparation() {
  interface Entry {
    readonly textures: WeakMap<TextureAsset, Entry>;
    value?: PreparedVfxForceFields;
  }
  const cache = new WeakMap<readonly VfxForceField[], Entry>();
  const previous = new WeakMap<
    readonly VfxForceField[],
    { sources: readonly Source[]; value: PreparedVfxForceFields }
  >();
  const validated = new WeakMap<TextureAsset, Result<TextureAsset, VfxForceFieldError>>();
  let revision = 0;
  return (
    fields: readonly VfxForceField[],
    sources: readonly Source[],
  ): Result<PreparedVfxForceFields, VfxForceFieldError> => {
    const declarations = validateVfxForceFields(fields, 'forceFields', true);
    if (!declarations.ok) return declarations;
    const prior = previous.get(fields);
    const changed = sources.map((source, index) => spans(source, prior?.sources[index]));
    let vectors = 1 + fields.length * 10,
      sourceIndex = 0;
    for (const field of fields) {
      if (field.kind !== 'vector') continue;
      const source = sources[sourceIndex];
      if (source === undefined)
        return vfxForceFieldFailure(
          'vfx-field-asset-missing',
          'forceFields.texture',
          'a fixed Texture version for this tick',
          String(field.texture),
        );
      let check = validated.get(source.value);
      if (check === undefined) {
        check = validateVfxVectorFieldRanges(
          source.value,
          String(field.texture),
          changed[sourceIndex],
        );
        validated.set(source.value, check);
      }
      if (!check.ok) return check;
      vectors += source.value.data.byteLength / 16;
      sourceIndex++;
    }
    if (vectors * 16 > VFX_FORCE_FIELD_BYTES_LIMIT)
      return vfxForceFieldFailure(
        'vfx-field-capacity-exceeded',
        'forceFields',
        'at most 16 MiB including metadata per emitter',
      );
    let entry = cache.get(fields);
    if (entry === undefined) {
      entry = { textures: new WeakMap() };
      cache.set(fields, entry);
    }
    for (const source of sources) {
      let next: Entry | undefined = entry.textures.get(source.value);
      if (next === undefined) {
        next = { textures: new WeakMap() };
        entry.textures.set(source.value, next);
      }
      entry = next;
    }
    if (entry.value !== undefined) {
      previous.set(fields, { sources, value: entry.value });
      return ok(entry.value);
    }
    const metadata = new Float32Array((1 + fields.length * 10) * 4);
    metadata[0] = fields.length;
    const uploads: Upload[] = [{ offset: 0, data: new Uint8Array(metadata.buffer) }];
    const patches: Upload[] = [];
    let sampleOffset = metadata.byteLength,
      cursor = 0;
    for (const [index, field] of fields.entries()) {
      const at = (1 + index * 10) * 4,
        transform = new Float32Array(field.transform);
      metadata.set(mat4.invert(mat4.create(), transform), at);
      metadata.set(transform, at + 16);
      metadata.set(
        [
          field.kind === 'sphere' ? 0 : field.kind === 'box' ? 1 : 2,
          field.strength,
          field.attenuation,
          field.kind === 'vector' && field.sampling === 'trilinear' ? 1 : 0,
        ],
        at + 32,
      );
      if (field.kind !== 'vector') continue;
      const source = sources[cursor];
      if (source === undefined || source.value.shape.viewDimension !== '3d')
        throw new Error('validated field source missing');
      const { width, height, depth } = source.value.shape.extent;
      metadata.set([width, height, depth, sampleOffset / 16], at + 36);
      uploads.push({ offset: sampleOffset, data: source.value.data });
      for (const range of changed[cursor] ?? [])
        patches.push({
          offset: sampleOffset + range.byteOffset,
          data: source.value.data.subarray(range.byteOffset, range.byteOffset + range.byteLength),
        });
      sampleOffset += source.value.data.byteLength;
      cursor++;
    }
    const incremental =
      prior !== undefined &&
      prior.sources.length === sources.length &&
      changed.every((value) => value !== undefined) &&
      prior.value.byteLength === sampleOffset;
    let observed: Float32Array | undefined;
    const value: PreparedVfxForceFields = {
      revision: revision++,
      byteLength: sampleOffset,
      uploads,
      ...(incremental ? { delta: { from: prior.value.revision, uploads: patches } } : {}),
      get data() {
        if (observed === undefined) {
          const bytes = new Uint8Array(sampleOffset);
          for (const upload of uploads) bytes.set(upload.data, upload.offset);
          observed = new Float32Array(bytes.buffer);
        }
        return observed;
      },
    };
    entry.value = value;
    previous.set(fields, { sources, value });
    return ok(value);
  };
}
