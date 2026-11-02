#define_import_path forgeax_clipping::planes
#import forgeax_view::common::{view, viewDirectionToCamera}

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

struct ViewClippingCap {
  capped : bool,
  positionWS : vec3<f32>,
  normalWS : vec3<f32>,
};

// A back face seen through a camera cut belongs to the inside of a closed mesh:
// with caps enabled (clippingControl.w) it is shaded as the cut plane. The cap
// point is where the camera ray leaves the kept region, nudged into it so the
// coverage predicate keeps it; its normal faces the camera.
fn viewClippingCap(positionWS : vec3<f32>, frontFacing : bool) -> ViewClippingCap {
  var cap = ViewClippingCap(false, positionWS, vec3<f32>(0.0));
  let control = view.clippingControl;
  let count = min(u32(max(control.x, 0.0)), 6u);
  if (frontFacing || control.w < 0.5 || count == 0u) { return cap; }
  let toward = viewDirectionToCamera(positionWS);
  let intersection = control.y > 0.5;
  var reach = select(3.4e38, -3.4e38, intersection);
  var normal = vec3<f32>(0.0);
  for (var index = 0u; index < count; index++) {
    let plane = view.clippingPlanes[index];
    let side = dot(plane.xyz, positionWS) + plane.w;
    let rate = dot(plane.xyz, toward);
    if (side < 0.0) { continue; }
    // Intersection mode keeps a point while any plane keeps it; a plane the ray
    // never leaves explains no cut.
    if (rate >= 0.0) {
      if (intersection) { return cap; }
      continue;
    }
    let travel = -side / rate;
    if (select((travel < reach), (travel > reach), intersection)) {
      reach = travel;
      normal = plane.xyz;
    }
  }
  if (dot(normal, normal) == 0.0) { return cap; }
  cap.capped = true;
  cap.positionWS = positionWS + toward * reach + normal * max(1e-5, 1e-6 * length(positionWS));
  cap.normalWS = -normal;
  return cap;
}
