import { STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { derive, type NumericParamType } from '@forgeax/engine-types';

export type GpuSceneScalar = 'u32' | 'i32' | 'f32';
export type GpuSceneFieldType =
  | GpuSceneScalar
  | 'vec2<f32>'
  | 'vec3<f32>'
  | 'vec4<f32>'
  | 'mat4x4<f32>';

export interface GpuSceneField {
  readonly name: string;
  readonly type: GpuSceneFieldType;
}

export interface GpuSceneTableSchema {
  readonly name: string;
  readonly fields: readonly GpuSceneField[];
}

export interface GpuSceneFieldLayout extends GpuSceneField {
  readonly offset: number;
  readonly size: number;
  readonly alignment: number;
}

export interface GpuSceneTableLayout {
  readonly name: string;
  readonly stride: number;
  readonly fields: readonly GpuSceneFieldLayout[];
}

const TYPE_LAYOUT: Readonly<
  Record<GpuSceneFieldType, { readonly size: number; readonly alignment: number }>
> = {
  u32: { size: 4, alignment: 4 },
  i32: { size: 4, alignment: 4 },
  f32: { size: 4, alignment: 4 },
  'vec2<f32>': { size: 8, alignment: 8 },
  'vec3<f32>': { size: 12, alignment: 16 },
  'vec4<f32>': { size: 16, alignment: 16 },
  'mat4x4<f32>': { size: 64, alignment: 16 },
};

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

export function deriveGpuSceneTableLayout(schema: GpuSceneTableSchema): GpuSceneTableLayout {
  let cursor = 0;
  let tableAlignment = 4;
  const fields = schema.fields.map((field) => {
    const typeLayout = TYPE_LAYOUT[field.type];
    cursor = align(cursor, typeLayout.alignment);
    tableAlignment = Math.max(tableAlignment, typeLayout.alignment);
    const layout: GpuSceneFieldLayout = { ...field, offset: cursor, ...typeLayout };
    cursor += typeLayout.size;
    return layout;
  });
  return { name: schema.name, stride: align(cursor, tableAlignment), fields };
}

export function gpuSceneFieldOffset(layout: GpuSceneTableLayout, name: string): number {
  const field = layout.fields.find((candidate) => candidate.name === name);
  if (field === undefined) throw new RangeError(`${layout.name} has no field named ${name}`);
  return field.offset;
}

export function gpuSceneWgsl(layout: GpuSceneTableLayout): string {
  const fields = layout.fields.map((field) => `  ${field.name}: ${field.type},`).join('\n');
  return `struct ${layout.name} {\n${fields}\n};`;
}

function gpuSceneTypeForNumeric(type: NumericParamType): GpuSceneFieldType {
  switch (type) {
    case 'f32':
      return 'f32';
    case 'i32':
      return 'i32';
    case 'u32':
      return 'u32';
    case 'vec3':
      return 'vec3<f32>';
    case 'vec4':
    case 'color':
      return 'vec4<f32>';
    case 'vec2':
      return 'vec2<f32>';
  }
}

/**
 * Project the canonical Standard material UBO into the GPU Scene storage row.
 * The compiler-generated `MaterialParameters` struct, the row packer, and the
 * shadow alpha-mask reader all consume this projection, so a new root numeric
 * field or coordinate pair cannot silently create a second hand-written ABI.
 */
function deriveStandardMaterialFields(): readonly GpuSceneField[] {
  const derived = derive(STANDARD_PIPELINE_PARAM_SCHEMA);
  const fields = [
    ...derived.numericMembers.map((member) => ({
      offset: member.offset,
      field: { name: member.name, type: gpuSceneTypeForNumeric(member.type) },
    })),
    ...derived.coordinateRecords.flatMap((record) => [
      {
        offset: record.offset,
        field: { name: record.transformMember, type: 'vec4<f32>' as const },
      },
      {
        offset: record.offset + 16,
        field: { name: record.metadataMember, type: 'vec4<f32>' as const },
      },
      {
        offset: record.offset + 32,
        field: { name: record.rotationMember, type: 'vec4<f32>' as const },
      },
    ]),
  ];
  fields.sort((left, right) => left.offset - right.offset);
  return fields.map(({ field }) => field);
}

export const GPU_SCENE_SCHEMAS = Object.freeze({
  lod: {
    name: 'GpuSceneLod',
    fields: [
      { name: 'generation', type: 'u32' },
      { name: 'level', type: 'u32' },
      { name: 'firstIndex', type: 'u32' },
      { name: 'indexCount', type: 'u32' },
      { name: 'baseVertex', type: 'i32' },
      { name: 'screenCoverage', type: 'f32' },
      { name: 'hysteresis', type: 'f32' },
      { name: 'ready', type: 'u32' },
    ],
  },
  primitive: {
    name: 'GpuScenePrimitive',
    fields: [
      { name: 'generation', type: 'u32' },
      { name: 'flags', type: 'u32' },
      { name: 'transformIndex', type: 'u32' },
      { name: 'materialIndex', type: 'u32' },
      { name: 'drawTemplateIndex', type: 'u32' },
      { name: 'instanceStart', type: 'u32' },
      { name: 'instanceCount', type: 'u32' },
      { name: 'assetHandle', type: 'u32' },
      { name: 'localBoundsMin', type: 'vec3<f32>' },
      { name: 'lightingChannels', type: 'u32' },
      { name: 'localBoundsMax', type: 'vec4<f32>' },
    ],
  },
  instance: {
    name: 'GpuSceneInstance',
    fields: [
      { name: 'primitiveIndex', type: 'u32' },
      { name: 'transformIndex', type: 'u32' },
      { name: 'customDataStart', type: 'u32' },
      { name: 'flags', type: 'u32' },
    ],
  },
  transform: {
    name: 'GpuSceneTransform',
    fields: [
      { name: 'currentWorld', type: 'mat4x4<f32>' },
      { name: 'previousWorld', type: 'mat4x4<f32>' },
    ],
  },
  drawTemplate: {
    name: 'GpuSceneDrawTemplate',
    fields: [
      { name: 'pipelineClass', type: 'u32' },
      { name: 'materialIndex', type: 'u32' },
      { name: 'firstIndex', type: 'u32' },
      { name: 'indexCount', type: 'u32' },
      { name: 'baseVertex', type: 'i32' },
      { name: 'firstInstance', type: 'u32' },
      { name: 'passFlags', type: 'u32' },
      { name: 'reserved', type: 'u32' },
    ],
  },
  material: {
    name: 'GpuSceneMaterial',
    fields: deriveStandardMaterialFields(),
  },
} satisfies Readonly<Record<string, GpuSceneTableSchema>>);

export const GPU_SCENE_LAYOUTS = Object.freeze(
  Object.fromEntries(
    Object.entries(GPU_SCENE_SCHEMAS).map(([name, schema]) => [
      name,
      deriveGpuSceneTableLayout(schema),
    ]),
  ) as {
    readonly [Name in keyof typeof GPU_SCENE_SCHEMAS]: GpuSceneTableLayout;
  },
);

export const GPU_SCENE_WGSL = Object.values(GPU_SCENE_LAYOUTS).map(gpuSceneWgsl).join('\n\n');
