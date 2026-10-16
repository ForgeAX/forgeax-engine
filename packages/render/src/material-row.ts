import {
  type MaterialShaderArtifactReceipt,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { derive, type ParamSchemaEntry, type UboFieldLayout } from '@forgeax/engine-types';
import { GPU_SCENE_LAYOUTS } from './gpu-scene-schema';
import { writeMaterialTextureCoordinateRecord } from './material-texture-coordinates';
import type { MaterialSnapshot } from './render-system-extract';

const ROW = GPU_SCENE_LAYOUTS.material;
const STANDARD_PIPELINE_DERIVED = derive(STANDARD_PIPELINE_PARAM_SCHEMA);

function isNumericValue(value: unknown): value is number | readonly number[] {
  return typeof value === 'number' || Array.isArray(value);
}

function numericFallback(
  name: string,
  material: MaterialSnapshot,
): number | readonly number[] | undefined {
  switch (name) {
    case 'baseColor':
      return [
        material.baseColor[0] ?? 0,
        material.baseColor[1] ?? 0,
        material.baseColor[2] ?? 0,
        1,
      ];
    case 'metallic':
      return material.metallic;
    case 'roughness':
      return material.roughness;
    case 'emissive':
      return material.emissive ?? [0, 0, 0];
    case 'emissiveIntensity':
      return material.emissiveIntensity ?? 0;
    case 'occlusionStrength':
      return material.occlusionStrength ?? 1;
    case 'normalScale':
      return material.normalScale ?? [1, 1];
    case 'specularColor':
      return material.specularColor ?? [1, 1, 1];
    default:
      return undefined;
  }
}

function numericValue(
  name: string,
  material: MaterialSnapshot,
  schema: readonly ParamSchemaEntry[],
  allowStandardFallback = false,
): number | readonly number[] | undefined {
  const snapshotValue = material.paramSnapshot?.[name];
  if (isNumericValue(snapshotValue)) return snapshotValue;
  if (allowStandardFallback) {
    const materialValue = numericFallback(name, material);
    if (materialValue !== undefined) return materialValue;
  }
  const defaultValue = schema.find((entry) => entry.name === name)?.default;
  if (isNumericValue(defaultValue)) return defaultValue;
  return undefined;
}

function writeScalar(view: DataView, member: UboFieldLayout, value: number): void {
  switch (member.type) {
    case 'f32':
    case 'vec2':
    case 'vec3':
    case 'vec4':
    case 'color':
      view.setFloat32(member.offset, value, true);
      return;
    case 'i32':
      view.setInt32(member.offset, value, true);
      return;
    case 'u32':
      view.setUint32(member.offset, value, true);
      return;
  }
}

function writeNumeric(
  view: DataView,
  member: UboFieldLayout,
  value: number | readonly number[] | undefined,
): void {
  if (member.type === 'f32' || member.type === 'i32' || member.type === 'u32') {
    writeScalar(view, member, typeof value === 'number' ? value : (value?.[0] ?? 0));
    return;
  }
  const values = Array.isArray(value) ? value : [];
  const count = member.type === 'vec2' ? 2 : member.type === 'vec3' ? 3 : 4;
  for (let index = 0; index < count; index += 1) {
    writeScalar(
      view,
      { ...member, offset: member.offset + index * 4, type: 'f32' },
      values[index] ?? 0,
    );
  }
}

function validateReceipt(receipt: MaterialShaderArtifactReceipt): void {
  const expectedFields = ROW.fields
    .filter((field) => !field.name.startsWith('_gpuDrivenPadding'))
    .map((field) => field.name);
  if (
    receipt.materialRow.byteLength !== ROW.stride ||
    receipt.materialRow.fields.length !== expectedFields.length ||
    receipt.materialRow.fields.some((field, index) => field !== expectedFields[index])
  ) {
    throw new RangeError(
      `Standard PBR material row receipt must match the ${ROW.stride}-byte canonical ABI`,
    );
  }
}

/** Pack the producer receipt's numeric Standard PBR row into the GPU Scene table. */
export function packStandardPbrMaterialRow(
  receipt: MaterialShaderArtifactReceipt,
  material: MaterialSnapshot,
): Uint8Array {
  validateReceipt(receipt);
  const payload = new Uint8Array(ROW.stride);
  const view = new DataView(payload.buffer);
  const f32 = new Float32Array(payload.buffer);
  for (const member of STANDARD_PIPELINE_DERIVED.numericMembers) {
    writeNumeric(
      view,
      member,
      numericValue(member.name, material, STANDARD_PIPELINE_PARAM_SCHEMA, true),
    );
  }
  for (const record of STANDARD_PIPELINE_DERIVED.coordinateRecords) {
    writeMaterialTextureCoordinateRecord(
      f32,
      record.offset / 4,
      material.textureCoordinates?.get(record.parameter),
    );
  }
  return payload;
}

/**
 * Pack any producer-owned numeric/coordinate schema into the shared GPU Scene
 * row page. Resource handles are intentionally absent: the scene-index shader
 * reads texture/sampler bindings from the ordinary material group while this
 * row carries only the values its generated `MaterialParameters` struct owns.
 * `undefined` means the schema exceeds the page and must remain outside the
 * capable lane.
 */
export function packMaterialProgramRow(
  schema: readonly ParamSchemaEntry[],
  material: MaterialSnapshot,
  rowStride = ROW.stride,
): Uint8Array | undefined {
  const derived = derive(schema);
  if (derived.totalBytes > rowStride || rowStride < 16 || rowStride % 16 !== 0) return undefined;
  const payload = new Uint8Array(rowStride);
  const view = new DataView(payload.buffer);
  const f32 = new Float32Array(payload.buffer);
  for (const member of derived.numericMembers) {
    writeNumeric(view, member, numericValue(member.name, material, schema));
  }
  for (const record of derived.coordinateRecords) {
    writeMaterialTextureCoordinateRecord(
      f32,
      record.offset / 4,
      material.textureCoordinates?.get(record.parameter),
    );
  }
  return payload;
}
