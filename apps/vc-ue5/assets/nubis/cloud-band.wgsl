fn evaluateCloudMedium(context: CloudMediumContext, parameters: CloudParameters) -> CloudMediumSample {
  let insideBand = abs(context.positionMeters.z - parameters.centerMeters) <= parameters.halfWidthMeters;
  let inLayer = context.heightFraction >= 0.1 && context.heightFraction <= 0.8;
  let extinction = select(0.0, parameters.extinctionPerMeter, insideBand && inLayer);
  return CloudMediumSample(extinction, vec3<f32>(0.98), vec3<f32>(0.0), 1.0);
}
