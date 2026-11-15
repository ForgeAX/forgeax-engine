#define_import_path forgeax_material::water_advanced_sampling

#if WATER_SHALLOW_SIMULATION == true
#import forgeax_material::parameters::{waterShallowGridTexture, waterShallowNormalTexture, waterShallowFoamTexture, waterShallowMappingTexture}
fn shallowRotate(value: vec2<f32>, angle: f32) -> vec2<f32> {
  return vec2<f32>(cos(angle) * value.x - sin(angle) * value.y, sin(angle) * value.x + cos(angle) * value.y);
}
fn shallowMappedUv(position: vec2<f32>, row: i32) -> vec2<f32> {
  let mapping=textureLoad(waterShallowMappingTexture,vec2<i32>(0,row),0);
  let settings=textureLoad(waterShallowMappingTexture,vec2<i32>(1,row),0);
  if(any(mapping.zw<=vec2<f32>(0.0))){return vec2<f32>(-1.0);}
  return shallowRotate(position - mapping.xy, -settings.x) / mapping.zw + vec2<f32>(0.5);
}
fn shallowUv(position: vec2<f32>) -> vec2<f32> { return shallowMappedUv(position,0); }
fn shallowPreviousUv(position: vec2<f32>) -> vec2<f32> { return shallowMappedUv(position,1); }
fn shallowDepthFlowAvailable() -> bool { return textureLoad(waterShallowMappingTexture,vec2<i32>(1,0),0).z<0.5; }
fn shallowResidualHeight(heightM: f32, row: i32, bodyReferenceM: f32) -> f32 {
  let settings=textureLoad(waterShallowMappingTexture,vec2<i32>(1,row),0);
  return heightM-select(bodyReferenceM,settings.w,settings.z>0.5);
}
fn shallowInside(uv: vec2<f32>) -> bool { return all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0)); }
fn shallowCompositionWeight(uv: vec2<f32>) -> f32 {
#if WATER_SHALLOW_ADDITIVE == true
  let dimensions = vec2<f32>(textureDimensions(waterShallowGridTexture)) * vec2<f32>(1.0, 0.5);
  let edgeCells = min(uv, vec2<f32>(1.0) - uv) * dimensions;
  return smoothstep(0.0, 4.0, min(edgeCells.x, edgeCells.y));
#else
  return 1.0;
#endif
}
fn shallowSampleCells(source: texture_2d<f32>, uv: vec2<f32>, dimensions: vec2<i32>, offset: vec2<i32>) -> vec4<f32> {
  let pixel = uv * vec2<f32>(dimensions) - 0.5;
  let low = vec2<i32>(floor(pixel)); let fraction = fract(pixel);
  let a = textureLoad(source, clamp(low, vec2<i32>(0), dimensions - 1)+offset, 0);
  let b = textureLoad(source, clamp(low + vec2<i32>(1,0), vec2<i32>(0), dimensions - 1)+offset, 0);
  let c = textureLoad(source, clamp(low + vec2<i32>(0,1), vec2<i32>(0), dimensions - 1)+offset, 0);
  let d = textureLoad(source, clamp(low + vec2<i32>(1,1), vec2<i32>(0), dimensions - 1)+offset, 0);
  return mix(mix(a,b,fraction.x),mix(c,d,fraction.x),fraction.y);
}
fn shallowSampleGrid(uv: vec2<f32>, row: i32) -> vec4<f32> {
  let atlas = vec2<i32>(textureDimensions(waterShallowGridTexture));
  let dimensions = vec2<i32>(atlas.x,atlas.y/2);
  return shallowSampleCells(waterShallowGridTexture,uv,dimensions,vec2<i32>(0,row*dimensions.y));
}
fn shallowGrid(uv: vec2<f32>) -> vec4<f32> { return shallowSampleGrid(uv,0); }
fn shallowPreviousGrid(uv: vec2<f32>) -> vec4<f32> { return shallowSampleGrid(uv,1); }
fn shallowSampleNormal(uv: vec2<f32>, row: i32) -> vec3<f32> {
  let atlas = vec2<i32>(textureDimensions(waterShallowNormalTexture));
  let dimensions = vec2<i32>(atlas.x,atlas.y/2);
  #if WATER_SHALLOW_ADDITIVE == true
  let sample = shallowSampleCells(waterShallowNormalTexture,uv,dimensions,vec2<i32>(0,row*dimensions.y));
  #else
  let sample = textureLoad(waterShallowNormalTexture, clamp(vec2<i32>(floor(uv * vec2<f32>(dimensions))),vec2<i32>(0),dimensions-1)+vec2<i32>(0,row*dimensions.y),0);
  #endif
  let settings=textureLoad(waterShallowMappingTexture,vec2<i32>(1,row),0);
  let up = select(sqrt(max(0.0,1.0-dot(sample.xy,sample.xy))),sample.z,settings.y>0.5);
  let horizontal = shallowRotate(sample.xy,settings.x);
  return normalize(vec3<f32>(horizontal.x,up,horizontal.y));
}
fn shallowSurfaceNormal(uv: vec2<f32>) -> vec3<f32> { return shallowSampleNormal(uv,0); }
fn shallowPreviousSurfaceNormal(uv: vec2<f32>) -> vec3<f32> { return shallowSampleNormal(uv,1); }
fn shallowComposeNormal(uv: vec2<f32>, row: i32, residualM: f32, baseNormal: vec3<f32>) -> vec3<f32> {
  let dimensions=vec2<f32>(textureDimensions(waterShallowGridTexture))*vec2<f32>(1.0,0.5);
  let mapping=textureLoad(waterShallowMappingTexture,vec2<i32>(0,row),0);
  let settings=textureLoad(waterShallowMappingTexture,vec2<i32>(1,row),0);
  let edgeCells=min(uv,vec2<f32>(1.0)-uv)*dimensions;
  let t=clamp(min(edgeCells.x,edgeCells.y)/4.0,0.0,1.0);
  let weight=t*t*(3.0-2.0*t);
  let direction=select(vec2<f32>(1.0),vec2<f32>(-1.0),uv>vec2<f32>(0.5));
  let gradient=select(vec2<f32>(0.0,direction.y*dimensions.y/max(mapping.w,0.000001)),
    vec2<f32>(direction.x*dimensions.x/max(mapping.z,0.000001),0.0),edgeCells.x<=edgeCells.y);
  let weightGradient=shallowRotate(gradient,settings.x)*(6.0*t*(1.0-t)/4.0);
  let localNormal=shallowSampleNormal(uv,row);
  let slope=baseNormal.xz/max(baseNormal.y,0.0001)+localNormal.xz/max(localNormal.y,0.0001)*weight-residualM*weightGradient;
  return normalize(vec3<f32>(slope.x,1.0,slope.y));
}
fn shallowFoam(uv: vec2<f32>) -> f32 {
  let dimensions=vec2<i32>(textureDimensions(waterShallowFoamTexture));
  #if WATER_SHALLOW_ADDITIVE == true
  return shallowSampleCells(waterShallowFoamTexture,uv,dimensions,vec2<i32>(0)).r;
  #else
  return textureLoad(waterShallowFoamTexture,clamp(vec2<i32>(round(uv*vec2<f32>(dimensions-1))),vec2<i32>(0),dimensions-1),0).r;
  #endif
}
#endif

#if WATER_OCEAN_PATCH == true
#import forgeax_material::parameters::{material, waterOceanPatchTexture}
fn oceanPatchTextureSample(uv: vec2<f32>, row: i32) -> vec4<f32> {
  let atlas = vec2<i32>(textureDimensions(waterOceanPatchTexture));
  let dimensions = vec2<i32>(atlas.x,atlas.y/2);
  if(any(dimensions<=vec2<i32>(0))){return vec4<f32>(0.0,0.0,1.0,0.0);}
  let offset = vec2<i32>(0,row*dimensions.y);
  let pixel = fract(uv) * vec2<f32>(dimensions) - 0.5;
  let low = vec2<i32>(floor(pixel)); let fraction=fract(pixel);
  let a=(low%dimensions+dimensions)%dimensions; let b=(a+1)%dimensions;
  let value=mix(mix(textureLoad(waterOceanPatchTexture,a+offset,0),textureLoad(waterOceanPatchTexture,vec2<i32>(b.x,a.y)+offset,0),fraction.x),
    mix(textureLoad(waterOceanPatchTexture,vec2<i32>(a.x,b.y)+offset,0),textureLoad(waterOceanPatchTexture,b+offset,0),fraction.x),fraction.y);
  return select(vec4<f32>(0.0,0.0,1.0,0.0),value,dot(value.xyz,value.xyz)>0.00000001);
}
fn oceanPatchUvSample(uv: vec2<f32>) -> vec4<f32> { return oceanPatchTextureSample(uv,0); }
fn oceanPatchSample(position: vec2<f32>) -> vec4<f32> { return oceanPatchUvSample(position/material.oceanPatchDomainM); }
fn oceanPatchPreviousSample(position: vec2<f32>) -> vec4<f32> { return oceanPatchTextureSample(position/material.oceanPatchDomainM,1); }
fn oceanPatchCycleOffset(cycle: f32) -> f32 {
  let position=fract(vec2<f32>(cycle,0.0)/128.0)*128.0+vec2<f32>(-64.340622,-72.465622);
  return fract(dot(position.xyx*position.xyy,vec3<f32>(20.390625,60.703125,2.4281209)))*10.24;
}
fn oceanPatchPhaseSample(position:vec2<f32>,velocity:vec2<f32>,time:f32)->vec4<f32> {
  let pulse=max(material.oceanPatchPulseSeconds,0.000001);
#if WATER_OCEAN_ADVECTION_THREE_PHASE == true
  var sample=vec4<f32>(0.0);
  for(var phase=0u;phase<3u;phase++){
    let shifted=time+pulse*f32(phase)/3.0;let t=shifted%pulse;
    let weight=(0.5-0.5*cos(6.283185307179586*time/pulse+6.283185307179586*f32(phase)/3.0))/1.5;
    sample+=oceanPatchUvSample((position-velocity*t+oceanPatchCycleOffset(floor(shifted/pulse)))/material.oceanPatchDomainM)*weight;
  }
  return sample;
#else
  let shifted=time+0.5*pulse;let t0=time%pulse;let t1=shifted%pulse;
  let first=oceanPatchUvSample((position-velocity*t0+oceanPatchCycleOffset(floor(time/pulse)))/material.oceanPatchDomainM);
  let second=oceanPatchUvSample((position-velocity*t1+oceanPatchCycleOffset(floor(shifted/pulse)))/material.oceanPatchDomainM);
  return mix(first,second,1.0-abs(t1*2.0/pulse-1.0));
#endif
}
fn oceanPatchAdvectedSample(position:vec2<f32>,velocity:vec2<f32>,simNormal:vec3<f32>,time:f32)->vec4<f32> {
  let scaled=vec3<f32>(velocity.x,0.0,velocity.y)*material.oceanPatchAdvectionSpeed;
  let projected=(scaled-dot(scaled,simNormal)*simNormal).xz;
  let magnitude=length(projected);
  var firstDirection=vec2<f32>(1.0,0.0);
  if(magnitude>0.00000001){firstDirection=projected/magnitude;}
  var secondDirection=firstDirection;var angleWeight=0.0;
  if(material.oceanPatchBracketAngleDegrees>0.00001){
    let delta=material.oceanPatchBracketAngleDegrees*0.017453292519943295;
    let angle=(atan2(projected.y,projected.x)+6.283185307179586)%6.283185307179586;
    let remainder=angle%delta;let low=angle-remainder;
    firstDirection=vec2<f32>(cos(low),sin(low));secondDirection=vec2<f32>(cos(low+delta),sin(low+delta));angleWeight=remainder/delta;
  }
  var magnitudes=vec2<f32>(magnitude);var magnitudeWeight=0.0;
  if(material.oceanPatchBracketSpeedMPerSec>0.0000001){
    let remainder=magnitude%material.oceanPatchBracketSpeedMPerSec;
    magnitudes=vec2<f32>(magnitude-remainder,magnitude-remainder+material.oceanPatchBracketSpeedMPerSec);magnitudeWeight=remainder/material.oceanPatchBracketSpeedMPerSec;
  }
  let first=mix(oceanPatchPhaseSample(position,firstDirection*magnitudes.x,time),oceanPatchPhaseSample(position,firstDirection*magnitudes.y,time),magnitudeWeight);
  let second=mix(oceanPatchPhaseSample(position,secondDirection*magnitudes.x,time),oceanPatchPhaseSample(position,secondDirection*magnitudes.y,time),magnitudeWeight);
  return mix(first,second,angleWeight);
}
#endif
