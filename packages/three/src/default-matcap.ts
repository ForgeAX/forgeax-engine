import {
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
} from 'three/src/Three.Core.js';

// r184's procedural matcap is linear in V: mix(0.2, 0.8, uv.y).
// The native matcap UV stays in [0.005, 0.995], inside these texel centers;
// bilinear sampling reproduces that ramp without changing any native shader.
const height = 128;
const data = new Uint16Array(height * 4);
for (let y = 0; y < height; y++) {
  const value = 0.2 + (0.6 * (y + 0.5)) / height;
  data.set([value, value, value, 1].map(DataUtils.toHalfFloat), y * 4);
}
export const defaultMatcap = new DataTexture(data, 1, height, RGBAFormat, HalfFloatType);
defaultMatcap.magFilter = defaultMatcap.minFilter = LinearFilter;
defaultMatcap.needsUpdate = true;
