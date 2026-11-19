export interface CloudShadowControls {
  readonly groundShadowEnabled: boolean;
  readonly atmosphereShadowEnabled: boolean;
  readonly surfaceShadowStrength: number;
  readonly atmosphereShadowStrength: number;
}

export function shadowConsumerFields(controls: CloudShadowControls) {
  const surfaceShadowStrength = controls.groundShadowEnabled ? controls.surfaceShadowStrength : 0;
  const atmosphereShadowStrength = controls.atmosphereShadowEnabled ? controls.atmosphereShadowStrength : 0;
  return {
    castCloudShadows: controls.groundShadowEnabled || controls.atmosphereShadowEnabled,
    surfaceShadowStrength,
    atmosphereShadowStrength,
  };
}
