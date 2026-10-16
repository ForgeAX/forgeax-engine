/** Eight corners of an ordinary axis-aligned box in local meters. */
export function boxPoints(lower, upper) {
  return new Float32Array(
    Array.from({ length: 8 }, (_, corner) =>
      [0, 1, 2].map((axis) => (((corner >> axis) & 1) === 0 ? lower[axis] : upper[axis])),
    ).flat(),
  );
}
