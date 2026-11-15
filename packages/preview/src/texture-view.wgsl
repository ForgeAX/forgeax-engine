#define_import_path texture_preview::texture___DIMENSION__
#import forgeax_view::common::{view}
#import forgeax_pbr::ibl_shared::{sampleSphericalMap}

struct VertexOut {
  @builtin(position) position: vec4<f32>,
};
@vertex fn vs_main(@location(2) uv: vec2<f32>) -> VertexOut {
  return VertexOut(vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0));
}

fn loadPixel(position: vec2<i32>, size: vec2<i32>, mip: i32, layer: i32) -> vec4<f32> {
  var p = clamp(position, vec2<i32>(0), size - vec2<i32>(1));
  if (material.background.y > 0.5) {
    p.x = ((position.x % size.x) + size.x) % size.x;
  }
  return __LOAD__;
}

fn samplePixel(uv: vec2<f32>, mip: i32, layer: i32) -> vec4<f32> {
  let size = vec2<i32>(textureDimensions(sourceTexture, mip).xy);
  let p = uv * vec2<f32>(size) - 0.5;
  if (material.display.z < 0.5) {
    return loadPixel(vec2<i32>(floor(p + 0.5)), size, mip, layer);
  }
  let lo = vec2<i32>(floor(p));
  let f = fract(p);
  return mix(mix(loadPixel(lo, size, mip, layer), loadPixel(lo + vec2<i32>(1, 0), size, mip, layer), f.x),
    mix(loadPixel(lo + vec2<i32>(0, 1), size, mip, layer), loadPixel(lo + vec2<i32>(1, 1), size, mip, layer), f.x), f.y);
}

fn faceDirection(face: i32, uv: vec2<f32>) -> vec3<f32> {
  let p = uv * 2.0 - 1.0;
  switch face {
    case 0: { return vec3<f32>(1.0, -p.y, -p.x); }
    case 1: { return vec3<f32>(-1.0, -p.y, p.x); }
    case 2: { return vec3<f32>(p.x, 1.0, p.y); }
    case 3: { return vec3<f32>(p.x, -1.0, -p.y); }
    case 4: { return vec3<f32>(p.x, -p.y, 1.0); }
    default: { return vec3<f32>(-p.x, -p.y, -1.0); }
  }
}

fn environmentUv(direction: vec3<f32>) -> vec2<f32> {
  return sampleSphericalMap(normalize(direction));
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let viewport = vec2<f32>(view.viewportWidth, view.viewportHeight);
  let pixel = in.position.xy;
  let mode = i32(material.presentation.x);
  let mip = i32(material.display.x);
  let dimensions = vec2<f32>(textureDimensions(sourceTexture, mip).xy);
  let depth = __DEPTH__;
  let columns = exp2(ceil(log2(ceil(sqrt(depth)))));
  let rows = ceil(depth / columns);
  var displaySize = dimensions;
  if (mode == 2) { displaySize = vec2<f32>(dimensions.x, dimensions.x * 0.75); }
  if (mode == 3) { displaySize = vec2<f32>(dimensions.y); }
  if (mode == 4) { displaySize = dimensions * vec2<f32>(columns, rows); }
  if (mode == 5) { displaySize = vec2<f32>(max(dimensions.x, dimensions.y)); }
  let fit = min(viewport.x / displaySize.x, viewport.y / displaySize.y) * 0.9;
  let scale = select(material.presentation.z, fit, material.presentation.z == 0.0);
  var uv = (pixel - viewport * 0.5 - material.panRotation.xy) / (displaySize * scale) + 0.5;
  var inside = all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0));
  var layer = i32(material.display.y);
  if (mode == 1) {
    let p = (pixel - viewport * 0.5) / viewport.y;
    let zoom = select(material.presentation.z, 1.0, material.presentation.z == 0.0);
    var d = normalize(vec3<f32>(p.x, -p.y, -0.7 * zoom));
    let pitch = material.panRotation.w;
    d = vec3<f32>(d.x, d.y * cos(pitch) - d.z * sin(pitch), d.y * sin(pitch) + d.z * cos(pitch));
    let yaw = material.panRotation.z;
    d = vec3<f32>(d.x * cos(yaw) + d.z * sin(yaw), d.y, -d.x * sin(yaw) + d.z * cos(yaw));
    uv = environmentUv(d);
    inside = true;
  } else if (mode == 2) {
    let cell = vec2<i32>(floor(uv * vec2<f32>(4.0, 3.0)));
    var face = -1;
    if (cell.y == 1) {
      switch cell.x { case 0: { face = 1; } case 1: { face = 4; } case 2: { face = 0; } case 3: { face = 5; } default: {} }
    } else if (cell.x == 1 && cell.y == 0) { face = 2;
    } else if (cell.x == 1 && cell.y == 2) { face = 3; }
    inside = inside && face >= 0;
    uv = environmentUv(faceDirection(face, fract(uv * vec2<f32>(4.0, 3.0))));
  } else if (mode == 3) {
    uv = environmentUv(faceDirection(i32(material.presentation.y), uv));
  } else if (mode == 4) {
    let cell = min(floor(uv * vec2<f32>(columns, rows)), vec2<f32>(columns - 1.0, rows - 1.0));
    layer = i32(cell.y * columns + cell.x);
    inside = inside && f32(layer) < depth;
    uv = fract(uv * vec2<f32>(columns, rows));
  } else if (mode == 5) {
    // Orthographic box surface: three faces sample the same retained volume.
    let right = normalize(vec3<f32>(1.0, 0.0, -1.0));
    let up = normalize(vec3<f32>(-1.0, 2.0, -1.0));
    let direction = normalize(vec3<f32>(-1.0, -1.0, -1.0));
    let origin = vec3<f32>(0.5) + right * (uv.x - 0.5) * 1.8 + up * (0.5 - uv.y) * 1.8 - direction * 2.0;
    let a = (vec3<f32>(0.0) - origin) / direction;
    let b = (vec3<f32>(1.0) - origin) / direction;
    let near = min(a, b);
    let far = max(a, b);
    let entry = max(max(near.x, near.y), near.z);
    let exit = min(min(far.x, far.y), far.z);
    inside = inside && exit >= entry;
    let point = clamp(origin + direction * entry, vec3<f32>(0.0), vec3<f32>(1.0));
    uv = point.xy;
    layer = i32(round(point.z * (depth - 1.0)));
  }
  var background = vec3<f32>(0.018);
  if (inside) {
    let checker = (i32(floor(pixel.x / 12.0)) + i32(floor(pixel.y / 12.0))) % 2;
    background = vec3<f32>(select(0.045, 0.12, checker == 1));
    if (material.background.x == 1.0) { background = vec3<f32>(0.0); }
    if (material.background.x == 2.0) { background = vec3<f32>(1.0); }
  }
  let texel = samplePixel(uv, mip, clamp(layer, 0, i32(depth) - 1));
  let count = dot(material.channels.rgb, vec3<f32>(1.0));
  var rgb = texel.rgb * material.channels.rgb * material.display.w;
  var alpha = select(1.0, texel.a, material.channels.a > 0.5);
  if (count == 0.0 && material.channels.a > 0.5) {
    rgb = vec3<f32>(texel.a); alpha = 1.0;
  } else if (count == 1.0 || material.presentation.w > 0.5) {
    rgb = vec3<f32>(dot(rgb, vec3<f32>(1.0)) / max(count, 1.0));
  }
  if (material.background.x == 3.0) {
    return select(vec4<f32>(0.0), vec4<f32>(rgb, alpha), inside);
  }
  return vec4<f32>(select(background, mix(background, rgb, alpha), inside), 1.0);
}
