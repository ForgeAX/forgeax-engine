import { WGSL_NUMERIC_LAYOUT } from '@forgeax/engine-types';
import type { VfxReflectedField, VfxReflectedStruct, VfxValueType } from './effect-contract.js';

/**
 * The particle core is a storage-buffer ABI, not a convenient object shape.
 * Keep its fields in one ordered schema so WGSL, host-side allocation and
 * renderer projections all consume the same offsets.
 */
export type VfxParticleCoreAttribute =
  | 'position'
  | 'age'
  | 'velocity'
  | 'lifetime'
  | 'color'
  | 'sprite_size'
  | 'sprite_rotation'
  | 'sub_image'
  | 'mesh_orientation'
  | 'mesh_scale'
  | 'material_random'
  | 'id'
  | 'alive';

export interface VfxParticleCoreField {
  readonly name: VfxParticleCoreAttribute;
  readonly type: VfxValueType | 'u32';
  readonly offset: number;
  readonly size: number;
  readonly alignment: number;
}

export interface VfxParticleCoreLayout {
  readonly name: 'VfxParticle';
  readonly fields: readonly VfxParticleCoreField[];
  readonly size: number;
  readonly alignment: 16;
  readonly stride: number;
  readonly fingerprint: string;
}

const CORE_FIELDS: readonly VfxParticleCoreField[] = Object.freeze([
  { name: 'position', type: 'vec3<f32>', offset: 0, ...WGSL_NUMERIC_LAYOUT['vec3<f32>'] },
  { name: 'age', type: 'f32', offset: 12, ...WGSL_NUMERIC_LAYOUT.f32 },
  { name: 'velocity', type: 'vec3<f32>', offset: 16, ...WGSL_NUMERIC_LAYOUT['vec3<f32>'] },
  { name: 'lifetime', type: 'f32', offset: 28, ...WGSL_NUMERIC_LAYOUT.f32 },
  { name: 'color', type: 'vec4<f32>', offset: 32, ...WGSL_NUMERIC_LAYOUT['vec4<f32>'] },
  { name: 'sprite_size', type: 'vec2<f32>', offset: 48, ...WGSL_NUMERIC_LAYOUT['vec2<f32>'] },
  { name: 'sprite_rotation', type: 'f32', offset: 56, ...WGSL_NUMERIC_LAYOUT.f32 },
  { name: 'sub_image', type: 'f32', offset: 60, ...WGSL_NUMERIC_LAYOUT.f32 },
  { name: 'mesh_orientation', type: 'vec4<f32>', offset: 64, ...WGSL_NUMERIC_LAYOUT['vec4<f32>'] },
  { name: 'mesh_scale', type: 'vec3<f32>', offset: 80, ...WGSL_NUMERIC_LAYOUT['vec3<f32>'] },
  { name: 'material_random', type: 'f32', offset: 92, ...WGSL_NUMERIC_LAYOUT.f32 },
  { name: 'id', type: 'u32', offset: 96, ...WGSL_NUMERIC_LAYOUT.u32 },
  { name: 'alive', type: 'u32', offset: 100, ...WGSL_NUMERIC_LAYOUT.u32 },
]);

/** Program v3 core layout. The 112-byte stride includes WGSL's final 16-byte alignment. */
export const VFX_PARTICLE_CORE_LAYOUT: VfxParticleCoreLayout = Object.freeze({
  name: 'VfxParticle',
  fields: CORE_FIELDS,
  size: 112,
  alignment: 16,
  stride: 112,
  fingerprint: 'sha256:9e3c1566f6d0600cedb94bd3c4b76c4e7c456fd563b37065220d4e33cf83c777',
});

export const VFX_PARTICLE_CORE_STRIDE = VFX_PARTICLE_CORE_LAYOUT.stride;

const CORE_FIELD_BY_NAME = new Map(CORE_FIELDS.map((field) => [field.name, field]));

export function vfxParticleCoreField(name: VfxParticleCoreAttribute): VfxParticleCoreField {
  // The table is closed above; this branch makes an accidental edit fail loudly in development.
  const field = CORE_FIELD_BY_NAME.get(name);
  if (field === undefined) throw new Error(`unknown VFX particle core field ${name}`);
  return field;
}

export interface VfxCustomLayout extends VfxReflectedStruct {
  readonly name: 'VfxCustom';
  /** Array stride for `array<VfxCustom>` in the persistent GPU storage buffer. */
  readonly stride: number;
  /** Number of vec4-equivalent lanes consumed by the custom record. */
  readonly lanes: number;
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

/** Re-derive custom offsets from reflected fields and reject the bounded renderer budget. */
export function deriveVfxCustomLayout(struct: VfxReflectedStruct, maxLanes = 4): VfxCustomLayout {
  if (struct.name !== 'VfxCustom') {
    throw new TypeError(`expected VfxCustom reflection, received ${struct.name}`);
  }
  const fields: VfxReflectedField[] = [];
  let offset = 0;
  let alignment = 1;
  for (const field of struct.fields) {
    const layout = WGSL_NUMERIC_LAYOUT[field.type];
    offset = alignUp(offset, layout.alignment);
    fields.push({ ...field, offset, size: layout.size, alignment: layout.alignment });
    offset += layout.size;
    alignment = Math.max(alignment, layout.alignment);
  }
  const size = fields.length === 0 ? 0 : alignUp(offset, alignment);
  // Storage arrays use the WGSL struct alignment, not uniform/vec4 lane
  // alignment. Lanes are a budget unit only, never an alternate GPU ABI.
  const stride = size;
  const lanes = Math.ceil(stride / 16);
  if (lanes > maxLanes) {
    throw new RangeError(`VfxCustom consumes ${lanes} vec4 lanes; maximum is ${maxLanes}`);
  }
  return Object.freeze({
    name: 'VfxCustom',
    fields: Object.freeze(fields),
    size,
    alignment,
    stride,
    lanes,
  });
}
