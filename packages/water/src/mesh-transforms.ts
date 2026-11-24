import { requireWaterValue } from './required-value.js';

export function waterInfoZoneTransformSupported(matrix: readonly number[]): boolean {
  const epsilon = 1e-5;
  return (
    Array.isArray(matrix) &&
    matrix.length === 16 &&
    Array.from(matrix).every(Number.isFinite) &&
    Math.abs(requireWaterValue(matrix[1])) <= epsilon &&
    Math.abs(requireWaterValue(matrix[2])) <= epsilon &&
    Math.abs(requireWaterValue(matrix[4])) <= epsilon &&
    Math.abs(requireWaterValue(matrix[6])) <= epsilon &&
    Math.abs(requireWaterValue(matrix[8])) <= epsilon &&
    Math.abs(requireWaterValue(matrix[9])) <= epsilon
  );
}
export function waterMeshZoneTransformSupported(matrix: readonly number[]): boolean {
  if (!waterInfoZoneTransformSupported(matrix)) return false;
  const scaleX = Math.hypot(
    requireWaterValue(matrix[0]),
    requireWaterValue(matrix[1]),
    requireWaterValue(matrix[2]),
  );
  const scaleZ = Math.hypot(
    requireWaterValue(matrix[8]),
    requireWaterValue(matrix[9]),
    requireWaterValue(matrix[10]),
  );
  return (
    scaleX > 1e-6 &&
    scaleZ > 1e-6 &&
    Math.abs(scaleX - scaleZ) <= Math.max(1, scaleX, scaleZ) * 1e-5
  );
}
export function waterMeshBodyTransformSupported(matrix: readonly number[]): boolean {
  const verticalScale = matrix[5] ?? 0;
  const epsilon = Math.max(1, verticalScale) * 1e-5;
  return (
    matrix.length === 16 &&
    matrix.every(Number.isFinite) &&
    verticalScale > 1e-6 &&
    Math.abs(requireWaterValue(matrix[1])) <= epsilon &&
    Math.abs(requireWaterValue(matrix[9])) <= epsilon
  );
}
export function transformPoint(
  matrix: readonly number[],
  point: readonly [number, number, number],
): [number, number, number] {
  return [
    requireWaterValue(matrix[0]) * point[0] +
      requireWaterValue(matrix[4]) * point[1] +
      requireWaterValue(matrix[8]) * point[2] +
      requireWaterValue(matrix[12]),
    requireWaterValue(matrix[1]) * point[0] +
      requireWaterValue(matrix[5]) * point[1] +
      requireWaterValue(matrix[9]) * point[2] +
      requireWaterValue(matrix[13]),
    requireWaterValue(matrix[2]) * point[0] +
      requireWaterValue(matrix[6]) * point[1] +
      requireWaterValue(matrix[10]) * point[2] +
      requireWaterValue(matrix[14]),
  ];
}
