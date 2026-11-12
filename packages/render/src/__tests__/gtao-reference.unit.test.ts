import { expect, it } from 'vitest';
import {
  boxSceneField,
  byteErrorMetrics,
  byteErrorsWithinBudget,
  composeLinearLightingReference,
  computeGtaoRawReference,
  decodeMaterialNormalX12Y12,
  decodeTangentNormalRgSample,
  encodeMaterialNormalX12Y12,
  filterGtaoReference,
  GTAO_COMPARISON_BUDGET,
  type GtaoReferenceConfig,
  materialNormalFieldMetrics,
  normalAngularError,
  orthographicProjection,
  perspectiveProjection,
  reverseZDeviceDepth,
  sampleGtaoBilinearLinearClamp,
} from './gtao-reference';

const config: GtaoReferenceConfig = {
  outputWidth: 12,
  outputHeight: 9,
  radius: 1.25,
  bias: 0,
  thickness: 1,
  distanceExponent: 1,
  distanceFallOff: 1,
  sampleBudget: 16,
  intensity: 1,
};

function planeField() {
  return boxSceneField({
    width: 23,
    height: 17,
    fovY: Math.PI / 3,
    near: 0.1,
    far: 30,
    boxes: [{ center: [0, 0, -4.005], size: [20, 20, 0.01] }],
  });
}

function contactField() {
  return boxSceneField({
    width: 23,
    height: 17,
    fovY: Math.PI / 3,
    near: 0.1,
    far: 30,
    boxes: [
      { center: [0, 0, -4.005], size: [20, 20, 0.01] },
      { center: [0, 0, -3.9], size: [1.4, 1.4, 0.2] },
    ],
  });
}

it('keeps fixed normal, raw, filter, and linear-lighting error budgets before GPU comparison', () => {
  expect(GTAO_COMPARISON_BUDGET).toEqual({
    materialNormalX12Y12AngularRadians: 0.0011,
    rawVisibilityMaxByteError: 3,
    rawVisibilityRmsByteError: 1.25,
    rawNormalMaxByteError: 3,
    rawNormalRmsByteError: 1.25,
    filteredVisibilityMaxByteError: 3,
    filteredVisibilityRmsByteError: 1.25,
    linearLightingMaxAbsoluteError: 0.015,
    linearLightingMaxRelativeError: 0.02,
    linearLightingRelativeFloor: 0.05,
    linearLightingRmsAbsoluteError: 0.003,
  });
});

it('bilinearly samples a constant visibility field without changing its value', () => {
  const values = new Uint8Array(5 * 3).fill(117);
  const sample = sampleGtaoBilinearLinearClamp(values, 5, 3, 0.37, 0.62);
  expect(sample.value).toBe(117);
  expect(sample.weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 14);
});

it('reconstructs a linear slope from four texels and exact half-texel centers', () => {
  const width = 4;
  const height = 3;
  const values = Float32Array.from({ length: width * height }, (_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    return 2 + 3 * x + 5 * y;
  });
  const slope = sampleGtaoBilinearLinearClamp(values, width, height, (1.25 + 0.5) / width, 0.5);
  expect(slope.value).toBeCloseTo(2 + 3 * 1.25 + 5, 12);
  expect(slope.texels).toEqual([10, 13, 15, 18]);
  expect(slope.weights).toEqual([0.75, 0.25, 0, 0]);

  const center = sampleGtaoBilinearLinearClamp(values, width, height, (2 + 0.5) / width, 0.5);
  expect(center.value).toBe(values[6]);
  expect(center.weights).toEqual([1, 0, 0, 0]);
});

it('clamps edge samples to the nearest edge texels', () => {
  const values = Uint8Array.from([10, 20, 30, 40, 50, 60]);
  const left = sampleGtaoBilinearLinearClamp(values, 3, 2, 0, 0.25);
  const right = sampleGtaoBilinearLinearClamp(values, 3, 2, 1, 0.25);
  expect(left.value).toBe(10);
  expect(left.texels).toEqual([10, 20, 40, 50]);
  expect(left.weights).toEqual([1, 0, 0, 0]);
  expect(right.value).toBe(30);
  expect(right.texels).toEqual([30, 30, 60, 60]);
  expect(right.weights).toEqual([1, 0, 0, 0]);
});

it('matches odd full-to-half extents at a fractional contact-pixel center', () => {
  const fullWidth = 129;
  const fullHeight = 97;
  const aoWidth = 65;
  const aoHeight = 49;
  const contactX = 63;
  const contactY = 47;
  const values = Float32Array.from({ length: aoWidth * aoHeight }, (_, index) => {
    const x = index % aoWidth;
    const y = Math.floor(index / aoWidth);
    return x + 100 * y;
  });
  const u = (contactX + 0.5) / fullWidth;
  const v = (contactY + 0.5) / fullHeight;
  const sample = sampleGtaoBilinearLinearClamp(values, aoWidth, aoHeight, u, v);
  const x = u * aoWidth - 0.5;
  const y = v * aoHeight - 0.5;
  expect(sample.x0).toBe(31);
  expect(sample.x1).toBe(32);
  expect(sample.y0).toBe(23);
  expect(sample.y1).toBe(24);
  expect(sample.tx).toBeCloseTo(x - 31, 14);
  expect(sample.ty).toBeCloseTo(y - 23, 14);
  expect(sample.value).toBeCloseTo(x + 100 * y, 12);
  expect(sample.weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 14);
});

it('quantizes material normals through the X12/Y12 wire format within its angular budget', () => {
  const authored: readonly [number, number, number] = [0.37, -0.28, 0.89];
  const roundTrip = decodeMaterialNormalX12Y12(encodeMaterialNormalX12Y12(authored));
  expect(normalAngularError(authored, roundTrip)).toBeLessThanOrEqual(
    GTAO_COMPARISON_BUDGET.materialNormalX12Y12AngularRadians,
  );
});

it('round trips lower-hemisphere normals on both sides of the octahedral fold boundary', () => {
  const authoredNormals: readonly (readonly [number, number, number])[] = [
    [0, 0, -1],
    [0.3, 0.4, -0.8660254],
    [0.8, 0.6, -0.001],
    [-0.8, 0.6, -0.001],
    [0.8, -0.6, -0.001],
    [-0.8, -0.6, -0.001],
  ];

  for (const normal of authoredNormals) {
    const roundTrip = decodeMaterialNormalX12Y12(encodeMaterialNormalX12Y12(normal));
    expect(normalAngularError(normal, roundTrip), `normal ${normal.join(',')}`).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.materialNormalX12Y12AngularRadians,
    );
  }
});

it('matches the production RG normal decode in the front-facing packed SceneData word', () => {
  const rgba8 = [191, 159, 234] as const;
  const field = boxSceneField({
    width: 1,
    height: 1,
    fovY: Math.PI / 3,
    near: 0.1,
    far: 30,
    normalTextureSample: rgba8.map((channel) => channel / 255) as [number, number, number],
    boxes: [{ center: [0, 0, -4], size: [20, 20, 0.01] }],
  });
  const frontNormal = field.worldNormals[0];
  if (frontNormal === undefined) throw new Error('front fixture pixel is not covered');
  expect(encodeMaterialNormalX12Y12(frontNormal) & 0x00ff_ffff).toBe(0x0094_0a86);
});

it('decodes only RG, reconstructs positive Z, and rejects the RGB-normal interpretation', () => {
  const sample: readonly [number, number, number] = [191 / 255, 159 / 255, 234 / 255];
  const decoded = decodeTangentNormalRgSample(sample);
  const blueChanged = decodeTangentNormalRgSample([sample[0], sample[1], 0]);
  const wrongRgb: readonly [number, number, number] = [
    sample[0] * 2 - 1,
    sample[1] * 2 - 1,
    sample[2] * 2 - 1,
  ];
  const wrongMagnitude = Math.hypot(...wrongRgb);
  const normalizedWrongRgb: readonly [number, number, number] = [
    wrongRgb[0] / wrongMagnitude,
    wrongRgb[1] / wrongMagnitude,
    wrongRgb[2] / wrongMagnitude,
  ];

  expect(decoded[0]).toBeCloseTo((191 / 255) * 2 - 1, 14);
  expect(decoded[1]).toBeCloseTo((159 / 255) * 2 - 1, 14);
  expect(decoded[2]).toBeGreaterThan(0);
  expect(blueChanged).toEqual(decoded);
  expect(normalAngularError(decoded, normalizedWrongRgb)).toBeGreaterThan(
    GTAO_COMPARISON_BUDGET.materialNormalX12Y12AngularRadians,
  );
});

it('omits alpha-masked ray-box coverage and applies the selected material normal sample', () => {
  const width = 23;
  const height = 17;
  const projection = {
    kind: 'perspective' as const,
    fovY: Math.PI / 3,
  };
  const maskedField = boxSceneField({
    width,
    height,
    fovY: projection.fovY,
    near: 0.1,
    far: 30,
    boxes: [
      { center: [0, 0, -6], size: [20, 20, 0.1] },
      {
        center: [0, 0, -4],
        size: [4, 4, 0.1],
        normalTextureSample: [250 / 255, 128 / 255, 0],
        alphaMask: { width: 2, height: 1, green: [0, 1], cutoff: 0.5 },
      },
    ],
  });
  const backgroundField = boxSceneField({
    width,
    height,
    fovY: projection.fovY,
    near: 0.1,
    far: 30,
    boxes: [{ center: [0, 0, -6], size: [20, 20, 0.1] }],
  });
  const holeIndex = 4 * width + 3;
  const keptIndex = 4 * width + 18;
  const holePosition = maskedField.positions[holeIndex];
  const keptPosition = maskedField.positions[keptIndex];
  const holeNormal = maskedField.worldNormals[holeIndex];
  const keptNormal = maskedField.worldNormals[keptIndex];
  expect(holePosition?.[2]).toBeCloseTo(-5.95, 3);
  expect(keptPosition?.[2]).toBeCloseTo(-3.95, 3);
  expect(holeNormal?.[2]).toBeGreaterThan(0.999);
  expect(keptNormal?.[0]).toBeCloseTo((250 / 255) * 2 - 1, 2);

  const aoConfig = {
    outputWidth: 12,
    outputHeight: 9,
    radius: 1.25,
    bias: 0,
    thickness: 1,
    distanceExponent: 1,
    distanceFallOff: 1,
    sampleBudget: 16,
    intensity: 1,
  };
  const maskedRaw = computeGtaoRawReference(maskedField, aoConfig);
  const backgroundRaw = computeGtaoRawReference(backgroundField, aoConfig);
  const outputX = Math.floor(((3 + 0.5) / width) * aoConfig.outputWidth);
  const outputY = Math.floor(((4 + 0.5) / height) * aoConfig.outputHeight);
  const holeOffset = (outputY * aoConfig.outputWidth + outputX) * 4;
  expect(maskedRaw.rgba[holeOffset]).toBe(backgroundRaw.rgba[holeOffset]);
});

it('maps near and far planes to reverse-Z endpoints in perspective and orthographic references', () => {
  const near = 0.1;
  const far = 30;
  const perspective = perspectiveProjection(23, 17, Math.PI / 3, near, far);
  const perspectiveDepth = (viewZ: number) =>
    (perspective.matrix[10] * viewZ + perspective.matrix[14]) /
    (perspective.matrix[11] * viewZ + perspective.matrix[15]);
  expect(perspectiveDepth(-near)).toBeCloseTo(1, 12);
  expect(perspectiveDepth(-far)).toBeCloseTo(0, 12);
  expect(reverseZDeviceDepth(perspective, [0, 0, -near])).toBeCloseTo(1, 12);
  expect(reverseZDeviceDepth(perspective, [0, 0, -far])).toBeCloseTo(0, 12);
  expect(perspective.matrix[0]).toBeGreaterThan(0);
  expect(perspective.matrix[5]).toBeGreaterThan(0);
  expect(perspective.matrix[3]).toBe(0);
  expect(perspective.matrix[7]).toBe(0);
  expect(perspective.matrix[11]).toBe(-1);
  expect(perspective.matrix[15]).toBe(0);
  const perspectivePoint = [0.25, -0.5, -2] as const;
  const perspectiveClipX =
    perspective.matrix[0] * perspectivePoint[0] +
    perspective.matrix[4] * perspectivePoint[1] +
    perspective.matrix[8] * perspectivePoint[2] +
    perspective.matrix[12];
  const perspectiveClipY =
    perspective.matrix[1] * perspectivePoint[0] +
    perspective.matrix[5] * perspectivePoint[1] +
    perspective.matrix[9] * perspectivePoint[2] +
    perspective.matrix[13];
  const perspectiveClipW =
    perspective.matrix[3] * perspectivePoint[0] +
    perspective.matrix[7] * perspectivePoint[1] +
    perspective.matrix[11] * perspectivePoint[2] +
    perspective.matrix[15];
  expect(perspectiveClipW).toBe(2);
  expect(perspectiveClipX / perspectiveClipW).toBeCloseTo(
    (perspective.matrix[0] * perspectivePoint[0]) / 2,
    12,
  );
  expect(perspectiveClipY / perspectiveClipW).toBeCloseTo(
    (perspective.matrix[5] * perspectivePoint[1]) / 2,
    12,
  );

  const bounds = { left: -3, right: 3, bottom: -2.25, top: 2.25 };
  const orthographic = orthographicProjection(
    bounds.left,
    bounds.right,
    bounds.bottom,
    bounds.top,
    near,
    far,
  );
  const orthographicDepth = (viewZ: number) =>
    (orthographic.matrix[10] * viewZ + orthographic.matrix[14]) / orthographic.matrix[15];
  expect(orthographicDepth(-near)).toBeCloseTo(1, 12);
  expect(orthographicDepth(-far)).toBeCloseTo(0, 12);
  expect(reverseZDeviceDepth(orthographic, [0, 0, -near])).toBeCloseTo(1, 12);
  expect(reverseZDeviceDepth(orthographic, [0, 0, -far])).toBeCloseTo(0, 12);
  expect(orthographic.matrix[0]).toBeCloseTo(2 / (bounds.right - bounds.left), 12);
  expect(orthographic.matrix[5]).toBeCloseTo(2 / (bounds.top - bounds.bottom), 12);
  expect(orthographic.matrix[12]).toBeCloseTo(-(bounds.right + bounds.left) / 6, 12);
  expect(orthographic.matrix[13]).toBeCloseTo(-(bounds.top + bounds.bottom) / 4.5, 12);
  expect(orthographic.matrix[3]).toBe(0);
  expect(orthographic.matrix[7]).toBe(0);
  expect(orthographic.matrix[11]).toBe(0);
  expect(orthographic.matrix[15]).toBe(1);
  const orthographicPoint = [0.25, -0.5, -2] as const;
  const orthographicClipX = orthographic.matrix[0] * orthographicPoint[0] + orthographic.matrix[12];
  const orthographicClipY = orthographic.matrix[5] * orthographicPoint[1] + orthographic.matrix[13];
  const orthographicClipW =
    orthographic.matrix[3] * orthographicPoint[0] +
    orthographic.matrix[7] * orthographicPoint[1] +
    orthographic.matrix[11] * orthographicPoint[2] +
    orthographic.matrix[15];
  expect(orthographicClipW).toBe(1);
  expect(orthographicClipX / orthographicClipW).toBeCloseTo(
    orthographic.matrix[0] * orthographicPoint[0] + orthographic.matrix[12],
    12,
  );
  expect(orthographicClipY / orthographicClipW).toBeCloseTo(
    orthographic.matrix[5] * orthographicPoint[1] + orthographic.matrix[13],
    12,
  );
});

it('compares material-normal SceneData against the independent ray-hit field', () => {
  const field = contactField();
  const packed = new Uint8Array(field.width * field.height * 4);
  const view = new DataView(packed.buffer);
  for (let index = 0; index < field.worldNormals.length; index += 1) {
    const normal = field.worldNormals[index];
    if (normal !== undefined) view.setUint32(index * 4, encodeMaterialNormalX12Y12(normal), true);
  }
  const metrics = materialNormalFieldMetrics(field, packed);
  expect(metrics.count).toBeGreaterThan(0);
  expect(metrics.firstMismatch).toBeUndefined();
  expect(metrics.maxAngularRadians).toBeLessThanOrEqual(
    GTAO_COMPARISON_BUDGET.materialNormalX12Y12AngularRadians,
  );

  const falsified = packed.slice();
  const firstSurface = field.worldNormals.findIndex((normal) => normal !== undefined);
  if (firstSurface < 0) throw new Error('reference scene has no material-normal surface');
  new DataView(falsified.buffer).setUint32(
    firstSurface * 4,
    encodeMaterialNormalX12Y12([0, 0, -1]),
    true,
  );
  expect(materialNormalFieldMetrics(field, falsified).maxAngularRadians).toBeGreaterThan(
    GTAO_COMPARISON_BUDGET.materialNormalX12Y12AngularRadians,
  );
});

it('compares only unsigned normal bits and preserves unrelated high-byte data', () => {
  const field = boxSceneField({
    width: 1,
    height: 1,
    fovY: Math.PI / 3,
    near: 0.1,
    far: 30,
    boxes: [{ center: [0, 0, -4], size: [20, 20, 0.01] }],
  });
  const normal = field.worldNormals[0];
  if (normal === undefined) throw new Error('front fixture pixel is not covered');
  const expectedLow24 = encodeMaterialNormalX12Y12(normal) & 0x00ff_ffff;

  for (const highByte of [0x00, 0x7f, 0x80, 0xff]) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, expectedLow24 | (highByte << 24), true);
    const metrics = materialNormalFieldMetrics(field, bytes);
    expect(metrics.firstMismatch, `high byte 0x${highByte.toString(16)}`).toBeUndefined();
    expect(metrics.maxError?.expectedLow24).toBe(expectedLow24);
    expect(metrics.maxError?.actualLow24).toBe(expectedLow24);
  }

  const changed = new Uint8Array(4);
  const changedLow24 = expectedLow24 ^ 1;
  new DataView(changed.buffer).setUint32(0, changedLow24 | 0xff00_0000, true);
  const mismatch = materialNormalFieldMetrics(field, changed).firstMismatch;
  expect(mismatch).toEqual({
    x: 0,
    y: 0,
    expected: expectedLow24,
    actual: (changedLow24 | 0xff00_0000) >>> 0,
  });
});

it('produces open-plane and contact-shadow raw/filter references from ray-hit depth and normals', () => {
  const plane = planeField();
  const planeRaw = computeGtaoRawReference(plane, config);
  const planeFiltered = filterGtaoReference(plane, planeRaw, config.radius);
  expect(planeRaw.width).toBe(12);
  expect(planeRaw.height).toBe(9);
  expect(Math.min(...planeFiltered)).toBeGreaterThanOrEqual(250);

  const contact = contactField();
  const contactRaw = computeGtaoRawReference(contact, config);
  const contactFiltered = filterGtaoReference(contact, contactRaw, config.radius);
  expect(Math.min(...contactRaw.rgba.filter((_, index) => index % 4 === 0))).toBeLessThan(250);
  expect(Math.min(...contactFiltered)).toBeLessThan(250);
  expect(Math.max(...contactFiltered)).toBeGreaterThan(250);
});

it('reconstructs an orthographic reverse-Z contact field independently', () => {
  const field = boxSceneField({
    width: 23,
    height: 17,
    fovY: 0,
    near: 0.1,
    far: 30,
    projection: {
      kind: 'orthographic',
      left: -3,
      right: 3,
      bottom: -2.25,
      top: 2.25,
    },
    boxes: [
      { center: [0, 0, -4.005], size: [20, 20, 0.01] },
      { center: [0, 0, -3.9], size: [1.4, 1.4, 0.2] },
    ],
  });
  const raw = computeGtaoRawReference(field, { ...config, outputWidth: 23, outputHeight: 17 });
  const filtered = filterGtaoReference(field, raw, config.radius);
  expect(field.projection.kind).toBe('orthographic');
  expect(field.projection.matrix[15]).toBe(1);
  expect(Math.min(...filtered)).toBeLessThan(250);
  expect(Math.max(...filtered)).toBeGreaterThan(250);
});

it('falsifies raw, filtered, and final-lighting errors beyond frozen budgets', () => {
  const contact = contactField();
  const raw = computeGtaoRawReference(contact, config);
  const filtered = filterGtaoReference(contact, raw, config.radius);
  const rawPerturbed = raw.rgba.slice();
  const rawIndex = Array.from(raw.rgba).findIndex((value, index) => index % 4 === 0 && value >= 20);
  if (rawIndex < 0) throw new Error('reference has no raw visibility value to perturb');
  rawPerturbed[rawIndex] = (rawPerturbed[rawIndex] ?? 0) - 20;
  const rawError = byteErrorMetrics(rawPerturbed, raw.rgba);
  expect(rawError.maxAbsolute).toBe(20);
  expect(
    byteErrorsWithinBudget(rawPerturbed, raw.rgba, {
      maximum: GTAO_COMPARISON_BUDGET.rawVisibilityMaxByteError,
      rms: GTAO_COMPARISON_BUDGET.rawVisibilityRmsByteError,
    }),
  ).toBe(false);

  const filteredPerturbed = filtered.slice();
  const filteredIndex = filtered.findIndex((value) => value >= 20);
  if (filteredIndex < 0) throw new Error('reference has no filtered visibility value to perturb');
  const filteredValue = filteredPerturbed[filteredIndex] ?? 0;
  filteredPerturbed[filteredIndex] = filteredValue - 20;
  expect(
    byteErrorsWithinBudget(filteredPerturbed, filtered, {
      maximum: GTAO_COMPARISON_BUDGET.filteredVisibilityMaxByteError,
      rms: GTAO_COMPARISON_BUDGET.filteredVisibilityRmsByteError,
    }),
  ).toBe(false);

  const screenVisibility = 0.42;
  const lightingInput = {
    indirect: [0.8, 0.6, 0.4] as const,
    direct: [1.2, 0.7, 0.2] as const,
    emissive: [0.1, 0.05, 0.02] as const,
    screenVisibility,
    materialOcclusion: 0.75,
    directLightingStrength: 0.35,
  };
  const expected = composeLinearLightingReference(lightingInput);
  const doubleApplied = composeLinearLightingReference({
    ...lightingInput,
    screenVisibility: screenVisibility * screenVisibility,
  });
  const maxDoubleApplyError = Math.max(
    ...expected.map((channel, index) => Math.abs(channel - (doubleApplied[index] ?? 0))),
  );
  expect(maxDoubleApplyError).toBeGreaterThan(
    GTAO_COMPARISON_BUDGET.linearLightingMaxAbsoluteError,
  );
  expect(expected[0]).toBeGreaterThan(lightingInput.emissive[0]);
});
