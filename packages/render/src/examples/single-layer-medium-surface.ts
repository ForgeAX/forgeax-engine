import type { MaterialRootAsset } from '@forgeax/engine-types';

/**
 * A public root asset showing the model declaration and its bounded input.
 * The page is shared by every material instance; Render supplies the page
 * bytes and each instance publishes its own range.
 */
export const SINGLE_LAYER_MEDIUM_SURFACE_EXAMPLE = {
  kind: 'material',
  surface: {
    model: 'single-layer-medium',
    module: 'game::water_surface_a',
    dynamicInput: {
      name: 'waterEvents',
      fields: [
        { name: 'position', type: 'vec3<f32>' },
        { name: 'time', type: 'f32' },
        { name: 'eventId', type: 'u32' },
      ],
      maxRecords: 64,
      maxDomains: 8,
      maxPageBytes: 2048,
      maxBindings: 1,
      maxEventsPerSample: 8,
    },
  },
  passes: [
    {
      name: 'color',
      program: { module: 'forgeax::single-layer-medium' },
    },
  ],
  parameters: [],
  values: {},
} as const satisfies MaterialRootAsset;

/** Two different imported Surface implementations consuming one model ABI. */
export const SINGLE_LAYER_MEDIUM_SURFACE_EXAMPLES = [
  {
    module: 'game::water_surface_a',
    source: `#define_import_path game::water_surface_a
#import forgeax_material::single_layer_medium_surface_v1::{SingleLayerMediumSurfaceInput, SingleLayerMediumSurfaceData}
fn evaluate_surface(input : SingleLayerMediumSurfaceInput) -> SingleLayerMediumSurfaceData {
  let event = read_waterEvents(input.eventRangeStart);
  let normal = normalize(input.geometricNormalWS + vec3<f32>(0.0, 0.0, event.time * 0.02));
  return SingleLayerMediumSurfaceData(normal, 0.18, 1.0, 0.0, vec3<f32>(0.18, 0.06, 0.02), vec3<f32>(0.02, 0.04, 0.08), 1.333, 0.2, 1000.0);
}`,
  },
  {
    module: 'game::water_surface_b',
    source: `#define_import_path game::water_surface_b
#import forgeax_material::single_layer_medium_surface_v1::{SingleLayerMediumSurfaceInput, SingleLayerMediumSurfaceData}
fn evaluate_surface(input : SingleLayerMediumSurfaceInput) -> SingleLayerMediumSurfaceData {
  let event = read_waterEvents(input.eventRangeStart);
  let normal = normalize(input.geometricNormalWS + vec3<f32>(event.position.xy * 0.01, 0.0));
  return SingleLayerMediumSurfaceData(normal, 0.32, 1.0, clamp(event.time * 0.1, 0.0, 1.0), vec3<f32>(0.04, 0.02, 0.01), vec3<f32>(0.08, 0.05, 0.02), 1.333, -0.1, 800.0);
}`,
  },
] as const;
