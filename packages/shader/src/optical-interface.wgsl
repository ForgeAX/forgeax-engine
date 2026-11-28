#define_import_path forgeax_optics::interface

// Pure geometric optics. Directions point towards the interface; its normal
// points into the incident medium. Statuses are local shader results, not errors
// in an asset, device, or submission protocol.
const OPTICAL_VALID: u32 = 0u;
const OPTICAL_INVALID: u32 = 1u;
const OPTICAL_TIR: u32 = 2u;
const OPTICAL_PARALLEL: u32 = 3u;
const OPTICAL_BEHIND: u32 = 4u;
const OPTICAL_OUTSIDE: u32 = 5u;
const OPTICAL_DEGENERATE: u32 = 6u;

struct OpticalDirection { direction: vec3<f32>, status: u32 };
struct OpticalPlaneHit { distanceM: f32, coordinatesM: vec2<f32>, status: u32 };
struct OpticalArea { receiverAreaSqM: f32, sourceAreaSqM: f32, ratio: f32, status: u32 };
struct OpticalConcentration { value: f32, status: u32 };

fn opticalFinite(value: f32) -> bool { return abs(value) <= 3.402823e38; }
fn opticalFinite2(value: vec2<f32>) -> bool { return all(abs(value) <= vec2<f32>(3.402823e38)); }
fn opticalFinite3(value: vec3<f32>) -> bool { return all(abs(value) <= vec3<f32>(3.402823e38)); }
fn opticalUnit(value: vec3<f32>) -> bool {
  return opticalFinite3(value) && abs(dot(value, value) - 1.0) <= 0.001;
}

fn refractInterface(incident: vec3<f32>, normal: vec3<f32>, n1: f32, n2: f32) -> OpticalDirection {
  if (!opticalUnit(incident) || !opticalUnit(normal) || !opticalFinite(n1) ||
      !opticalFinite(n2) || n1 <= 0.0 || n2 <= 0.0 || dot(incident, normal) > 0.0) {
    return OpticalDirection(vec3<f32>(0.0), OPTICAL_INVALID);
  }
  let eta = n1 / n2;
  let cosine = clamp(-dot(incident, normal), 0.0, 1.0);
  let discriminant = 1.0 - eta * eta * (1.0 - cosine * cosine);
  if (!opticalFinite(eta) || !opticalFinite(discriminant)) {
    return OpticalDirection(vec3<f32>(0.0), OPTICAL_INVALID);
  }
  if (discriminant < 0.0) { return OpticalDirection(vec3<f32>(0.0), OPTICAL_TIR); }
  let direction = eta * incident + (eta * cosine - sqrt(discriminant)) * normal;
  if (!opticalFinite3(direction) || dot(direction, direction) <= 0.0) {
    return OpticalDirection(vec3<f32>(0.0), OPTICAL_INVALID);
  }
  return OpticalDirection(normalize(direction), OPTICAL_VALID);
}

// Orthonormal plane axes and extents are explicit, in metres. No scene lookup.
fn intersectOpticalPlane(originM: vec3<f32>, direction: vec3<f32>, planeOriginM: vec3<f32>,
    axisU: vec3<f32>, axisV: vec3<f32>, halfExtentM: vec2<f32>, parallelTolerance: f32) -> OpticalPlaneHit {
  if (!opticalFinite3(originM) || !opticalFinite3(planeOriginM) || !opticalUnit(direction) ||
      !opticalUnit(axisU) || !opticalUnit(axisV) || abs(dot(axisU, axisV)) > 0.001 ||
      !opticalFinite2(halfExtentM) || any(halfExtentM <= vec2<f32>(0.0)) ||
      !opticalFinite(parallelTolerance) || parallelTolerance < 0.0 || parallelTolerance >= 1.0) {
    return OpticalPlaneHit(0.0, vec2<f32>(0.0), OPTICAL_INVALID);
  }
  let planeNormal = normalize(cross(axisU, axisV));
  let denominator = dot(direction, planeNormal);
  if (abs(denominator) <= parallelTolerance) {
    return OpticalPlaneHit(0.0, vec2<f32>(0.0), OPTICAL_PARALLEL);
  }
  let distanceM = dot(planeOriginM - originM, planeNormal) / denominator;
  if (!opticalFinite(distanceM)) { return OpticalPlaneHit(0.0, vec2<f32>(0.0), OPTICAL_INVALID); }
  if (distanceM < 0.0) { return OpticalPlaneHit(distanceM, vec2<f32>(0.0), OPTICAL_BEHIND); }
  let relativeM = originM + direction * distanceM - planeOriginM;
  let coordinatesM = vec2<f32>(dot(relativeM, axisU), dot(relativeM, axisV));
  if (!opticalFinite2(coordinatesM)) { return OpticalPlaneHit(0.0, vec2<f32>(0.0), OPTICAL_INVALID); }
  if (any(abs(coordinatesM) > halfExtentM)) {
    return OpticalPlaneHit(distanceM, coordinatesM, OPTICAL_OUTSIDE);
  }
  return OpticalPlaneHit(distanceM, coordinatesM, OPTICAL_VALID);
}

// The metric is the Gram matrix of source tangents for exactly the same
// parameter increments as deltaQu/deltaQv. The caller chooses the stencil.
fn opticalMappedArea(deltaQu: vec3<f32>, deltaQv: vec3<f32>, sourceMetric: mat2x2<f32>) -> OpticalArea {
  if (!opticalFinite3(deltaQu) || !opticalFinite3(deltaQv) ||
      !opticalFinite2(sourceMetric[0]) || !opticalFinite2(sourceMetric[1]) ||
      sourceMetric[0].x < 0.0 || sourceMetric[1].y < 0.0 ||
      abs(sourceMetric[0].y - sourceMetric[1].x) > 0.00001 * max(1.0, max(abs(sourceMetric[0].y), abs(sourceMetric[1].x)))) {
    return OpticalArea(0.0, 0.0, 0.0, OPTICAL_INVALID);
  }
  let sourceDeterminant = determinant(sourceMetric);
  if (!opticalFinite(sourceDeterminant) || sourceDeterminant < 0.0) {
    return OpticalArea(0.0, 0.0, 0.0, OPTICAL_INVALID);
  }
  let receiverArea = length(cross(deltaQu, deltaQv));
  let sourceArea = sqrt(sourceDeterminant);
  if (!opticalFinite(receiverArea) || !opticalFinite(sourceArea)) {
    return OpticalArea(0.0, 0.0, 0.0, OPTICAL_INVALID);
  }
  if (receiverArea == 0.0 || sourceArea == 0.0) {
    return OpticalArea(receiverArea, sourceArea, 0.0, OPTICAL_DEGENERATE);
  }
  let ratio = receiverArea / sourceArea;
  if (!opticalFinite(ratio)) { return OpticalArea(0.0, 0.0, 0.0, OPTICAL_INVALID); }
  return OpticalArea(receiverArea, sourceArea, ratio, OPTICAL_VALID);
}

// Relative irradiance density against an explicit flat/reference interface.
// Fresnel, extinction, regularization and artistic gain are separate policies.
fn opticalRelativeConcentration(incidentArea: f32, receiverArea: f32,
    referenceIncidentArea: f32, referenceReceiverArea: f32) -> OpticalConcentration {
  if (!opticalFinite(incidentArea) || !opticalFinite(receiverArea) ||
      !opticalFinite(referenceIncidentArea) || !opticalFinite(referenceReceiverArea) ||
      incidentArea < 0.0 || receiverArea < 0.0 || referenceIncidentArea < 0.0 || referenceReceiverArea < 0.0) {
    return OpticalConcentration(0.0, OPTICAL_INVALID);
  }
  if (receiverArea == 0.0 || referenceIncidentArea == 0.0 || referenceReceiverArea == 0.0) {
    return OpticalConcentration(0.0, OPTICAL_DEGENERATE);
  }
  let value = (incidentArea / receiverArea) / (referenceIncidentArea / referenceReceiverArea);
  if (!opticalFinite(value)) { return OpticalConcentration(0.0, OPTICAL_INVALID); }
  return OpticalConcentration(value, OPTICAL_VALID);
}
