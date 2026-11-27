import assert from 'node:assert/strict';

// A bounded pixel witness for the fixture's centered, unlit triangle and clear corners.
// Pair this with nativeTriangleDraws from the same completed receipt.
export function nativeTriangleDraws(observed, frameModel) {
  if (observed?.status === 'complete') {
    assert(observed.draws.length > 0, 'A complete empty draw observation is not geometry evidence');
    return { source: 'material-draw-observation', drawCount: observed.draws.length };
  }
  assert(observed?.status === 'unavailable' && observed.reason === 'unsupported-lane',
    'Only the documented GPU-lane observation gap can use actual RHI evidence');
  if (frameModel === undefined)
    return { source: 'projected-triangle-pixels', drawObservationReason: observed.reason };
  const draws = frameModel.works.filter(work =>
    work.kind === 'drawIndexedIndirect' &&
    work.pipeline?.descriptor?.desc?.label === 'pbr-pipeline-forgeax::default-unlit' &&
    work.vertexBuffers?.some(buffer => buffer.bufferHandleId) &&
    work.indexBuffer?.bufferHandleId &&
    work.pipeline.shaders?.some(shader => shader.stage === 'vertex' && shader.entryPoint === 'vs_main') &&
    work.pipeline.shaders?.some(shader => shader.stage === 'fragment' && shader.entryPoint === 'fs_main'));
  assert(draws.length > 0, 'Same-frame RHI must issue the fixture material geometry draw');
  // This proves issuance, not a per-entity material lineage or nonzero indirect count.
  // The independent HDR foreground/background witness remains mandatory.
  return { source: 'same-frame-rhi', drawObservationReason: observed.reason, drawCount: draws.length };
}

function triangleCoverage(rgb, width, height, clear) {
  // Independent projection of the authored createPrimitiveMesh('triangle') positions.
  // Camera: identity rotation, z=3, vertical fov=PI/4, declared aspect=16/9.
  // Do not replace that aspect with the readback extent's aspect in square CPU tests.
  const focal = 1 / Math.tan(Math.PI / 8);
  const points = [[0, Math.fround(0.7)], [-Math.fround(0.7), -Math.fround(0.6)],
    [Math.fround(0.7), -Math.fround(0.6)]].map(([x, y]) =>
    [width * (1 + x * focal / (3 * 16 / 9)) / 2, height * (1 - y * focal / 3) / 2]);
  const edges = points.map((a, i) => {
    const b = points[(i + 1) % 3];
    return { x: a[0], y: a[1], dx: b[0] - a[0], dy: b[1] - a[1], length: Math.hypot(b[0] - a[0], b[1] - a[1]) };
  });
  const coverage = { edgeBandPixels: 2, interior: 0, exterior: 0, excluded: 0, mismatches: 0, firstFailures: [] };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let minimum = Infinity;
    for (const edge of edges)
      minimum = Math.min(minimum, -(edge.dx * (y + 0.5 - edge.y) - edge.dy * (x + 0.5 - edge.x)) / edge.length);
    if (minimum > -2 && minimum < 2) { coverage.excluded++; continue; }
    const inside = minimum >= 2;
    if (inside) coverage.interior++; else coverage.exterior++;
    let delta = 0;
    for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(rgb[(y * width + x) * 3 + c] - clear[c]));
    if (inside ? delta > 0.1 : delta < 0.02) continue;
    coverage.mismatches++;
    if (coverage.firstFailures.length < 8) coverage.firstFailures.push({ x, y, expected: inside ? 'foreground' : 'clear', delta });
  }
  assert(coverage.interior > 0 && coverage.exterior > 0, `Triangle projection has no effective classification: ${JSON.stringify(coverage)}`);
  assert.equal(coverage.mismatches, 0, `Projected triangle classification failed: ${JSON.stringify(coverage)}`);
  return coverage;
}

export function nativeTrianglePixels(rgb, width, height, clear) {
  assert(Number.isSafeInteger(width) && width >= 16);
  assert(Number.isSafeInteger(height) && height >= 16);
  assert.equal(rgb.length, width * height * 3);
  assert(clear.length >= 3 && clear.slice(0, 3).every(Number.isFinite));
  let foreground = 0;
  for (let pixel = 0; pixel < width * height; pixel++) {
    let delta = 0;
    for (let c = 0; c < 3; c++) {
      const value = rgb[pixel * 3 + c];
      assert(Number.isFinite(value), 'Native HDR pixels must be finite');
      delta = Math.max(delta, Math.abs(value - clear[c]));
    }
    foreground += Number(delta > 0.05);
  }
  const fraction = foreground / (width * height);
  assert(fraction > 0.01 && fraction < 0.5, 'Clear-only, tiny and full-screen outputs are not a triangle witness');
  const patch = (u, v) => {
    const mean = [0, 0, 0];
    const x = Math.floor(u * width), y = Math.floor(v * height);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
      for (let c = 0; c < 3; c++) mean[c] += rgb[((y + dy) * width + x + dx) * 3 + c] / 9;
    return mean;
  };
  const center = patch(0.5, 0.5);
  assert(Math.max(...center.map((value, c) => Math.abs(value - clear[c]))) > 0.1,
    'The known central triangle region must differ from the clear color');
  const corners = [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]].map(([u, v]) => patch(u, v));
  for (const corner of corners)
    assert(corner.every((value, c) => Math.abs(value - clear[c]) < 0.02),
      'The known background regions must retain the clear color');
  const coverage = triangleCoverage(rgb, width, height, clear);
  return { foreground, fraction, center, corners, coverage };
}
