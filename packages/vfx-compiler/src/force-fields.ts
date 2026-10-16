import { err, ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import { VFX_VECTOR_FIELD_RESOLUTION_LIMIT, type VfxForceFieldError } from '@forgeax/engine-vfx';

/** Build-time ordinary texture producer. Voxel nodes cover [-1, 1] on each axis. */
export function createVfxVectorFieldTexture(input: {
  readonly resolution: readonly [number, number, number];
  readonly field:
    | { readonly kind: 'constant'; readonly value: readonly [number, number, number] }
    | { readonly kind: 'radial' | 'vortex'; readonly magnitude: number };
}): Result<TextureAsset, VfxForceFieldError> {
  const { resolution, field } = input;
  const values = field?.kind === 'constant' ? field.value : [field?.magnitude];
  if (
    !Array.isArray(resolution) ||
    resolution.length !== 3 ||
    !resolution.every(
      (n) => Number.isInteger(n) && n >= 2 && n <= VFX_VECTOR_FIELD_RESOLUTION_LIMIT,
    ) ||
    !field ||
    !['constant', 'radial', 'vortex'].includes(field.kind) ||
    !Array.isArray(values) ||
    !values.every((n) => typeof n === 'number' && Number.isFinite(Math.fround(n))) ||
    (field.kind === 'constant' && values.length !== 3)
  )
    return err({
      code: 'vfx-field-invalid',
      expected: 'dimensions in [2, 64] and finite f32 generator parameters',
      hint: 'repair the saved vector-field producer inputs',
      detail: { path: 'vectorField' },
    });
  const [width, height, depth] = resolution;
  const data = new Uint8Array(width * height * depth * 16);
  const view = new DataView(data.buffer);
  for (let z = 0; z < depth; z++)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const p: readonly [number, number, number] = [
          (2 * x) / (width - 1) - 1,
          (2 * y) / (height - 1) - 1,
          (2 * z) / (depth - 1) - 1,
        ];
        const v =
          field.kind === 'constant'
            ? field.value
            : field.kind === 'radial'
              ? p.map((n) => -n * field.magnitude)
              : [-p[2] * field.magnitude, 0, p[0] * field.magnitude];
        const offset = ((z * height + y) * width + x) * 16;
        for (let axis = 0; axis < 3; axis++) view.setFloat32(offset + axis * 4, v[axis] ?? 0, true);
      }
  return ok({
    kind: 'texture',
    shape: { viewDimension: '3d', extent: { width, height, depth } },
    format: 'rgba32float',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data,
  });
}

/** Managed field binding 17 preserves the SDF owner's binding 15. */
export const VFX_FORCE_FIELDS_WGSL = `
@group(0) @binding(17) var<storage, read> forgeax_vfx_force_fields: array<vec4<f32>>;

fn forgeax_vfx_field_matrix(at: u32) -> mat4x4<f32> {
  return mat4x4<f32>(forgeax_vfx_force_fields[at], forgeax_vfx_force_fields[at + 1u], forgeax_vfx_force_fields[at + 2u], forgeax_vfx_force_fields[at + 3u]);
}
fn forgeax_vfx_field_voxel(offset: u32, dims: vec3<u32>, p: vec3<u32>) -> vec3<f32> {
  return forgeax_vfx_force_fields[offset + (p.z * dims.y + p.y) * dims.x + p.x].xyz;
}
fn forgeax_vfx_field_vector(metadata: vec4<f32>, local: vec3<f32>, linear: bool) -> vec3<f32> {
  let dims = vec3<u32>(metadata.xyz);
  let offset = u32(metadata.w);
  let grid = clamp((local + vec3<f32>(1.0)) * 0.5, vec3<f32>(0.0), vec3<f32>(1.0)) * vec3<f32>(dims - vec3<u32>(1u));
  if (!linear) { return forgeax_vfx_field_voxel(offset, dims, vec3<u32>(floor(grid + vec3<f32>(0.5)))); }
  let low = vec3<u32>(floor(grid));
  let high = min(low + vec3<u32>(1u), dims - vec3<u32>(1u));
  let t = fract(grid);
  let a = mix(forgeax_vfx_field_voxel(offset, dims, low), forgeax_vfx_field_voxel(offset, dims, vec3<u32>(high.x, low.y, low.z)), t.x);
  let b = mix(forgeax_vfx_field_voxel(offset, dims, vec3<u32>(low.x, high.y, low.z)), forgeax_vfx_field_voxel(offset, dims, vec3<u32>(high.x, high.y, low.z)), t.x);
  let c = mix(forgeax_vfx_field_voxel(offset, dims, vec3<u32>(low.x, low.y, high.z)), forgeax_vfx_field_voxel(offset, dims, vec3<u32>(high.x, low.y, high.z)), t.x);
  let d = mix(forgeax_vfx_field_voxel(offset, dims, vec3<u32>(low.x, high.y, high.z)), forgeax_vfx_field_voxel(offset, dims, high), t.x);
  return mix(mix(a, b, t.y), mix(c, d, t.y), t.z);
}
fn vfx_force_field_acceleration(position: vec3<f32>) -> vec3<f32> {
  let emitter = forgeax_vfx_runtime.localToWorld;
  let world = (emitter * vec4<f32>(position, 1.0)).xyz;
  var acceleration = vec3<f32>(0.0);
  let count = u32(forgeax_vfx_force_fields[0].x);
  for (var i = 0u; i < count; i++) {
    let at = 1u + i * 10u;
    let worldToField = forgeax_vfx_field_matrix(at);
    let fieldToWorld = forgeax_vfx_field_matrix(at + 4u);
    let settings = forgeax_vfx_force_fields[at + 8u];
    if (settings.y == 0.0) { continue; }
    let local = (worldToField * vec4<f32>(world, 1.0)).xyz;
    var radius = max(abs(local.x), max(abs(local.y), abs(local.z)));
    if (settings.x == 0.0) { radius = length(local); }
    if (radius > 1.0) { continue; }
    if (settings.x == 2.0) {
      let vector = forgeax_vfx_field_vector(forgeax_vfx_force_fields[at + 9u], local, settings.w == 1.0);
      var falloff = 1.0;
      if (settings.z > 0.0) { falloff = pow(max(0.0, 1.0 - radius), settings.z); }
      acceleration += (fieldToWorld * vec4<f32>(vector, 0.0)).xyz * (settings.y * falloff);
    } else {
      let toCenter = fieldToWorld[3].xyz - world;
      let distance = length(toCenter);
      if (distance > 0.0) {
        var falloff = 1.0;
        if (settings.z > 0.0) { falloff = pow(max(0.0, 1.0 - radius), settings.z); }
        acceleration += toCenter / distance * (settings.y * falloff);
      }
    }
  }
  // Inverse emitter linear basis converts world acceleration to particle space.
  let a = emitter[0].xyz;
  let b = emitter[1].xyz;
  let c = emitter[2].xyz;
  let inverseDeterminant = 1.0 / dot(a, cross(b, c));
  return vec3<f32>(dot(cross(b, c), acceleration), dot(cross(c, a), acceleration), dot(cross(a, b), acceleration)) * inverseDeterminant;
}
fn vfx_apply_force_fields(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  (*particle).velocity += vfx_force_field_acceleration((*particle).position) * ctx.delta;
}
`;
