const decode = value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;

// D3D functional specification's SRGB -> FLOAT conversion permits 0.5 ULP on the sRGB
// integer side. Endpoints must be exact. The existing HDR budget covers
// subsequent shader arithmetic and rgba16float storage, independently.
// https://microsoft.github.io/DirectX-Specs/d3d/archive/D3D11_3_FunctionalSpec.htm
export function sourceSrgbInterval(byte, linearHdrBudget) {
  const radius = byte === 0 || byte === 255 ? 0 : .5;
  return [decode((byte - radius) / 255) - linearHdrBudget,
    decode((byte + radius) / 255) + linearHdrBudget];
}

export function matchesSourceSrgb(actual, bytes, linearHdrBudget) {
  return actual.length === bytes.length && actual.every((value, channel) => {
    const [min, max] = sourceSrgbInterval(bytes[channel], linearHdrBudget);
    return Number.isFinite(value) && value >= min && value <= max;
  });
}
