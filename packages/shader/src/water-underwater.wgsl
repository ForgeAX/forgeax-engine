#define_import_path forgeax_material::water_underwater
#import forgeax_view::common::{view, view_atmosphere_light_direction}
#import forgeax_scene_temporal::{sceneViewZ}
#import forgeax_material::water_waves::{waterBodyData, waterMaterialDrawData, waterBodyHeightDepth, waterBodyVelocity, waterBodyPhaseAtWorldPosition, evaluateWaterWavesForward}

@group(0) @binding(1) var underwaterSceneColor: texture_2d<f32>;
@group(0) @binding(2) var underwaterSceneDepth: texture_depth_2d;
struct UnderwaterSelection { surfaceYM: f32, immersionM: f32, blendWeight: f32, timeSeconds: f32 };
@group(0) @binding(3) var<uniform> underwaterSelection: UnderwaterSelection;

@vertex fn vs_main(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4<f32> {
  let uv = vec2<f32>(f32((vertex << 1u) & 2u), f32(vertex & 2u));
  return vec4<f32>(uv * 2.0 - vec2<f32>(1.0), 0.0, 1.0);
}

@fragment fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let pixel = vec2<i32>(position.xy);
  let size = vec2<f32>(textureDimensions(underwaterSceneColor));
  let uv = position.xy / size;
  let depthSize = textureDimensions(underwaterSceneDepth);
  let depthPixel = clamp(vec2<i32>(uv * vec2<f32>(depthSize)), vec2<i32>(0), vec2<i32>(depthSize) - vec2<i32>(1));
  let rawDepth = textureLoad(underwaterSceneDepth, depthPixel, 0);
  let h = view.inverseViewProj * vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), max(rawDepth, 0.00001), 1.0);
  let scenePosition = h.xyz / h.w;
  let viewRight = vec3<f32>(view.temporalCurrentViewProj[0].x, view.temporalCurrentViewProj[1].x, view.temporalCurrentViewProj[2].x);
  let viewUp = vec3<f32>(view.temporalCurrentViewProj[0].y, view.temporalCurrentViewProj[1].y, view.temporalCurrentViewProj[2].y);
  let orthographic = view.temporalProjection.z > 0.5;
  let viewForward = vec3<f32>(view.temporalCurrentViewProj[0].w, view.temporalCurrentViewProj[1].w, view.temporalCurrentViewProj[2].w);
  let cameraDirection = normalize(select(viewForward, -cross(viewRight, viewUp), orthographic));
  let toCamera = select(normalize(view.cameraPos - scenePosition), -cameraDirection, orthographic);
  let sceneDepthM = max(-sceneViewZ(view.worldViewProj * vec4<f32>(scenePosition, 1.0), view.temporalProjection), 0.0);
  let distanceM = min(sceneDepthM, material.underwaterMaximumDistanceM);
  let absorption = exp(-distanceM * material.underwaterAbsorptionPerM);
  let fog = exp(-distanceM * material.underwaterFogPerM);
  let g = material.underwaterPhaseG;
  let cosine = dot(view_atmosphere_light_direction(view), toCamera);
  let denominator = 1.0 + g * cosine;
  let phase = (1.0 - g * g) / (12.5663706144 * denominator * denominator);
  let scatter = phase * material.underwaterScatterColor + material.underwaterAmbientColor;
  let original = textureLoad(underwaterSceneColor, pixel, 0);
  let core = mix(scatter, original.rgb * absorption, fog);
  let perspectiveNearPoint = view.cameraPos - toCamera / max(abs(dot(toCamera, cameraDirection)), 0.00001) * material.underwaterNearPlaneM;
  let nearPoint = select(perspectiveNearPoint,
    scenePosition + cameraDirection * (material.underwaterNearPlaneM - sceneDepthM), orthographic);
  let bodyIndex = waterMaterialDrawData.bodyIndex;
  let body = waterBodyData[bodyIndex];
  let heightDepth = waterBodyHeightDepth(bodyIndex, nearPoint.xz, vec3<f32>(0.0));
  // UE's post-process wrapper supplies white VertexColor before WaterBodyData's vertex decode.
  let vertexFlowAngle = 6.28318530718;
  let vertexFlow = vec2<f32>(cos(vertexFlowAngle), sin(vertexFlowAngle)) * material.maximumFlowVelocityMPerSec;
  let velocity = waterBodyVelocity(bodyIndex, nearPoint.xz, vertexFlow);
  let wavePhaseXZ = waterBodyPhaseAtWorldPosition(bodyIndex, nearPoint.xz);
  let wave = evaluateWaterWavesForward(bodyIndex, wavePhaseXZ, heightDepth.y, body.timeAndMask.x);
  let waveMask = 1.0 - clamp(length(velocity), 0.0, 1.0);
  let delta = heightDepth.x + wave.displacement.y * waveMask - nearPoint.y;
  let wet = clamp((delta + material.underwaterWetAlphaM) / material.underwaterWetAlphaM, 0.0, 1.0);
  let underwater = mix(original.rgb, core, wet);
  // The graph transforms a view direction; translation never enters the band radius.
  let radiusM = material.underwaterWetRadiusM * length(cameraDirection.xz);
  let bandDistance = abs(delta - material.underwaterWetLocationM) / max(radiusM, 0.0000001);
  let bandMask = clamp((1.0 - bandDistance) / max(1.0 - material.underwaterWetHardness, 0.00001), 0.0, 1.0);
  let bandPhase = clamp(-delta / material.underwaterBandWidthM + material.underwaterBandOffset, 0.0, 1.0);
  let bandColor = mix(material.underwaterBandColor * 0.5, material.underwaterBandColor * 2.0, bandPhase) * phase;
  let band = mix(underwater, bandColor, bandMask * material.underwaterBandOpacity);
  return vec4<f32>(mix(original.rgb, band, clamp(underwaterSelection.blendWeight, 0.0, 1.0)), original.a);
}
