/**
 * Canonical hello-taa auto-exposure scene facts.
 *
 * The consumer app and the independent Three.js r184 reference both derive
 * their scene summaries from this value.  Keeping the authored geometry,
 * transforms, camera, light and static-input mode together prevents a
 * reference artifact from attaching a familiar identity to another scene.
 */
export const AUTO_EXPOSURE_TAA_FIXTURE_IDENTITY = {
  asset: {
    id: 'fixture-asset-taa-bars-v1',
    sha256: '40c9c602de0d7dd24b6b144d7d8134e901de82a9342a0f4c51b4ece9f538a7e0',
  },
  camera: {
    id: 'fixture-camera-taa-perspective-v1',
    sha256: '0246f83dcc97d7c7c36cdbbf271d356cf204ceeb7b07dfc343548a4c7d34d441',
  },
  light: {
    id: 'fixture-light-taa-directional-d65-v1',
    sha256: '4c69839d5d828029a5d1278ff87be4b339c408e6c1d79a1f291169746e8ec014',
  },
  input: {
    id: 'fixture-input-static-v1',
    sha256: 'cec1258ea4db1aac3944c5881a2c382e36bce28ccbf97436cac8a63004b98c33',
  },
} as const;

export const AUTO_EXPOSURE_TAA_FIXTURE = {
  source: {
    path: 'apps/hello/taa/src/main.ts',
    scenario: 'static',
  },
  asset: {
    primitive: 'HANDLE_CUBE',
    material: 'unlit',
    colorSpace: 'linear-HDR',
    barLayout: [
      { offset: -0.5, color: [0.95, 0.12, 0.1, 1] as const },
      { offset: 0, color: [0.1, 0.85, 0.2, 1] as const },
      { offset: 0.5, color: [0.1, 0.25, 0.95, 1] as const },
    ],
    transform: {
      y: 0.8,
      z: 0,
      scale: [0.5, 0.45, 1] as const,
    },
    sourceIdentity: AUTO_EXPOSURE_TAA_FIXTURE_IDENTITY.asset,
  },
  camera: {
    projection: 'perspective',
    fov: Math.PI / 3,
    aspect: 16 / 9,
    near: 0.1,
    far: 100,
    position: [0, 0, 2.5] as const,
    rotation: [0, 0, 0, 1] as const,
    sourceIdentity: AUTO_EXPOSURE_TAA_FIXTURE_IDENTITY.camera,
  },
  light: {
    kind: 'directional',
    direction: [-0.4, -0.6, -0.7] as const,
    color: [1, 1, 1] as const,
    intensity: 1.2,
    sourceIdentity: AUTO_EXPOSURE_TAA_FIXTURE_IDENTITY.light,
  },
  input: {
    kind: 'static',
    visualCase: 'static',
    motion: 'none',
    camera: 'fixed',
    sourceIdentity: AUTO_EXPOSURE_TAA_FIXTURE_IDENTITY.input,
  },
  clearColor: [0, 0, 0, 0] as const,
} as const;
