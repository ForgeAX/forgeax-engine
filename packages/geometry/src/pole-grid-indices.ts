/** Stitch latitude rings, omitting the collapsed triangle at each pole. */
export function poleGridIndices(columns: number, rows: number): Uint32Array {
  const indices = new Uint32Array(columns * (rows - 1) * 6);
  const stride = columns + 1;
  let index = 0;
  for (let row = 0; row < rows - 1; row++) {
    for (let column = 0; column < columns; column++) {
      const a = row * stride + column + 1;
      const b = a - 1;
      const c = (row + 1) * stride + column;
      const d = c + 1;
      if (row !== 0) {
        indices[index++] = a;
        indices[index++] = b;
        indices[index++] = d;
      }
      if (row !== rows - 2) {
        indices[index++] = b;
        indices[index++] = c;
        indices[index++] = d;
      }
    }
  }
  return indices.slice(0, index);
}
