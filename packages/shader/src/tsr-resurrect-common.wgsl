// UE 5.8.1 DecimateHistory resurrection reprojection (TSRDecimateHistory.usf:225-248): the pixel
// of the persistent snapshot frame that sees the surface at this pixel, read bilinearly inside the
// snapshot viewport. Alpha carries the snapshot uncertainty, or -1 when the pixel has no depth or
// lies off the snapshot screen (bIsResurrectionOffScreen). The snapshot has the current input
// size, so the current viewport bounds it. Exposure is applied after TSR, so no exposure
// correction (usf:413-415) is needed.
fn tsrResurrectGuide(pixel: vec2<i32>) -> vec4<f32> {
  let temporal = unpackSceneTemporalV1(textureLoad(dilated, pixel, 0));
  if (!temporal.validDepth) { return vec4<f32>(0.0, 0.0, 0.0, -1.0); }
  let uv = (vec2<f32>(pixel) + 0.5) / params.inputSize;
  let snapshot = tsrResurrectionScreen(uv, temporal.viewDepth, params.clipToResurrectionClip, params.projectionZ);
  let screen = snapshot.xy;
  if (snapshot.z <= 0.0 || any(abs(screen) > vec2<f32>(1.0))) { return vec4<f32>(0.0, 0.0, 0.0, -1.0); }
  let size = vec2<f32>(textureDimensions(resurrectionGuide));
  let low = 0.5 / size;
  let high = (params.inputSize - 0.5) / size;
  let sampleUv = clamp(tsrScreenToUv(screen) * params.inputSize / size, low, high);
  let guide = textureSampleLevel(resurrectionGuide, linearSampler, sampleUv, 0.0);
  return vec4<f32>(guide.rgb, max(guide.a, 0.0));
}
