#define_import_path forgeax_cloud::geometry

const CLOUD_UNTRACED_DEPTH_METERS: f32 = 65504000.0;

// Negative interval indicates no hit. The direction is unit length.
fn cloud_sphere_interval(radial: f32, projection: f32, radius: f32) -> vec2f {
  // Avoid subtracting two squared distances of planetary magnitude.
  let c = (radial - radius) * (radial + radius);
  let discriminant = projection * projection - c;
  if !(discriminant > 0.0) {
    return vec2f(-1.0);
  }
  let q = -projection - select(-1.0, 1.0, projection >= 0.0) * sqrt(discriminant);
  let second = c / q;
  return vec2f(min(q, second), max(q, second));
}

// First continuous interval after subtracting the interior sphere and clipping.
fn cloud_shell_interval(
  cameraRelativeToPlanetMeters: vec3f,
  direction: vec3f,
  planetRadiusMeters: f32,
  bottomMeters: f32,
  thicknessMeters: f32,
  entryLimitMeters: f32,
  traceLimitMeters: f32,
  limitFromEntry: bool,
  nearStartMeters: f32,
  sceneDistanceMeters: f32,
) -> vec2f {
  let radial = length(cameraRelativeToPlanetMeters);
  let projection = dot(cameraRelativeToPlanetMeters, direction);
  if !(radial >= planetRadiusMeters && planetRadiusMeters > 0.0 &&
    bottomMeters >= 0.0 && thicknessMeters > 0.0 &&
    entryLimitMeters >= 0.0 && traceLimitMeters > 0.0 &&
    nearStartMeters >= 0.0 && sceneDistanceMeters >= 0.0) ||
    (radial == planetRadiusMeters && projection < 0.0) {
    return vec2f(-1.0);
  }
  let innerRadius = planetRadiusMeters + bottomMeters;
  let outer = cloud_sphere_interval(radial, projection, innerRadius + thicknessMeters);
  if !(outer.y > 0.0) {
    return vec2f(-1.0);
  }
  var entryMeters = max(0.0, outer.x);
  var exitMeters = outer.y;
  let inner = cloud_sphere_interval(radial, projection, innerRadius);
  if inner.y > entryMeters && inner.x < exitMeters {
    if inner.x <= entryMeters {
      entryMeters = inner.y;
    } else {
      exitMeters = inner.x;
    }
  }
  if entryMeters > entryLimitMeters {
    return vec2f(-1.0);
  }
  let ground = cloud_sphere_interval(radial, projection, planetRadiusMeters);
  if ground.y > 0.0 {
    exitMeters = min(exitMeters, max(0.0, ground.x));
  }
  let policyEnd = select(traceLimitMeters, entryMeters + traceLimitMeters, limitFromEntry);
  entryMeters = max(entryMeters, nearStartMeters);
  exitMeters = min(exitMeters, min(policyEnd, sceneDistanceMeters));
  return select(vec2f(-1.0), vec2f(entryMeters, exitMeters), exitMeters > entryMeters);
}
