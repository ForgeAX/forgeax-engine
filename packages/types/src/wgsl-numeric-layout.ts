/** WGSL host-shareable scalar and float-vector byte layout; struct padding is caller-owned. */
export const WGSL_NUMERIC_LAYOUT = {
  f32: { size: 4, alignment: 4 },
  i32: { size: 4, alignment: 4 },
  u32: { size: 4, alignment: 4 },
  'vec2<f32>': { size: 8, alignment: 8 },
  'vec3<f32>': { size: 12, alignment: 16 },
  'vec4<f32>': { size: 16, alignment: 16 },
} as const;

for (const layout of Object.values(WGSL_NUMERIC_LAYOUT)) Object.freeze(layout);
Object.freeze(WGSL_NUMERIC_LAYOUT);
