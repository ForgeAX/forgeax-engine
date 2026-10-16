import assert from 'node:assert/strict';

/** Decode the current captured SNORM16 brick pool, without invoking the producer. */
export function sdfStorageCode(view, offset, dimensions, index) {
  const [nx, ny] = dimensions;
  const x = index % nx,
    y = Math.floor(index / nx) % ny,
    z = Math.floor(index / (nx * ny));
  const brick =
    (Math.floor(z / 4) * Math.ceil(ny / 4) + Math.floor(y / 4)) * Math.ceil(nx / 4) +
    Math.floor(x / 4);
  const tableWords = dimensions.reduce((n, d) => n * Math.ceil(d / 4), 1);
  const entry = view.getUint32((offset + brick) * 4, true);
  assert(
    entry >= tableWords && (entry - tableWords) % 32 === 0,
    'captured SDF brick must address a complete payload',
  );
  const local = ((z % 4) * 4 + (y % 4)) * 4 + (x % 4);
  return view.getInt16((offset + entry) * 4 + local * 2, true);
}
