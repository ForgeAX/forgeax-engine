#define_import_path water_r3::caustics_pattern
// A periodic, connected light network authored through the ordinary TextureGenerator.
// Warped cellular boundaries make curved folds; three-way junctions concentrate light.
fn causticsSite(cell: vec2<f32>) -> vec2<f32> {
  let wrapped = cell - floor(cell / 6.0) * 6.0;
  let phase = vec2<f32>(dot(wrapped, vec2<f32>(127.1, 311.7)),
    dot(wrapped, vec2<f32>(269.5, 183.3)));
  return 0.5 + (fract(sin(phase) * 43758.5453) - 0.5) * 0.84;
}

@fragment fn pattern(@builtin(position) pixel: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = pixel.xy / 512.0;
  let phase = uv * 6.283185307;
  let warp = 0.26 * vec2<f32>(sin(phase.y + sin(phase.x)),
    sin(phase.x * 2.0 + cos(phase.y)))
    + 0.10 * vec2<f32>(sin(phase.x * 3.0 + phase.y * 2.0),
      cos(phase.y * 3.0 - phase.x * 2.0));
  let p = uv * 6.0 + warp;
  let cell = floor(p);
  var nearest = vec3<f32>(100.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let siteCell = cell + vec2<f32>(f32(x), f32(y));
      let d = distance(p, siteCell + causticsSite(siteCell));
      if (d < nearest.x) {
        nearest = vec3<f32>(d, nearest.xy);
      } else if (d < nearest.y) {
        nearest = vec3<f32>(nearest.x, d, nearest.y);
      } else {
        nearest.z = min(nearest.z, d);
      }
    }
  }
  let edge = nearest.y - nearest.x;
  let junction = 1.0 - smoothstep(0.025, 0.16, nearest.z - nearest.x);
  let variation = 0.5 + 0.5 * sin(phase.x * 2.0 + sin(phase.y * 3.0));
  let width = mix(0.025, 0.047, variation) + junction * 0.025;
  let core = 1.0 - smoothstep(width * 0.22, width, edge);
  let halo = (1.0 - smoothstep(width, width * 2.7, edge)) * 0.24;
  let light = max(core * mix(0.88, 0.98, variation), halo);
  return vec4<f32>(vec3<f32>(min(light + junction * core * 0.12, 1.0)), 1.0);
}
