#define_import_path forgeax_material::scene_depth

// Standard before-pass depth input. Renderer owns the resolved single-sample view.
@group(0) @binding(1) var sceneDepth: texture_depth_2d;
