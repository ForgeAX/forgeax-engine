// DirectionalLight.sourceAngle -> View UBO float 251 (sunSourceRadius).

/**
 * sin(half angle) of the sun disc for `sourceAngle` degrees: the SphereSinAlpha
 * source radius Unreal derives for a directional light (CapsuleLightIntegrate.ush:98
 * then scales it by 1 - roughness^2 in the shader). 0, negative or non-finite
 * angles give 0, the point-light path.
 */
export function sunSourceRadiusOf(sourceAngleDegrees: number): number {
  if (!(sourceAngleDegrees > 0)) return 0;
  return Math.sin(Math.min(0.5 * sourceAngleDegrees, 90) * (Math.PI / 180));
}
