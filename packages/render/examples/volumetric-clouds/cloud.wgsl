fn evaluateCloudMedium(context: CloudMediumContext, params: CloudParameters) -> CloudMediumSample {
  let p = context.positionMeters.xz - context.windOffsetMeters.xz;
  let broad = sin(p.x * 0.0009) + cos(p.y * 0.0012);
  let cells = select(broad, broad + 0.3 * sin((p.x + p.y) * 0.006), detail);
  let cover = smoothstep(0.0, 0.65, cells);
  let h = context.heightFraction;
  let envelope = smoothstep(0.05, 0.3, h) * (1.0 - smoothstep(0.7, 0.98, h));
  return CloudMediumSample(params.density * cover * envelope, vec3f(0.95), vec3f(0.0), 1.0);
}
