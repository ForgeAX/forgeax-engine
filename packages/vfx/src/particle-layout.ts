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
  { name: 'position', type: 'vec3<f32>', offset: 0, size: 12, alignment: 16 },
  { name: 'age', type: 'f32', offset: 12, size: 4, alignment: 4 },
  { name: 'velocity', type: 'vec3<f32>', offset: 16, size: 12, alignment: 16 },
  { name: 'lifetime', type: 'f32', offset: 28, size: 4, alignment: 4 },
  { name: 'color', type: 'vec4<f32>', offset: 32, size: 16, alignment: 16 },
  { name: 'sprite_size', type: 'vec2<f32>', offset: 48, size: 8, alignment: 8 },
  { name: 'sprite_rotation', type: 'f32', offset: 56, size: 4, alignment: 4 },
  { name: 'sub_image', type: 'f32', offset: 60, size: 4, alignment: 4 },
  { name: 'mesh_orientation', type: 'vec4<f32>', offset: 64, size: 16, alignment: 16 },
  { name: 'mesh_scale', type: 'vec3<f32>', offset: 80, size: 12, alignment: 16 },
  { name: 'material_random', type: 'f32', offset: 92, size: 4, alignment: 4 },
  { name: 'id', type: 'u32', offset: 96, size: 4, alignment: 4 },
  { name: 'alive', type: 'u32', offset: 100, size: 4, alignment: 4 },
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

/** WGSL declaration generated from the core schema. */
export function vfxParticleCoreWgsl(): string {
  return [
    'struct VfxParticle {',
    ...CORE_FIELDS.map((field) => `  ${field.name}: ${field.type},`),
    '}',
  ].join('\n');
}

/** Effect-level data is intentionally separate from per-particle custom data. */
export interface VfxParametersLayout extends VfxReflectedStruct {
  readonly name: 'VfxParameters';
}

export interface VfxCustomLayout extends VfxReflectedStruct {
  readonly name: 'VfxCustom';
  /** Array stride for `array<VfxCustom>` in the persistent GPU storage buffer. */
  readonly stride: number;
  /** Number of vec4-equivalent lanes consumed by the custom record. */
  readonly lanes: number;
}

const VALUE_LAYOUT: Readonly<
  Record<VfxValueType, { readonly alignment: number; readonly size: number }>
> = {
  f32: { alignment: 4, size: 4 },
  i32: { alignment: 4, size: 4 },
  u32: { alignment: 4, size: 4 },
  'vec2<f32>': { alignment: 8, size: 8 },
  'vec3<f32>': { alignment: 16, size: 12 },
  'vec4<f32>': { alignment: 16, size: 16 },
};

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
    const layout = VALUE_LAYOUT[field.type];
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

export type VfxParticleCoreValue =
  | readonly [number, number, number]
  | readonly [number, number, number, number]
  | readonly [number, number]
  | number;

export interface VfxParticleCoreValues {
  readonly position: readonly [number, number, number];
  readonly age: number;
  readonly velocity: readonly [number, number, number];
  readonly lifetime: number;
  readonly color: readonly [number, number, number, number];
  readonly sprite_size: readonly [number, number];
  readonly sprite_rotation: number;
  readonly sub_image: number;
  readonly mesh_orientation: readonly [number, number, number, number];
  readonly mesh_scale: readonly [number, number, number];
  readonly material_random: number;
  readonly id: number;
  readonly alive: number;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

/** Pack a core record using schema offsets. This is for inspection/replay fixtures, not a particle mirror. */
export function encodeVfxParticleCore(value: VfxParticleCoreValues): Uint8Array {
  const bytes = new Uint8Array(VFX_PARTICLE_CORE_STRIDE);
  const view = new DataView(bytes.buffer);
  const write = (name: VfxParticleCoreAttribute, values: readonly number[]): void => {
    const field = vfxParticleCoreField(name);
    for (const component of values) {
      if (!finite(component)) throw new TypeError(`non-finite VFX particle field ${name}`);
      if (
        field.type === 'u32' &&
        (!Number.isInteger(component) || component < 0 || component > 0xffffffff)
      ) {
        throw new RangeError(`u32 VFX particle field ${name} is outside its valid range`);
      }
    }
    for (let index = 0; index < values.length; index += 1) {
      const component = values[index] ?? 0;
      if (field.type === 'u32') view.setUint32(field.offset + index * 4, component, true);
      else view.setFloat32(field.offset + index * 4, component, true);
    }
  };
  write('position', value.position);
  write('age', [value.age]);
  write('velocity', value.velocity);
  write('lifetime', [value.lifetime]);
  write('color', value.color);
  write('sprite_size', value.sprite_size);
  write('sprite_rotation', [value.sprite_rotation]);
  write('sub_image', [value.sub_image]);
  write('mesh_orientation', value.mesh_orientation);
  write('mesh_scale', value.mesh_scale);
  write('material_random', [value.material_random]);
  write('id', [value.id]);
  write('alive', [value.alive]);
  return bytes;
}

/** Return the normalized age used by all renderer semantic projections. */
export function normalizedVfxParticleAge(age: number, lifetime: number): number {
  if (!finite(age) || !finite(lifetime) || lifetime <= 0) return 0;
  return Math.min(1, Math.max(0, age / lifetime));
}
