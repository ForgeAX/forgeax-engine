#define_import_path shadertoy::fractal_pyramid

// fractal-pyramid.wgsl -- WGSL port of the Shadertoy raymarcher
//   "fractal pyramid" by leon, https://www.shadertoy.com/view/tsXBzS
//
// This is a fullscreen-quad effect: the vertex stage emits the screen-space
// clip positions directly (the geometry is a unit plane in [-1,1] NDC) so the
// camera transform is bypassed entirely. The fragment stage runs the ported
// distance-field raymarcher.
//
// Shadertoy -> WGSL mapping:
//   - iResolution.xy -> uniforms.iResolution (vec2; the canvas pixel size).
//   - iTime          -> uniforms.iTime (seconds; driven by the app raf loop).
//   - fragCoord      -> the interpolated pixel coordinate, reconstructed from
//                       the [0,1] UV * iResolution (WebGPU has UV origin at the
//                       top-left, so V is flipped to match GLSL's bottom-left
//                       fragCoord convention).
//
// The two scalars ride in the @group(1) @binding(0) material UBO. paramSchema
// declares `iResolution` (vec2) first then `iTime` (f32); `derive()` merges
// them into one std140 uniform block: iResolution at offset 0 (8 bytes),
// iTime at offset 8. The app mutates paramValues.iTime every frame.

struct VsIn {
  @location(0) pos    : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) uv     : vec2<f32>,
};

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0)       uv   : vec2<f32>,
};

@vertex
fn vs_main(in : VsIn) -> VsOut {
  // The plane is authored in [-0.5, 0.5] on XY; scale x2 to fill NDC [-1, 1].
  var out : VsOut;
  out.clip = vec4<f32>(in.pos.xy * 2.0, 0.0, 1.0);
  out.uv = in.uv;
  return out;
}

fn palette(d : f32) -> vec3<f32> {
  return mix(vec3<f32>(0.2, 0.7, 0.9), vec3<f32>(1.0, 0.0, 1.0), d);
}

fn rotate(p : vec2<f32>, a : f32) -> vec2<f32> {
  let c = cos(a);
  let s = sin(a);
  return vec2<f32>(p.x * c + p.y * s, -p.x * s + p.y * c);
}

fn map(p_in : vec3<f32>) -> f32 {
  var p = p_in;
  for (var i = 0; i < 8; i = i + 1) {
    let t = material.iTime * 0.2;
    let xz0 = rotate(p.xz, t);
    p.x = xz0.x;
    p.z = xz0.y;
    let xy = rotate(p.xy, t * 1.89);
    p.x = xy.x;
    p.y = xy.y;
    p.x = abs(p.x);
    p.z = abs(p.z);
    p.x = p.x - 0.5;
    p.z = p.z - 0.5;
  }
  return dot(sign(p), p) / 5.0;
}

fn rm(ro : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  var t = 0.0;
  var col = vec3<f32>(0.0);
  var d = 0.0;
  for (var i = 0.0; i < 64.0; i = i + 1.0) {
    let p = ro + rd * t;
    d = map(p) * 0.5;
    if (d < 0.02) {
      break;
    }
    if (d > 100.0) {
      break;
    }
    col = col + palette(length(p) * 0.1) / (400.0 * d);
    t = t + d;
  }
  return vec4<f32>(col, 1.0 / (d * 100.0));
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  // Reconstruct fragCoord from UV. Flip V so the image matches the GLSL
  // bottom-left origin (WebGPU UV origin is top-left).
  let fragCoord = vec2<f32>(in.uv.x, 1.0 - in.uv.y) * material.iResolution;
  let uv = (fragCoord - material.iResolution * 0.5) / material.iResolution.x;

  var ro = vec3<f32>(0.0, 0.0, -50.0);
  let roxz = rotate(ro.xz, material.iTime);
  ro.x = roxz.x;
  ro.z = roxz.y;

  let cf = normalize(-ro);
  let cs = normalize(cross(cf, vec3<f32>(0.0, 1.0, 0.0)));
  let cu = normalize(cross(cf, cs));

  let uuv = ro + cf * 3.0 + uv.x * cs + uv.y * cu;
  let rd = normalize(uuv - ro);

  let col = rm(ro, rd);
  return vec4<f32>(col.rgb, 1.0);
}
