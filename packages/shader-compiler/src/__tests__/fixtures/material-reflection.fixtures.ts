import type { MaterialParameter } from '@forgeax/engine-types';

export const materialReflectionParameters: readonly MaterialParameter[] = [
  { name: 'baseColor', type: 'color' },
  { name: 'roughness', type: 'f32' },
];

export const materialReflectionSource = `
struct Material {
  baseColor: vec4<f32>,
  roughness: f32,
};
@group(1) @binding(0) var<uniform> material: Material;
@vertex fn vs_main() -> @builtin(position) vec4<f32> {
  return vec4<f32>(0.0);
}
`;

export const materialReflectionFixture = {
  material: 'painted-metal',
  pass: 'Forward',
  parameters: materialReflectionParameters,
  source: materialReflectionSource,
  reflection: {
    uniformFields: [
      { name: 'baseColor', type: 'vec4<f32>', offset: 0 },
      { name: 'roughness', type: 'f32', offset: 16 },
    ],
    bindings: [{ group: 1, binding: 0, kind: 'uniform' }],
    vertexInputs: [{ location: 0, type: 'vec3<f32>' }],
  },
} as const;
