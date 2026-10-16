#define_import_path forgeax_clipping::planes
#import forgeax_view::common::{view}

fn clippedByPlanes(positionWS: vec3<f32>, planes: array<vec4<f32>, 6>, control: vec4<f32>) -> bool {
  let count = min(u32(max(control.x, 0.0)), 6u);
  var allOutside = count > 0u;
  var anyOutside = false;
  for (var index = 0u; index < count; index++) {
    let outside = dot(planes[index].xyz, positionWS) + planes[index].w < 0.0;
    anyOutside = anyOutside || outside;
    allOutside = allOutside && outside;
  }
  return select(anyOutside, allOutside, control.y > 0.5);
}

fn applyLocalClipping(positionWS: vec3<f32>, shadow: bool, planes: array<vec4<f32>, 6>, control: vec4<f32>) {
  if ((!shadow || control.z > 0.5) && clippedByPlanes(positionWS, planes, control)) { discard; }
}

fn applyViewClipping(positionWS: vec3<f32>, shadow: bool) {
  applyLocalClipping(positionWS, shadow, view.clippingPlanes, view.clippingControl);
}
