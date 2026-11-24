#import forgeax_ray::irradiance_field_sample::{irradianceFieldAtlasRadiance, irradianceFieldAtlasOrigin, irradianceFieldOctWrap, irradianceField, irradianceFieldMeta, irradianceFieldProbeOffset, IRRADIANCE_FIELD_ATLAS_COMPLETE, IRRADIANCE_FIELD_FAR_RADIANCE, IRRADIANCE_FIELD_PROBE_ACTIVE}
#import forgeax_ray::screen_probe::{generateHardwareCacheRays, lightProbeFallback, spGroupId, spLinearId}

@group(0) @binding(36) var atlasOut: texture_storage_2d<rgba16float, write>;
var<workgroup> missingDirection: atomic<u32>;

@compute @workgroup_size(64)
fn packRadianceAtlas(@builtin(workgroup_id) wid: vec3u,
    @builtin(local_invocation_index) lane: u32, @builtin(num_workgroups) groups: vec3u) {
  let probe = spGroupId(wid, groups);
  if (probe >= irradianceField.dimensionsCount.w) { return; }
  let far = (irradianceField.levels.w & IRRADIANCE_FIELD_FAR_RADIANCE) != 0u;
  let origin = irradianceFieldAtlasOrigin(probe, textureDimensions(atlasOut), far);
  if (lane == 0u) { atomicStore(&missingDirection, 0u); }
  workgroupBarrier();
  let value = irradianceFieldAtlasRadiance(probe, lane);
  if (far && value.w != 1.0) { atomicOr(&missingDirection, 1u); }
  let local = vec2u(lane % 8u, lane / 8u) + vec2u(1u);
  textureStore(atlasOut, vec2i(origin + local), value);
  if (lane < 36u) {
    var gutter = vec2u(lane % 10u, select(0u, 9u, lane >= 10u));
    if (lane >= 20u) { gutter = vec2u(select(0u, 9u, lane >= 28u), ((lane - 20u) % 8u) + 1u); }
    let source = irradianceFieldOctWrap(vec2i(gutter) - vec2i(1), 8);
    let edge = irradianceFieldAtlasRadiance(probe, source.y * 8u + source.x);
    textureStore(atlasOut, vec2i(origin + gutter), edge);
  }
  workgroupBarrier();
  if (far && lane == 0u) {
    let state = irradianceFieldMeta[probe];
    // A displaced legacy slot must be retraced before it covers this lattice cell.
    let onLattice = all(irradianceFieldProbeOffset(state, 1.0) == vec3f(0.0));
    let complete = onLattice && state.y == IRRADIANCE_FIELD_PROBE_ACTIVE && atomicLoad(&missingDirection) == 0u;
    textureStore(atlasOut, vec2i(origin + IRRADIANCE_FIELD_ATLAS_COMPLETE),
      vec4f(0.0, 0.0, 0.0, select(0.0, 1.0, complete)));
  }
}

@compute @workgroup_size(64)
fn generateHardwareCacheProbeRays(@builtin(workgroup_id) wid: vec3u,
    @builtin(local_invocation_index) lane: u32, @builtin(num_workgroups) groups: vec3u) {
  generateHardwareCacheRays(spGroupId(wid, groups), lane);
}

@compute @workgroup_size(64)
fn lightTraceFallbacksAtlas(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
  lightProbeFallback(spLinearId(gid, groups));
}
