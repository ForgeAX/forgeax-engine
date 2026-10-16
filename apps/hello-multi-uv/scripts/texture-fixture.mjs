export function solidTexture(rgba) {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
    format: 'rgba8unorm',
    data: new Uint8Array([...rgba, ...rgba, ...rgba, ...rgba]),
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
}
