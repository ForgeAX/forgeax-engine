#define_import_path hello_triangle::view

// apps/hello/triangle - view.wgsl (T-19 canonical composition demo split).
// Shared View struct + binding, imported by pbr.wgsl via naga_oil #import.

struct View {
  worldViewProj : mat4x4<f32>,
  lightDir      : vec3<f32>,
  lightColor    : vec3<f32>,
  cameraPos     : vec3<f32>,
};

struct Mesh { worldFromLocal : mat4x4<f32> };

@group(0) @binding(0) var<uniform> view : View;
@group(2) @binding(0) var<storage, read> meshes : array<Mesh>;
