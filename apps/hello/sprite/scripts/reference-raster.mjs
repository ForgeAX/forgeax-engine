import assert from 'node:assert/strict';

// Independent CPU oracle for this axis-aligned, orthographic smoke fixture.
// It consumes author inputs, never candidate pixels, renderer state or WGSL.
export function rasterizeSpriteReference({ width, height, clear, layout, tints, texture,
  scale, tonemap, whitePoint = 8 }) {
  assert.ok(tonemap === 'none' || tonemap === 'reinhard');
  assert.equal(layout.sprites.length, tints.length);
  const decode = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const encode = c => c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Camera bounds are [-1,1] in both axes. Sprite size has one authority:
      // the entity scale, applied to its unit quad around the authored pivot.
      const world = [(x + 0.5) * 2 / width - 1, 1 - (y + 0.5) * 2 / height];
      let color = clear.slice(0, 3);
      let alpha = clear[3];
      for (const [index, sprite] of layout.sprites.entries()) {
        const u = (world[0] - sprite.pos[0]) / scale + layout.pivot[0];
        const v = (world[1] - sprite.pos[1]) / scale + layout.pivot[1];
        if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
        const sx = u * texture.width - 0.5, sy = v * texture.height - 0.5;
        const ix = Math.floor(sx), iy = Math.floor(sy);
        const texel = [0, 0, 0, 0];
        // Default material sampling is bilinear/repeat. Decode each source
        // texel before interpolation, as required by an sRGB texture view.
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const tx = ((ix + dx) % texture.width + texture.width) % texture.width;
          const ty = ((iy + dy) % texture.height + texture.height) % texture.height;
          const weight = (dx ? sx - ix : 1 - (sx - ix)) * (dy ? sy - iy : 1 - (sy - iy));
          const offset = (ty * texture.width + tx) * 4;
          for (let c = 0; c < 4; c++)
            texel[c] += weight * (c < 3 ? decode(texture.data[offset + c] / 255) : texture.data[offset + c] / 255);
        }
        const tint = tints[index];
        const a = texel[3] * tint[3];
        color = color.map((background, channel) =>
          texel[channel] * tint[channel] * a + background * (1 - a));
        alpha = a + alpha * (1 - a);
      }
      if (tonemap === 'reinhard') {
        const luma = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
        const gain = luma === 0 ? 0 : (1 + luma / (whitePoint * whitePoint)) / (1 + luma);
        color = color.map(c => c * gain);
      }
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++)
        pixels[offset + channel] = Math.round(encode(Math.max(0, Math.min(1, color[channel]))) * 255);
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  return { width, height, pixels };
}
