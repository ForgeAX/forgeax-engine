export type WaterFluidStage =
  | 'initialize'
  | 'forces'
  | 'velocity-forces'
  | 'ripple'
  | 'advect-height'
  | 'advect-velocity'
  | 'height-divergence'
  | 'gravity'
  | 'normal-height'
  | 'wave'
  | 'foam-diffuse'
  | 'foam-tonemap'
  | 'contact-foam'
  | 'shallow-foam'
  | 'atlas';

const FULLSCREEN = /* wgsl */ `
struct VertexOutput { @builtin(position) position: vec4<f32> };
@vertex fn vs_main(@builtin(vertex_index) vertex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return VertexOutput(vec4<f32>(positions[vertex], 0.0, 1.0));
}
`;
const equations: Readonly<Record<WaterFluidStage, string>> = {
  'shallow-foam': `
    let world = p[1].xy + (uv - vec2<f32>(0.5)) * p[1].zw;
    let mapping = textureLoad(source2, vec2<i32>(0, 0), 0);
    let settings = textureLoad(source2, vec2<i32>(1, 0), 0);
    var foam = sample0(uv).r;
    if (all(mapping.zw > vec2<f32>(0.0))) {
      let offset = world - mapping.xy;
      let c = cos(settings.x); let s = sin(settings.x);
      let local = vec2<f32>(c * offset.x + s * offset.y, -s * offset.x + c * offset.y) / mapping.zw + vec2<f32>(0.5);
      if (all(local >= vec2<f32>(0.0)) && all(local <= vec2<f32>(1.0))) {
        let edgeCells = min(local, vec2<f32>(1.0) - local) * vec2<f32>(textureDimensions(source1));
        let weight = smoothstep(0.0, 4.0, min(edgeCells.x, edgeCells.y));
        foam = max(foam, sample1(local).r * weight);
      }
    }
    return vec4<f32>(foam, 0.0, 0.0, 1.0);`,
  'contact-foam': `
    let world = p[1].xy + (uv - vec2<f32>(0.5)) * p[1].zw;
    var foam = sample0(uv).r * exp(-p[2].x * p[0].z);
    for (var i = 0u; i < u32(p[0].w); i++) {
      let brush = inputs[i * 2u];
      let motion = inputs[i * 2u + 1u];
      let feather = max(p[1].z / p[0].x, brush.z * 0.15);
      let distance = length(world - brush.xy);
      let rim = 1.0 - smoothstep(0.0, feather, abs(distance - brush.z));
      let disk = 1.0 - smoothstep(max(0.0, brush.z - feather), brush.z + feather, distance);
      let coverage = select(rim, disk, motion.w > 0.5);
      foam = max(foam, coverage * brush.w * exp(-p[2].x * motion.z));
    }
    return vec4<f32>(clamp(foam, 0.0, 1.0), 0.0, 0.0, 1.0);`,
  initialize: `
    if (p[8].w > 0.5) {
      let field = terrain(uv);
      return vec4<f32>(max(field.x - field.y, 0.0), field.y, 0.0, 1.0);
    }
    return p[11];`,
  forces: `
    var result = p[12];
    let world = p[1].xy + (uv - vec2<f32>(0.5)) * p[1].zw;
    for (var i = 0u; i < u32(p[0].w); i++) {
      let brush = inputs[i * 3u]; let extra = inputs[i * 3u + 1u];
      let weight = clamp(1.0 - length((world - brush.xy) / brush.z), 0.0, 1.0);
      let brushUv = (world - brush.xy) / (2.0 * brush.z) + vec2<f32>(0.5);
      let noise = textureSample(source0, impulseNoiseSampler, brushUv).r;
      result.r += brush.w * weight * impulseNoisePower(noise);
      result.g += clamp((weight - 0.75) / 0.25, 0.0, 1.0)
        * max(abs(brush.w * 100.0) - 0.25, 0.0) * extra.x;
    }
    return result;`,
  'velocity-forces': `
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);`,
  ripple: `
    let offset = (p[1].xy - p[2].xy) / p[1].zw;
    let offset2 = (p[1].xy - p[3].xy) / p[1].zw;
    let h = sample0(uv + offset).r;
    let previous = sample1(uv + offset2).r;
    let sum4 = sample0(uv + offset + vec2<f32>(texel.x, 0.0)).r
      + sample0(uv + offset - vec2<f32>(texel.x, 0.0)).r
      + sample0(uv + offset + vec2<f32>(0.0, texel.y)).r
      + sample0(uv + offset - vec2<f32>(0.0, texel.y)).r;
    let force = sample2(uv);
    let height = (0.5 * (4.0 * h + p[4].x * (sum4 - 4.0 * h)) - previous)
      * clamp(1.0 - p[4].y, 0.0, 1.0) + force.r;
    let shore = select(1.0, clamp(terrain(uv).x - terrain(uv).y, 0.0, 1.0), p[8].w > 0.5);
    let mask = clamp(ceil(force.a - p[5].w), 0.0, 1.0);
    let q = uv + offset;
    let foamAverage = (sample0(q).g + sample0(q + vec2<f32>(texel.x, 0.0)).g
      + sample0(q - vec2<f32>(texel.x, 0.0)).g + sample0(q + vec2<f32>(0.0, texel.y)).g
      + sample0(q - vec2<f32>(0.0, texel.y)).g) / 5.0;
    let erasure = max(-h * 100.0 - 2.0, 0.0) * p[19].w;
    let foam = clamp(foamAverage + erasure, 1.5 / p[0].x, 1.0 - 1.5 / p[0].x) * p[19].z;
    return vec4<f32>(vec2<f32>(height, foam + abs(force.g)) * mask * shore, 0.0, 1.0);`,
  'advect-height': `
    let offset = (p[1].xy - p[2].xy) / p[1].zw;
    let q = uv + offset;
    let velocity = 0.5 * (sample1(q).rg + vec2<f32>(
      sample1(q + vec2<f32>(texel.x, 0.0)).r,
      sample1(q + vec2<f32>(0.0, texel.y)).g));
    let source = sample0(q - velocity * p[0].z / p[1].zw);
    var depth = source.r - p[5].y * p[0].z + sample2(uv).r;
    var bed = 0.0;
    if (p[7].z > 0.5) {
      let field = terrain(uv);
      let targetDepth = max(field.x - field.y, 0.0);
      let start = select(targetDepth, depth, source.g > -650.0);
      depth = mix(start, targetDepth, 1.0 - exp(-p[15].y * p[0].z));
      bed = mix(field.y, -targetDepth, p[15].z);
    }
    var foam = 0.0;
    if (p[7].w > 0.5) {
      let normal = normal0(q, p[15].w, 0.0, 0.0);
      foam = source.b * clamp(1.0 - p[16].x * p[0].z, 0.0, 1.0)
        + p[16].y * clamp(length(sample1(q).rg) / p[16].z, 0.0, 1.0)
          * clamp((length(normal.xz) - p[16].w) / p[17].x, 0.0, 1.0);
    }
    return vec4<f32>(depth, bed, foam, 1.0);`,
  'advect-velocity': `
    let offset = (p[1].xy - p[2].xy) / p[1].zw;
    let q = uv + offset;
    let vx = sample0(q).r;
    let vz = sample0(q).g;
    let vxOther = sample0(q + vec2<f32>(-texel.x, texel.y) * 0.5).g;
    let vzOther = sample0(q + vec2<f32>(texel.x, -texel.y) * 0.5).r;
    return vec4<f32>(sample0(q - vec2<f32>(vx, vxOther) * p[0].z / (2.0 * p[1].zw)).r,
      sample0(q - vec2<f32>(vzOther, vz) * p[0].z / (2.0 * p[1].zw)).g, 0.0, 1.0);`,
  'height-divergence': `
    let value = sample0(uv);
    let velocity = sample1(uv).rg;
    let cell = p[1].zw / (p[0].xy - vec2<f32>(1.0));
    let divergence = (sample1(uv + vec2<f32>(texel.x, 0.0)).r - velocity.x) / cell.x
      + (sample1(uv + vec2<f32>(0.0, texel.y)).g - velocity.y) / cell.y;
    let expansion = clamp(max(divergence * p[0].z, 0.0), 0.0, 1.0);
    let depth = max(value.r / (1.0 + expansion), 0.0);
    // The source copies bed centimeters into its scalar foam channel at this boundary.
    return vec4<f32>(depth, value.g, value.g * 100.0, 1.0);`,
  gravity: `
    let value = sample0(uv);
    let left = sample0(uv - vec2<f32>(texel.x, 0.0));
    let down = sample0(uv - vec2<f32>(0.0, texel.y));
    let surface = value.r + value.g;
    let cell = p[1].zw / (p[0].xy - vec2<f32>(1.0));
    let slope = (vec2<f32>(left.r + left.g, down.r + down.g) - vec2<f32>(surface)) / cell;
    let edgeDepth = select(vec2<f32>(value.r), vec2<f32>(left.r, down.r),
      vec2<f32>(left.r + left.g, down.r + down.g) > vec2<f32>(surface));
    let wetEdge = clamp(edgeDepth / p[15].x, vec2<f32>(0.0), vec2<f32>(1.0));
    let acceleration = slope * p[4].w * p[0].z * wetEdge;
    let velocity = (sample1(uv).rg + acceleration) * exp(-p[4].z * p[0].z);
    return vec4<f32>(velocity, 0.0, 1.0);`,
  'normal-height': `
    if (p[7].x < 0.5) {
      // M_RT_Normals keeps its material defaults; BP only replaces the RT input.
      let offset = 1.0 / 1024.0;
      let positiveX = sample0(uv + vec2<f32>(offset, 0.0)).r;
      let negativeX = sample0(uv - vec2<f32>(offset, 0.0)).r;
      let positiveY = sample0(uv + vec2<f32>(0.0, offset)).r;
      let negativeY = sample0(uv - vec2<f32>(0.0, offset)).r;
      let normal = normalize(vec3<f32>(-(positiveX - negativeX) / 0.01, 1.0,
        -(positiveY - negativeY) / 0.01));
      return vec4<f32>(normal.xz, positiveX, 1.0);
    }
    let value = sample0(uv);
    let normal = normal0(uv, p[5].z, p[18].y, p[18].z);
    let ao = clamp((boxMask2D(uv, p[18].w) - 0.02) / 0.98, 0.0, 1.0);
    return vec4<f32>(vec3<f32>(normal.xz, value.r - p[18].x) * ao, clamp(ao * value.b, 0.0, 1.0));`,
  wave: `
    let world = p[1].xy + (uv - vec2<f32>(0.5)) * p[1].zw;
    var wave = legacyGerstner(world);
    for (var iteration = 0u; iteration < 4u; iteration++) {
      wave = legacyGerstner(world - wave.displacement.xz);
    }
    let crest = sqrt(boxMask2D(uv, p[6].w)) * (
      clamp(-wave.normal.y - p[17].y, 0.0, 1.0) * p[6].x
      + max((wave.displacement.y - p[17].z) / p[17].w, 0.0));
    return vec4<f32>(crest, sample0(uv).r, wave.displacement.y, 1.0);`,
  'foam-diffuse': `
    let offset = (p[1].xy - p[2].xy) / p[1].zw;
    let q = uv + offset;
    let current = sample0(q);
    let average = (current.r + sample0(q + vec2<f32>(texel.x, 0.0)).r + sample0(q - vec2<f32>(texel.x, 0.0)).r
      + sample0(q + vec2<f32>(0.0, texel.y)).r + sample0(q - vec2<f32>(0.0, texel.y)).r);
    let wave = sample1(uv);
    let distance = max(abs(uv - vec2<f32>(.5)) - vec2<f32>(.5 - p[13].x), vec2<f32>(0.0));
    let edge = pow(1.0 - clamp(length(distance) / p[13].x, 0.0, 1.0), 1.0 / 16.0);
    return vec4<f32>((mix(current.r, average / 5.0, p[6].z) * (1.0 - p[6].y) + wave.r) * edge,
      clamp(wave.g * p[13].y + current.g * (1.0 - p[13].z), 0.0, 1.0), wave.b, 1.0);`,
  'foam-tonemap': `let value = sample0(uv); return vec4<f32>(1.0 - exp(-value.r * p[13].w), value.gb, 1.0);`,
  atlas: `
    let pixel = vec2<i32>(input.position.xy);
    if (any(pixel >= vec2<i32>(textureDimensions(source0)))) { return vec4<f32>(0.0); }
    return textureLoad(source0, pixel, 0);`,
};

/** Ripple's solver material clamps; other stages retain source texture addressing and filtering. */
export function waterFluidShader(
  stage: WaterFluidStage,
  count: number,
  linear: readonly boolean[],
  waterInfo: boolean,
  repeat: readonly boolean[] = [],
): string {
  const textures = Array.from(
    { length: count },
    (_, index) => `@group(0) @binding(${index}) var source${index}: texture_2d<f32>;`,
  ).join('\n');
  const samples = Array.from(
    { length: count },
    (_, index) => `
fn tap${index}(pixel: vec2<i32>) -> vec4<f32> {
  let size = vec2<i32>(textureDimensions(source${index}));
  return textureLoad(source${index}, ${stage !== 'ripple' && repeat[index] === true ? '(pixel % size + size) % size' : 'clamp(pixel, vec2<i32>(0), size - vec2<i32>(1))'}, 0);
}
fn sample${index}(uv: vec2<f32>) -> vec4<f32> {
  let pixel = uv * vec2<f32>(textureDimensions(source${index})) - vec2<f32>(0.5);
  ${
    linear[index] === false
      ? `return tap${index}(vec2<i32>(floor(pixel + vec2<f32>(0.5))));`
      : `
  let base = vec2<i32>(floor(pixel)); let weight = fract(pixel);
  return mix(mix(tap${index}(base), tap${index}(base + vec2<i32>(1,0)), weight.x),
    mix(tap${index}(base + vec2<i32>(0,1)), tap${index}(base + vec2<i32>(1,1)), weight.x), weight.y);`
  }
}`,
  ).join('\n');
  return `${FULLSCREEN}
${textures}
@group(0) @binding(${count}) var<storage, read> p: array<vec4<f32>>;
@group(0) @binding(${count + 1}) var<storage, read> inputs: array<vec4<f32>>;
${waterInfo ? `@group(0) @binding(${count + 2}) var waterInfo: texture_2d_array<f32>;` : ''}
${stage === 'forces' ? `@group(0) @binding(${count + 2}) var impulseNoiseSampler: sampler;` : ''}
${
  stage === 'forces'
    ? `fn impulseNoisePower(value: f32) -> f32 {
  if (value <= 2.980233e-8) { return 0.0; }
  return pow(value, 0.001);
}`
    : ''
}
${samples}
${
  stage === 'wave'
    ? `
struct LegacyWave { displacement: vec3<f32>, normal: vec3<f32> };
fn legacyGerstner(world: vec2<f32>) -> LegacyWave {
  var displacement = vec3<f32>(0.0);
  var normal = vec3<f32>(0.0);
  for (var index = 0u; index < u32(p[19].x); index++) {
    let wave = inputs[index * 2u];
    let shape = inputs[index * 2u + 1u];
    let phase = dot(world, wave.xy) * shape.y - shape.z * p[19].y;
    let sine = sin(phase); let cosine = cos(phase);
    let horizontal = -shape.w * wave.z * sine;
    displacement += vec3<f32>(wave.x * horizontal, wave.z * cosine, wave.y * horizontal);
    normal += vec3<f32>(sine * wave.z * shape.y * wave.x,
      cosine * shape.x * clamp(wave.z * 50.0 / wave.w, 0.0, 1.0), sine * wave.z * shape.y * wave.y);
  }
  let waveNormal = normalize(vec3<f32>(normal.x, 1.0 - normal.y, normal.z));
  // Preserve the source renderer's float packing before each displaced-position call.
  let packed = floor(displacement * 10000.0) + (waveNormal + vec3<f32>(1.01)) / 2.02;
  return LegacyWave(floor(packed) / 10000.0, fract(packed) * 2.02 - vec3<f32>(1.01));
}`
    : ''
}
fn boxMask2D(uv: vec2<f32>, falloff: f32) -> f32 {
  let outside = max(abs(uv - vec2<f32>(0.5)) - vec2<f32>(0.5 - falloff), vec2<f32>(0.0));
  return 1.0 - clamp(length(outside) / falloff, 0.0, 1.0);
}
fn terrain(uv: vec2<f32>) -> vec2<f32> {
  ${
    waterInfo
      ? `let world = p[1].xy + (uv - vec2<f32>(0.5)) * p[1].zw;
  let infoUv = clamp((world - p[8].xy) / p[9].xy + vec2<f32>(0.5), vec2<f32>(0.0), vec2<f32>(1.0));
  let size = vec2<i32>(textureDimensions(waterInfo));
  let data = textureLoad(waterInfo, clamp(vec2<i32>(infoUv * vec2<f32>(size)), vec2<i32>(0), size - vec2<i32>(1)), i32(p[8].z), 0);
  let ground = data.a * (p[9].w - p[10].x) + p[10].x;
  let water = select(data.b * (p[9].w - p[9].z) + p[9].z, ground - 2.56, data.b == 0.0);
  return vec2<f32>(water, ground);`
      : 'return vec2<f32>(p[7].y, p[7].y - p[5].x);'
  }
}
${
  count > 0
    ? `fn elevation0(uv: vec2<f32>, foamDensity: f32, foamHeightScale: f32) -> f32 {
  let value = sample0(uv);
  let cell = p[1].z / (p[0].x - 1.0);
  return value.r + value.g + (1.0 - exp(-value.b * foamDensity)) * foamHeightScale * cell;
}
fn normal0(uv: vec2<f32>, heightScale: f32, foamDensity: f32, foamHeightScale: f32) -> vec3<f32> {
  let texel = vec2<f32>(1.0) / p[0].xy;
  let point = (floor(uv * p[0].xy) + vec2<f32>(0.5)) / p[0].xy;
  let cell = p[1].zw / (p[0].xy - vec2<f32>(1.0));
  let dx = (elevation0(point + vec2<f32>(texel.x, 0.0), foamDensity, foamHeightScale)
    - elevation0(point - vec2<f32>(texel.x, 0.0), foamDensity, foamHeightScale)) / (2.0 * cell.x);
  let dz = (elevation0(point + vec2<f32>(0.0, texel.y), foamDensity, foamHeightScale)
    - elevation0(point - vec2<f32>(0.0, texel.y), foamDensity, foamHeightScale)) / (2.0 * cell.y);
  return normalize(vec3<f32>(-dx * heightScale, 1.0, -dz * heightScale));
}`
    : ''
}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.position.xy / p[0].xy;
  let texel = vec2<f32>(1.0) / p[0].xy;
  ${equations[stage]}
}`;
}
