import fixture from '../dark-gradient-fixture.json' with { type: 'json' };

const gradient = fixture.scene.gradient;
const [linearLow, linearHigh] = gradient.linearRange;

export function gradientValue(position, stops) {
  const denominator = Math.max(1, stops - 1);
  const scaled = Math.min(1, Math.max(0, position)) * denominator;
  const stopIndex = Math.min(stops - 1, Math.floor(scaled));
  const stopFraction = stopIndex === stops - 1 ? 0 : scaled - stopIndex;
  return Math.min(1, (stopIndex + stopFraction * 0.9) / denominator);
}

export function createDarkGradientTexture() {
  const { width, height, stops } = gradient;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const xValue = gradientValue(x / (width - 1), stops);
      const yValue = gradientValue(y / (height - 1), stops);
      const offset = (y * width + x) * 4;
      const red = xValue;
      const green = xValue * 0.85 + yValue * 0.15;
      const blue = xValue * 0.7 + yValue * 0.3;
      data[offset] = Math.round((linearLow + red * (linearHigh - linearLow)) * 255);
      data[offset + 1] = Math.round((linearLow + green * (linearHigh - linearLow)) * 255);
      data[offset + 2] = Math.round((linearLow + blue * (linearHigh - linearLow)) * 255);
      data[offset + 3] = 255;
    }
  }
  return {
    kind: 'texture',
    shape: {
      viewDimension: '2d',
      extent: { width, height },
    },
    format: 'rgba8unorm',
    data,
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
}

export function darkGradientQuad() {
  return fixture.scene.gradientQuad;
}
