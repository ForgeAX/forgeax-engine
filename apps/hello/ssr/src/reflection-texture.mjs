// Deterministic calibration texture shared by Browser and Dawn. Broad checks
// reveal warping, fine lines reveal lost detail, and the arrow reveals flips.
export function createReflectionTexture() {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const checker = (Math.floor(x / 32) + Math.floor(y / 32)) % 2;
      const grid = x % 16 < 2 || y % 16 < 2;
      const border = x < 4 || y < 4 || x >= size - 4 || y >= size - 4;
      const arrow = (x >= 53 && x <= 73 && y >= 36 && y <= 103)
        || (y >= 17 && y <= 52 && Math.abs(x - 63) <= y - 17);
      const marker = x >= 9 && x <= 22 && y >= 9 && y <= 22;
      const value = border ? 12 : arrow || marker ? 255 : grid ? 35 : checker ? 180 : 75;
      const p = (y * size + x) * 4;
      data.set([value, value, value, 255], p);
    }
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: size, height: size } },
    format: 'rgba8unorm-srgb', colorSpace: 'srgb', mips: { kind: 'generate' }, data,
  };
}
