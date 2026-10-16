// Shared test helper: minimal mock ShaderRegistry for AssetRegistry constructor.
// feat-20260527-material-registration-unification M1 / w4.
//
// All tests that create AssetRegistry directly must pass a ShaderRegistry
// since the constructor parameter became required in w1. This helper
// provides a zero-config mock that satisfies the constructor signature
// without requiring a real GPU device.

import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine-shader';

export function makeMockShaderRegistry(): ShaderRegistry {
  const mockDevice: ShaderRegistryDevice = {
    createShaderModule() {
      return {
        ok: true,
        value: undefined,
        unwrap: () => undefined,
        unwrapOr: (d: unknown) => d,
      } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
    },
  };
  const sr = new ShaderRegistry({
    device: mockDevice,
    manifestUrl: undefined,
  });
  // Register a default test shader so M2 tests can validate against it.
  sr.installMaterialArtifact('test::standard', {
    source: 'fn main() {}',
    paramSchema: [
      { name: 'baseColor', type: 'color' },
      { name: 'metallic', type: 'f32' },
      { name: 'roughness', type: 'f32' },
    ],
  });
  sr.installMaterialArtifact('test::unlit', {
    source: 'fn main() {}',
    paramSchema: [
      { name: 'baseColor', type: 'color' },
      { name: 'baseColorTexture', type: 'texture2d' },
      { name: 'sampler', type: 'sampler', default: null },
      { name: 'lightIntensity', type: 'f32' }, // required — no default
    ],
  });
  // Register the engine-shipped default-standard-pbr shader so tests
  // that use it pass the register-time validation gate (M2 / w6).
  // paramSchema mirrors packages/shader/src/default-standard-pbr.schema.json.
  sr.installMaterialArtifact('forgeax::default-standard-pbr', {
    source: 'fn main() {}',
    paramSchema: [
      { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
      { name: 'metallic', type: 'f32', default: 0.0 },
      { name: 'roughness', type: 'f32', default: 0.5 },
      // feat-20260613 fix-issue-1 (D-8): channelMap split into 4 f32 selectors.
      { name: 'metallicChannel', type: 'f32', default: 2.0 },
      { name: 'roughnessChannel', type: 'f32', default: 1.0 },
      { name: 'aoChannel', type: 'f32', default: 0.0 },
      { name: 'extraChannel', type: 'f32', default: 0.0 },
      { name: 'emissive', type: 'vec3', default: [0.0, 0.0, 0.0] },
      { name: 'emissiveIntensity', type: 'f32', default: 0.0 },
      { name: 'occlusionStrength', type: 'f32', default: 1.0 },
      { name: 'baseColorTexture', type: 'texture2d' },
      { name: 'metallicRoughnessTexture', type: 'texture2d' },
      { name: 'normalTexture', type: 'texture2d' },
    ],
  });
  sr.installMaterialArtifact('forgeax::default-unlit', {
    source: 'fn main() {}',
    paramSchema: [
      { name: 'baseColor', type: 'color' },
      { name: 'baseColorTexture', type: 'texture2d' },
      { name: 'sampler', type: 'sampler', default: null },
    ],
  });
  // test::dummy used by M1 test (c)
  sr.installMaterialArtifact('test::dummy', {
    source: 'fn main() {}',
    paramSchema: [],
  });
  // forgeax::msdf-text used by the glyph layout system (feat-20260531 F-1).
  // paramSchema mirrors packages/shader/src/msdf-text.material.json so the
  // layout system's per-font MaterialAsset register passes validation in the
  // GPU-less unit tests.
  sr.installMaterialArtifact('forgeax::msdf-text', {
    source: 'fn main() {}',
    paramSchema: [
      { name: 'tintColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
      { name: 'distanceRange', type: 'f32', default: 4.0 },
      { name: 'baseColorTexture', type: 'texture2d' },
      { name: 'sampler', type: 'sampler', default: null },
    ],
  });
  // feat-20260609-pipeline-driven-pass-selector-shadowcaster-via-mat M3 / T-007:
  // forgeax::default-shadow-caster — vertex-only depth pass shader for
  // directional shadow maps. Registered as the 6th built-in material shader.
  sr.installMaterialArtifact('forgeax::default-shadow-caster', {
    source: 'fn main() {}',
    paramSchema: [],
  });
  // feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild:
  // forgeax::sprite registered in the mock so resolveTilesetMaterial inside
  // tilemap-chunk-extract-system can register a per-tile material in unit
  // tests (paramSchema mirrors packages/shader/src/sprite.material.json).
  sr.installMaterialArtifact('forgeax::sprite', {
    source: 'fn main() {}',
    paramSchema: [
      { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
      { name: 'texture', type: 'texture2d' },
      { name: 'sampler', type: 'sampler', default: null },
      { name: 'region', type: 'vec4', default: [0.0, 0.0, 1.0, 1.0] },
      { name: 'pivot', type: 'vec2', default: [0.5, 0.5] },
      { name: 'flipX', type: 'f32', default: 0.0 },
      { name: 'flipY', type: 'f32', default: 0.0 },
      { name: 'slices', type: 'vec4', default: [0.0, 0.0, 0.0, 0.0] },
      { name: 'sliceMode', type: 'f32', default: 0.0 },
    ],
  });
  return sr;
}
