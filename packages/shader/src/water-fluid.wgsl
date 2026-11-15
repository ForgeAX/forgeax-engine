#define_import_path forgeax_material::water_fluid

#if WATER_FLUID_SIMULATION == true
struct WaterFluidDescriptor {
  grid: vec4<f32>,
  state: vec4<f32>,
  generations: vec4<f32>,
  resolution: vec4<f32>,
  previousGrid: vec4<f32>,
  waveFoamGrid: vec4<f32>,
  previousWaveFoamGrid: vec4<f32>,
  waveFoamResolution: vec4<f32>,
};
@group(1) @binding(20) var waterFluidFields: texture_2d_array<f32>;
@group(1) @binding(21) var<storage, read> waterFluidDescriptors: array<WaterFluidDescriptor>;
#endif

fn waterFluidActive(bodyIndex: u32) -> bool {
#if WATER_FLUID_SIMULATION == true
  return bodyIndex < arrayLength(&waterFluidDescriptors) && waterFluidDescriptors[bodyIndex].state.y > 0.5;
#endif
  return false;
}

fn waterFluidUv(bodyIndex: u32, positionXZ: vec2<f32>) -> vec2<f32> {
#if WATER_FLUID_SIMULATION == true
  if (!waterFluidActive(bodyIndex)) { return vec2<f32>(0.5); }
  let descriptor = waterFluidDescriptors[bodyIndex];
  return (positionXZ - descriptor.grid.xy) / descriptor.grid.zw + vec2<f32>(0.5);
#endif
  return vec2<f32>(0.5);
}

fn waterFluidFoamActive(bodyIndex: u32) -> bool {
#if WATER_FLUID_SIMULATION == true
  if (waterFluidActive(bodyIndex)) { return waterFluidDescriptors[bodyIndex].generations.z > 0.5; }
#endif
  return false;
}

fn waterFluidSharedFoamActive(bodyIndex: u32) -> bool {
#if WATER_FLUID_SIMULATION == true
  return bodyIndex < arrayLength(&waterFluidDescriptors) && waterFluidDescriptors[bodyIndex].generations.w > 0.5;
#endif
  return false;
}

fn waterFluidFoamUv(bodyIndex: u32, positionXZ: vec2<f32>) -> vec2<f32> {
#if WATER_FLUID_SIMULATION == true
  if (waterFluidFoamActive(bodyIndex)) {
    let grid = waterFluidDescriptors[bodyIndex].waveFoamGrid;
    return (positionXZ - grid.xy) / grid.zw + vec2<f32>(0.5);
  }
#endif
  return vec2<f32>(0.5);
}

fn waterFluidSampleUvWithSampler(bodyIndex: u32, uv: vec2<f32>, field: u32, repeat: bool, linear: bool) -> vec4<f32> {
#if WATER_FLUID_SIMULATION == true
  if (!waterFluidActive(bodyIndex)) { return vec4<f32>(0.0); }
  let descriptor = waterFluidDescriptors[bodyIndex];
  let size = vec2<i32>(select(descriptor.resolution.xy, descriptor.waveFoamResolution.xy, field == 3u));
  let pixel = uv * vec2<f32>(size) - vec2<f32>(0.5);
  let base = vec2<i32>(floor(pixel)); let weight = fract(pixel);
  let layer = i32(descriptor.state.x) + i32(field);
  if (!linear) {
    let nearest = vec2<i32>(floor(pixel + vec2<f32>(0.5)));
    let coordinate = select(clamp(nearest, vec2<i32>(0), size - vec2<i32>(1)), (nearest % size + size) % size, repeat);
    return textureLoad(waterFluidFields, coordinate, layer, 0);
  }
  let aPosition = select(clamp(base, vec2<i32>(0), size - vec2<i32>(1)), (base % size + size) % size, repeat);
  let bBase = base + vec2<i32>(1, 0);
  let bPosition = select(clamp(bBase, vec2<i32>(0), size - vec2<i32>(1)), (bBase % size + size) % size, repeat);
  let cBase = base + vec2<i32>(0, 1);
  let cPosition = select(clamp(cBase, vec2<i32>(0), size - vec2<i32>(1)), (cBase % size + size) % size, repeat);
  let dBase = base + vec2<i32>(1, 1);
  let dPosition = select(clamp(dBase, vec2<i32>(0), size - vec2<i32>(1)), (dBase % size + size) % size, repeat);
  let a = textureLoad(waterFluidFields, aPosition, layer, 0);
  let b = textureLoad(waterFluidFields, bPosition, layer, 0);
  let c = textureLoad(waterFluidFields, cPosition, layer, 0);
  let d = textureLoad(waterFluidFields, dPosition, layer, 0);
  return mix(mix(a, b, weight.x), mix(c, d, weight.x), weight.y);
#endif
  return vec4<f32>(0.0);
}

fn waterFluidSampleUv(bodyIndex: u32, uv: vec2<f32>, field: u32) -> vec4<f32> {
#if WATER_FLUID_SIMULATION == true
  if (waterFluidActive(bodyIndex)) {
    let descriptor = waterFluidDescriptors[bodyIndex];
    return waterFluidSampleUvWithSampler(bodyIndex, uv, field,
      (u32(descriptor.resolution.z) & (1u << field)) != 0u,
      (u32(descriptor.resolution.w) & (1u << field)) != 0u);
  }
#endif
  return vec4<f32>(0.0);
}

fn waterFluidSample(bodyIndex: u32, positionXZ: vec2<f32>, field: u32) -> vec4<f32> {
#if WATER_FLUID_SIMULATION == true
  if (field == 3u) {
    if (!waterFluidFoamActive(bodyIndex)) { return vec4<f32>(0.0); }
    return waterFluidSampleUv(bodyIndex, waterFluidFoamUv(bodyIndex, positionXZ), field);
  }
  if (field == 4u && waterFluidActive(bodyIndex)) {
    let grid = waterFluidDescriptors[bodyIndex].previousGrid;
    return waterFluidSampleUv(bodyIndex, (positionXZ - grid.xy) / grid.zw + vec2<f32>(0.5), field);
  }
#endif
  return waterFluidSampleUv(bodyIndex, waterFluidUv(bodyIndex, positionXZ), field);
}
