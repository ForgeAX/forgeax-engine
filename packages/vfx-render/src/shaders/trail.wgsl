#define_import_path forgeax::vfx-render.particles.trail
#pragma variant_axis ATMOSPHERE_AVAILABLE
#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#import forgeax_view::common::{View, view}
#import forgeax_view::fog::{translucent_fog, ndc_world}

struct SegmentInput {
  @location(0) start: vec3<f32>,
  @location(1) endpoint: vec3<f32>,
  @location(2) color: vec4<f32>,
  @location(3) properties: vec2<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) clip_position: vec3<f32>,
  @location(2) uv: vec2<f32>,
}

@vertex
fn vs_main(input: SegmentInput, @builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0)
  );
  let corner = corners[vertexIndex];
  let delta = input.endpoint.xy - input.start.xy;
  let normal = normalize(vec2<f32>(-delta.y, delta.x) + vec2<f32>(0.000001, 0.0));
  let tangent = normalize(delta + vec2<f32>(0.000001, 0.0));
  let taper = max(0.0, 1.0 - input.properties.y);
  let point = mix(input.start, input.endpoint, corner.x) + vec3<f32>(
    tangent * ((corner.x * 2.0 - 1.0) * input.properties.x),
    0.0,
  );
  let clipPosition = vec3<f32>(
    point.xy + normal * corner.y * input.properties.x * taper,
    point.z,
  );
  var output: VertexOutput;
  output.position = vec4<f32>(clipPosition, 1.0);
  output.color = input.color;
  output.clip_position = clipPosition;
  output.uv = corner;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  // Keep the topology's authored particle color authoritative and feather
  // the strip edge. A solid quad makes short history segments read as a
  // block when several particles overlap; this analytic cross-section keeps
  // the existing clip-space ABI while providing a continuous wake.
  let edge = 1.0 - smoothstep(0.58, 1.0, abs(input.uv.y));
  let alpha = input.color.a * edge;
  let fogged = translucent_fog(view, ndc_world(view, input.clip_position), input.color.rgb * alpha, alpha);
  return vec4<f32>(fogged, alpha);
}
