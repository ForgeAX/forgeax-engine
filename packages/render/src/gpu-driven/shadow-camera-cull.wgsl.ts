/** Assemble the shadow receiver-prism kernel for the shared view layout. */
export function shadowCameraCullWgsl(
  viewWgsl: string,
  workgroupSize: number,
  slabs: number,
  culledCounterOffset: number,
): string {
  return /* wgsl */ `${viewWgsl}
// Shadow maps use reversed Z with a zero clear, and a receiver is shadowed
// only by a stored depth greater than its own. Every receiver this caster can
// darken therefore lies in its dilated light-space rectangle between depth 0
// (the far plane) and the caster's nearest light depth.
fn shadowReceiversHidden(primitive: PrimitiveRecord, world: mat4x4<f32>) -> bool {
  let cull = view.shadowCamera;
  if (cull.enabled == 0u) { return false; }
  var worldMin = vec3<f32>(3.0e38);
  var worldMax = vec3<f32>(-3.0e38);
  for (var corner = 0u; corner < 8u; corner += 1u) {
    let point = (world * vec4<f32>(boundsCorner(primitive, corner), 1.0)).xyz;
    worldMin = min(worldMin, point);
    worldMax = max(worldMax, point);
  }
  // The caster's own box lies inside its receiver prism, so a box the
  // pyramid cannot hide keeps the caster without the slab walk. Most
  // casters of an unoccluded view exit here after one 4x4 test.
  if (casterBoxVisible(cull.camera, worldMin, worldMax)) { return false; }
  // A receiver samples the map at its position offset along its normal.
  worldMin -= vec3<f32>(cull.worldDilation);
  worldMax += vec3<f32>(cull.worldDilation);
  var lightMin = vec2<f32>(3.0e38);
  var lightMax = vec2<f32>(-3.0e38);
  var lightNearest = 0.0;
  for (var corner = 0u; corner < 8u; corner += 1u) {
    let point = vec3<f32>(
      select(worldMin.x, worldMax.x, (corner & 1u) != 0u),
      select(worldMin.y, worldMax.y, (corner & 2u) != 0u),
      select(worldMin.z, worldMax.z, (corner & 4u) != 0u),
    );
    let clip = cull.lightViewProjection * vec4<f32>(point, 1.0);
    if (clip.w <= 1e-6) { return false; }
    let ndc = clip.xyz / clip.w;
    lightMin = min(lightMin, ndc.xy);
    lightMax = max(lightMax, ndc.xy);
    lightNearest = max(lightNearest, ndc.z);
  }
  // Receivers outside this map never sample it.
  lightMin = max(lightMin - vec2<f32>(cull.ndcDilation), vec2<f32>(-1.0));
  lightMax = min(lightMax + vec2<f32>(cull.ndcDilation), vec2<f32>(1.0));
  if (!all(lightMin < lightMax)) { return false; }
  let lightTop = clamp(lightNearest, 0.0, 1.0);
  // The prism reaches the light's far plane, usually far below the visible
  // receivers. One screen rectangle for all of it spans a coarse pyramid
  // level whose texels include the sky, so each depth slab is tested on its
  // own and the caster is skipped only when every slab is hidden. A visible
  // caster usually shades itself, so walking down from its own slab exits at
  // the first iteration.
  for (var step = 0u; step < ${slabs}u; step += 1u) {
    let slab = ${slabs}u - 1u - step;
    let slabFar = lightTop * f32(slab) / ${slabs}.0;
    let slabNear = lightTop * f32(slab + 1u) / ${slabs}.0;
    if (!lightSlabHidden(cull, lightMin, lightMax, slabFar, slabNear)) { return false; }
  }
  return true;
}

// True only for a box wholly in front of the camera, overlapping the screen,
// and not proven hidden; any other box falls through to the slab walk.
fn casterBoxVisible(camera: PyramidCamera, worldMin: vec3<f32>, worldMax: vec3<f32>) -> bool {
  var uvMin = vec2<f32>(3.0e38);
  var uvMax = vec2<f32>(-3.0e38);
  var nearestDepth = -3.0e38;
  for (var corner = 0u; corner < 8u; corner += 1u) {
    let point = vec3<f32>(
      select(worldMin.x, worldMax.x, (corner & 1u) != 0u),
      select(worldMin.y, worldMax.y, (corner & 2u) != 0u),
      select(worldMin.z, worldMax.z, (corner & 4u) != 0u),
    );
    let clip = camera.viewProjection * vec4<f32>(point, 1.0);
    if (clip.w <= 1e-6) { return false; }
    let ndc = clip.xyz / clip.w;
    uvMin = min(uvMin, vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5));
    uvMax = max(uvMax, vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5));
    nearestDepth = max(nearestDepth, ndc.z);
  }
  if (any(uvMax <= vec2<f32>(0.0)) || any(uvMin >= vec2<f32>(1.0)) || nearestDepth < 0.0) {
    return false;
  }
  return !screenRectOccluded(camera, uvMin, uvMax, nearestDepth, 3u);
}

fn lightSlabHidden(
  cull: ShadowCameraCull,
  lightMin: vec2<f32>,
  lightMax: vec2<f32>,
  slabFar: f32,
  slabNear: f32,
) -> bool {
  let camera = cull.camera;
  // Nothing nearer than the near plane is rasterized, so the slab is clipped
  // there instead of being rejected when the long prism passes the camera.
  let nearW = select(camera.near, 1e-6, camera.orthographic != 0u);
  var clips: array<vec4<f32>, 8>;
  for (var corner = 0u; corner < 8u; corner += 1u) {
    let lightPoint = vec4<f32>(
      select(lightMin.x, lightMax.x, (corner & 1u) != 0u),
      select(lightMin.y, lightMax.y, (corner & 2u) != 0u),
      select(slabFar, slabNear, (corner & 4u) != 0u),
      1.0,
    );
    let worldPoint = cull.lightInverse * lightPoint;
    if (!(abs(worldPoint.w) > 1e-12)) { return false; }
    clips[corner] = camera.viewProjection * vec4<f32>(worldPoint.xyz / worldPoint.w, 1.0);
  }
  var uvMin = vec2<f32>(3.0e38);
  var uvMax = vec2<f32>(-3.0e38);
  var nearestDepth = -3.0e38;
  var inFront = 0u;
  for (var corner = 0u; corner < 8u; corner += 1u) {
    let clip = clips[corner];
    if (clip.w < nearW) { continue; }
    inFront += 1u;
    let ndc = clip.xyz / clip.w;
    uvMin = min(uvMin, vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5));
    uvMax = max(uvMax, vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5));
    nearestDepth = max(nearestDepth, ndc.z);
  }
  if (inFront == 0u) { return true; }
  if (inFront < 8u) {
    // The box is convex, so its visible part is bounded by the in-front
    // corners plus each edge's crossing of the near plane.
    for (var edge = 0u; edge < 12u; edge += 1u) {
      // Edge e runs along axis bit 1 << (e / 4); its other two corner bits
      // are e % 4 spread around that axis.
      let axis = 1u << (edge / 4u);
      let rest = edge % 4u;
      let below = rest & (axis - 1u);
      let start = below | ((rest - below) << 1u);
      let end = start | axis;
      let p = clips[start];
      let q = clips[end];
      if ((p.w < nearW) == (q.w < nearW)) { continue; }
      let clip = mix(p, q, (nearW - p.w) / (q.w - p.w));
      let ndc = clip.xyz / clip.w;
      uvMin = min(uvMin, vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5));
      uvMax = max(uvMax, vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5));
      nearestDepth = max(nearestDepth, ndc.z);
    }
  }
  // No receiver of the slab lies on screen or inside the far plane.
  let pad = pyramidTexelUv();
  if (any(uvMax < -pad) || any(uvMin > 1.0 + pad) || nearestDepth < 0.0) { return true; }
  // A slab seen from a low camera hugs the horizon; the coarse 2x2 level would
  // reach the sky above the occluders, so the rarer shadow test pays 4x4.
  return screenRectOccluded(camera, uvMin, uvMax, nearestDepth, 3u);
}

@compute @workgroup_size(${workgroupSize})
fn cullViewShadowCamera(@builtin(global_invocation_id) id: vec3<u32>) {
  clearOrderRecord(id.x);
  var early: EarlyCandidate;
  if (!admitEarly(id.x, &early)) { return; }
  if (shadowReceiversHidden(early.primitive, early.world)) {
    atomicAdd(&counters[counterIndex(early.candidate.batchIndex) + ${culledCounterOffset}u], 1u);
    return;
  }
  appendEarly(id.x, early);
}
`;
}
