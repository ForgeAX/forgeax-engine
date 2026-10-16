/** Managed ABI: 256-byte grid header followed by canonical 16-byte global voxels.
 * The composition writer binds the voxel range at offset 256; the consumer
 * binds the complete buffer. No second voxel representation or texture copy. */
export const SCENE_SDF_RUNTIME_WGSL = `
struct VfxSdfVoxel { distance: f32, coverage: f32, status: u32, nearest: u32 }
struct VfxSceneSdf {
  origin_spacing: vec4f,
  dimensions_count: vec4u,
  ranges: vec4f,
  padding: array<vec4u, 13>,
  voxels: array<VfxSdfVoxel>,
}
@group(0) @binding(15) var<storage, read> forgeax_vfx_scene_sdf: VfxSceneSdf;
// status: 0 clear, 1 contact, 2 outside coverage, 3 bounded work exhausted,
// 4 unknown field/normal, 5 invalid parameters. Coverage 0 means unsigned.
struct VfxSdfSample { distance: f32, coverage: f32, status: u32, gradient: vec3f, advance_time: f32 }
struct VfxSdfCollision {
  position: vec3f, status: u32,
  velocity: vec3f, samples: u32,
  normal: vec3f, contacts: u32,
}
fn vfx_sdf_cell_value(c: array<f32, 8>, f: vec3f) -> f32 {
  return mix(mix(mix(c[0],c[1],f.x),mix(c[2],c[3],f.x),f.y),
    mix(mix(c[4],c[5],f.x),mix(c[6],c[7],f.x),f.y),f.z);
}
fn vfx_sdf_cell_gradient(c: array<f32, 8>, f: vec3f) -> vec3f {
  return vec3f(
    mix(mix(c[1]-c[0],c[3]-c[2],f.y),mix(c[5]-c[4],c[7]-c[6],f.y),f.z),
    mix(mix(c[2]-c[0],c[3]-c[1],f.x),mix(c[6]-c[4],c[7]-c[5],f.x),f.z),
    mix(mix(c[4]-c[0],c[5]-c[1],f.x),mix(c[6]-c[2],c[7]-c[3],f.x),f.y));
}
// A ray through a trilinear cell is cubic. Bernstein controls enclose its
// distance; sixteen bounded subdivisions certify a clear prefix without more
// field reads, changing the surface radius or raising the query budget.
fn vfx_sdf_curve_value(c: vec4f, t: f32) -> f32 {
  return ((c.x*t+c.y)*t+c.z)*t+c.w;
}
fn vfx_sdf_curve_derivative(c: vec4f, t: f32) -> f32 {
  return (3.0*c.x*t+2.0*c.y)*t+c.z;
}
fn vfx_sdf_sample(world_position: vec3f, velocity: vec3f, remaining: f32, surface_radius: f32) -> VfxSdfSample {
  let q = (world_position - forgeax_vfx_scene_sdf.origin_spacing.xyz) / forgeax_vfx_scene_sdf.origin_spacing.w;
  let dims = forgeax_vfx_scene_sdf.dimensions_count.xyz;
  if (!all(abs(world_position) <= vec3f(3.402823e38))) { return VfxSdfSample(0.0,0.0,5u, vec3f(0), 0.0); }
  if (any(q < vec3f(0)) || any(q > vec3f(dims - vec3u(1)))) {
    return VfxSdfSample(forgeax_vfx_scene_sdf.ranges.x, 0.0, 2u, vec3f(0), 0.0);
  }
  let cell = vec3u(min(floor(q), vec3f(dims - vec3u(2))));
  let f = q - vec3f(cell);
  var distance = 0.0; var coverage = 1.0;
  var corners: array<f32, 8>;
  for (var z = 0u; z < 2u; z++) {
    for (var y = 0u; y < 2u; y++) {
      for (var x = 0u; x < 2u; x++) {
        let c = cell + vec3u(x, y, z);
        let voxel = forgeax_vfx_scene_sdf.voxels[(c.z*dims.y+c.y)*dims.x+c.x];
        if (voxel.status != 1u) { return VfxSdfSample(0.0, 0.0, 4u, vec3f(0), 0.0); }
        corners[(z*2u+y)*2u+x] = voxel.distance;
        let weight = select(vec3f(1)-f, f, vec3u(x,y,z)>vec3u(0));
        distance += voxel.distance * weight.x * weight.y * weight.z;
        coverage = min(coverage, voxel.coverage);
      }
    }
  }
  let gradient = vfx_sdf_cell_gradient(corners,f)/forgeax_vfx_scene_sdf.origin_spacing.w;
  let spacing = forgeax_vfx_scene_sdf.origin_spacing.w;
  let epsilon = max(spacing*0.001,1e-6);
  var advance_time = 0.0;
  let clearance = distance-surface_radius;
  if (remaining > 0.0 && clearance > epsilon) {
    let axis_time = select(vec3f(3.402823e38),
      select(f,vec3f(1)-f,velocity>vec3f(0))*spacing/max(abs(velocity),vec3f(1e-20)),
      abs(velocity)>vec3f(0));
    let span = min(remaining,min(axis_time.x,min(axis_time.y,axis_time.z)));
    if (span > 0.0) {
      let end_fraction = clamp(f+velocity*span/spacing,vec3f(0),vec3f(1));
      let end_distance = vfx_sdf_cell_value(corners,end_fraction);
      let end_gradient = vfx_sdf_cell_gradient(corners,end_fraction)/spacing;
      let first_rate = dot(velocity,gradient);
      let last_rate = dot(velocity,end_gradient);
      let middle_rate = 3.0*(end_distance-distance)/span-first_rate-last_rate;
      var scale = abs(surface_radius);
      for (var i = 0u; i < 8u; i++) { scale=max(scale,abs(corners[i])); }
      // Bound distance/rate roundoff before dividing the endpoint difference.
      let roundoff = 32.0*1.1920929e-7*scale;
      let closing_rate = max(0.0,-min(first_rate,min(middle_rate,last_rate)))+roundoff/span;
      advance_time = min(clearance*0.8/max(closing_rate,1e-20),span);
      let controls = vec4f(distance,distance+span*first_rate/3.0,
        end_distance-span*last_rate/3.0,end_distance);
      let margin = max(epsilon,roundoff);
      if (all(controls > vec4f(surface_radius+margin))) {
        advance_time = span;
      } else {
        let curve = vec4f(-controls.x+3.0*controls.y-3.0*controls.z+controls.w,
          3.0*controls.x-6.0*controls.y+3.0*controls.z,
          -3.0*controls.x+3.0*controls.y,controls.x);
        for (var segment = 0u; segment < 16u; segment++) {
          let start = f32(segment)/16.0;
          let end = f32(segment+1u)/16.0;
          let a = vfx_sdf_curve_value(curve,start);
          let b = vfx_sdf_curve_value(curve,end);
          let piece = vec4f(a,a+vfx_sdf_curve_derivative(curve,start)/48.0,
            b-vfx_sdf_curve_derivative(curve,end)/48.0,b);
          if (!all(piece > vec4f(surface_radius+margin))) { break; }
          advance_time = max(advance_time,span*end);
        }
      }
    }
  }
  return VfxSdfSample(distance,coverage,0u,gradient,advance_time);
}
fn vfx_sdf_normal(p: vec3f) -> vec3f {
  let sample = vfx_sdf_sample(p,vec3f(0),0.0,0.0);
  if (sample.status != 0u) { return vec3f(0); }
  return sample.gradient/max(length(sample.gradient),1e-20);
}
// Swept sphere: at most 64 field samples and four contacts per fixed tick.
// The normal is the exact derivative of the same eight-corner sample; no
// additional finite-difference queries or second distance representation.
// On work exhaustion it stops at the last checked position; callers observe
// status rather than silently completing an unchecked high-speed segment.
// Radius and distance are world units. Restitution is normal speed ratio [0,1];
// friction removes a fraction [0,1] of tangential velocity at each contact.
fn forgeax_vfx_sdf_sweep(position: vec3f, velocity: vec3f, delta: f32,
                   response: vec3f) -> VfxSdfCollision {
  let radius=response.x; let restitution=response.y; let friction=response.z;
  var out = VfxSdfCollision(position,0u,velocity,0u,vec3f(0),0u);
  let expansion = forgeax_vfx_scene_sdf.ranges.y;
  let spacing = forgeax_vfx_scene_sdf.origin_spacing.w;
  let surface_radius = radius + expansion;
  if (!(all(abs(position) <= vec3f(3.402823e38)) && all(abs(velocity) <= vec3f(3.402823e38))
      && radius >= 0.0 && delta >= 0.0 && delta <= 3.402823e38 && restitution >= 0.0 && restitution <= 1.0
      && friction >= 0.0 && friction <= 1.0 && surface_radius < forgeax_vfx_scene_sdf.ranges.x)) {
    out.status = 5u; return out;
  }
  var remaining = delta;
  let epsilon = max(spacing * 0.001, 1e-6);
  for (var step = 0u; step < 64u; step++) {
    let sample = vfx_sdf_sample(out.position,out.velocity,remaining,surface_radius); out.samples++;
    if (sample.status != 0u) { out.status = sample.status; return out; }
    let clearance = sample.distance - surface_radius;
    if (clearance <= epsilon) {
      let magnitude = length(sample.gradient);
      let n = sample.gradient / max(magnitude, 1e-20);
      if (dot(n,n) < 0.5) { out.status = 4u; return out; }
      // Four resolved contacts are permitted; stop before a fifth response.
      if (out.contacts == 4u) { out.status = 3u; return out; }
      out.normal = n; out.contacts++; out.status = 1u;
      // Distance changes in gradient units. Clear the contact threshold with
      // a bounded numerical margin rather than asymptotically re-hitting it.
      out.position += n * max(0.0, (2.0*epsilon-clearance)/max(magnitude,1e-20));
      let vn = dot(out.velocity,n);
      if (vn < 0.0) {
        out.velocity = (out.velocity-n*vn)*(1.0-friction)-n*vn*restitution;
      }

    }
    let speed = length(out.velocity);
    if (remaining <= 0.0 || speed <= 1e-12) { return out; }
    if (step == 63u) { out.status = 3u; return out; }
    // Conservative distance marching also resolves thin unsigned sheets;
    // never jump by a minimum voxel step across a possible surface.
    let travel = max(clearance, epsilon) * 0.8;
    // Retain the global conservative step at cell boundaries. The same eight
    // corners certify a clear ray prefix inside the current trilinear cell.
    var time_step = travel / speed;
    if (clearance > epsilon) { time_step = max(time_step,sample.advance_time); }
    let dt = min(remaining,time_step);
    out.position += out.velocity * dt; remaining = max(0.0, remaining-dt);
  }
  out.status = 3u; return out;
}

// Preserve independent response values in mixed literal/runtime calls.
// The vector kernel boundary avoids reproduced loop-derived radius corruption.
fn vfx_sdf_collide(position:vec3f, velocity:vec3f, delta:f32,
                   radius:f32, restitution:f32, friction:f32) -> VfxSdfCollision {
  return forgeax_vfx_sdf_sweep(position,velocity,delta,vec3f(radius,restitution,friction));
}
`;
