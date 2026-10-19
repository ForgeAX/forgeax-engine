import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';

// Deliberately asymmetric UV charts: colored checks, cell coordinates and alpha
// steps expose orientation, channel selection, filtering and source-mip mistakes.
const palette = [
  [200, 80, 20], [0, 220, 0], [0, 0, 230], [220, 40, 180],
  [20, 200, 220], [230, 180, 20], [110, 40, 220], [40, 150, 100],
];
const digits = ['111101101101111', '010110010010111', '111001111100111', '111001111001111',
  '101101111001001', '111100111001111', '111100111101111', '111001001001001'];
function checker(size: number, mip = 0, alpha = true): number[] {
  const result: number[] = [], cell = size / 8;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const col = Math.floor(x / cell), row = Math.floor(y / cell);
    const lx = x % cell, ly = y % cell;
    const ink = cell >= 16 && ly >= 3 && ly < 8 && (
      (lx >= 3 && lx < 6 && digits[row]![Math.floor(ly - 3) * 3 + Math.floor(lx - 3)] === '1') ||
      (lx >= 8 && lx < 11 && digits[col]![Math.floor(ly - 3) * 3 + Math.floor(lx - 8)] === '1'));
    const border = lx === 0 || ly === 0;
    const rgb = ink ? [245, 245, 245] : border ? [12, 12, 12] : palette[(col + row * 3 + mip) % 8]!;
    result.push(...rgb, alpha ? [255, 64, 128][(col + row) % 3]! : 255);
  }
  return result;
}
const texture = (width: number, height: number, layers: number, data: number[], levels = 1) => ({
  kind: 'texture' as const,
  shape: layers === 1 ? { viewDimension: '2d' as const, extent: { width, height } }
    : { viewDimension: '2d-array' as const, extent: { width, height, layers } },
  format: 'rgba8unorm' as const, colorSpace: 'linear' as const, data: new Uint8Array(data),
  mips: levels === 1 ? { kind: 'none' as const } : { kind: 'packed' as const, levelCount: levels },
});

export default definePack({
  schemaVersion: '2.0.0', packageId: definePackageId('019e7601-0000-7000-8000-000000000000'),
  name: 'Texture inspection charts', build: () => {
    const mips = [256, 128, 64, 32].flatMap((size, mip) => checker(size, mip, mip === 0));
    // Axis colors: +X red, -X cyan, +Y green, -Y magenta, +Z blue, -Z yellow.
    // The grid and the bright northern/dark southern hemisphere expose flips.
    const axes = [[240, 30, 30], [20, 210, 210], [30, 230, 30], [220, 20, 200], [30, 60, 240], [230, 190, 20]];
    const environment: number[] = [];
    for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) {
      const longitude = ((x + 0.5) / 512 - 0.5) * Math.PI * 2;
      // Engine's spherical-map convention places +Y at source v=1.
      const latitude = ((y + 0.5) / 256 - 0.5) * Math.PI;
      const d = [Math.cos(latitude) * Math.cos(longitude), Math.sin(latitude), Math.cos(latitude) * Math.sin(longitude)];
      const axis = Math.abs(d[0]!) >= Math.abs(d[1]!) && Math.abs(d[0]!) >= Math.abs(d[2]!) ? 0
        : Math.abs(d[1]!) >= Math.abs(d[2]!) ? 1 : 2;
      const face = axis * 2 + (d[axis]! < 0 ? 1 : 0);
      const grid = x % 32 === 0 || y % 32 === 0;
      const shade = ((Math.floor(x / 32) + Math.floor(y / 32)) % 2 === 0 ? 1 : 0.65) * (y >= 128 ? 1 : 0.75);
      environment.push(...(grid ? [245, 245, 245] : axes[face]!.map(v => Math.round(v * shade))), 255);
    }
    return ok({
      'texture/rgba-mips': texture(256, 256, 1, mips, 4),
      'texture/color-checker': texture(256, 256, 1, checker(256, 0, false)),
      'texture/array': texture(64, 64, 2, [...checker(64, 0, false), ...checker(64, 2, false)]),
      'texture/volume': { ...texture(64, 64, 2, [...checker(64, 0, false), ...checker(64, 1, false)]),
        shape: { viewDimension: '3d' as const, extent: { width: 64, height: 64, depth: 2 } } },
      'texture/filter': texture(2, 2, 1, [255,0,0,255,0,0,255,255,255,0,0,255,0,0,255,255]),
      'texture/hdr': { ...texture(2, 2, 1, []), format: 'rgba16float' as const,
        data: new Uint8Array(new Uint16Array(Array(4).fill([0x4000,0x3400,0x3000,0x3c00]).flat()).buffer) },
      'equirect/environment': { kind: 'equirect' as const, width: 512, height: 256,
        format: 'rgba8unorm' as const, colorSpace: 'linear' as const, data: new Uint8Array(environment) },
    });
  },
});
