import type { CubeParserError } from '../errors.js';
import { cubeParserError } from '../errors.js';

export interface CubeLut {
  readonly size: 16 | 32 | 64;
  readonly domainMin: readonly [number, number, number];
  readonly domainMax: readonly [number, number, number];
  readonly values: Float32Array;
  readonly sourceKey: string;
}

export type CubeLutResult =
  | { readonly ok: true; readonly value: CubeLut }
  | { readonly ok: false; readonly error: CubeParserError };

const ALLOWED_SIZES = new Set([16, 32, 64]);

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function parseTriple(tokens: readonly string[]): readonly [number, number, number] | undefined {
  if (tokens.length !== 3) return undefined;
  const values = tokens.map(Number);
  if (!values.every(finite)) return undefined;
  const [red, green, blue] = values;
  if (red === undefined || green === undefined || blue === undefined) return undefined;
  return [red, green, blue];
}

function float32ToFloat16(value: number): number {
  const input = new Float32Array([value]);
  const bits = new Uint32Array(input.buffer).at(0) ?? 0;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const fraction = bits & 0x7fffff;
  if (exponent === 0xff) return sign | (fraction === 0 ? 0x7c00 : 0x7e00);
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return sign | 0x7c00;
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign;
    const mantissa = (fraction | 0x800000) >>> (1 - halfExponent);
    return sign | ((mantissa + 0x1000) >>> 13);
  }
  return sign | (halfExponent << 10) | ((fraction + 0x1000) >>> 13);
}

export function parseCubeLut(source: string, sourceKey = '<inline .cube>'): CubeLutResult {
  let size: number | undefined;
  let domainMin: readonly [number, number, number] | undefined;
  let domainMax: readonly [number, number, number] | undefined;
  const values: number[] = [];
  const lines = source.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.replace(/#.*/, '').trim();
    const lineNumber = index + 1;
    if (line.length === 0) continue;
    const tokens = line.split(/\s+/);
    const directive = tokens.shift();
    if (directive === undefined) continue;
    if (directive === 'TITLE') continue;
    if (directive === 'LUT_3D_SIZE') {
      const sizeToken = tokens[0];
      if (
        size !== undefined ||
        tokens.length !== 1 ||
        sizeToken === undefined ||
        !/^\d+$/.test(sizeToken)
      ) {
        return {
          ok: false,
          error: cubeParserError('cube-size-invalid', sourceKey, 'LUT_3D_SIZE', line, lineNumber),
        };
      }
      size = Number(sizeToken);
      if (!ALLOWED_SIZES.has(size)) {
        return {
          ok: false,
          error: cubeParserError('cube-size-invalid', sourceKey, 'LUT_3D_SIZE', size, lineNumber),
        };
      }
      continue;
    }
    if (directive === 'DOMAIN_MIN' || directive === 'DOMAIN_MAX') {
      const triple = parseTriple(tokens);
      if (triple === undefined) {
        return {
          ok: false,
          error: cubeParserError('cube-domain-invalid', sourceKey, directive, line, lineNumber),
        };
      }
      if (directive === 'DOMAIN_MIN') {
        if (domainMin !== undefined)
          return {
            ok: false,
            error: cubeParserError('cube-domain-invalid', sourceKey, directive, line, lineNumber),
          };
        domainMin = triple;
      } else {
        if (domainMax !== undefined)
          return {
            ok: false,
            error: cubeParserError('cube-domain-invalid', sourceKey, directive, line, lineNumber),
          };
        domainMax = triple;
      }
      continue;
    }
    if (directive === 'LUT_1D_SIZE') {
      return {
        ok: false,
        error: cubeParserError('cube-header-invalid', sourceKey, directive, line, lineNumber),
      };
    }
    const row = parseTriple([directive, ...tokens]);
    if (row === undefined || row.some((value) => value < 0 || value > 1)) {
      return {
        ok: false,
        error: cubeParserError('cube-row-invalid', sourceKey, 'RGB row', line, lineNumber),
      };
    }
    values.push(...row);
  }

  if (size === undefined)
    return {
      ok: false,
      error: cubeParserError('cube-header-invalid', sourceKey, 'LUT_3D_SIZE', 'missing'),
    };
  if (domainMin === undefined || domainMax === undefined) {
    return {
      ok: false,
      error: cubeParserError('cube-domain-invalid', sourceKey, 'DOMAIN_MIN/MAX', 'missing'),
    };
  }
  if (
    domainMin.some((value, index) => {
      const maxValue = domainMax[index];
      return maxValue !== undefined && value >= maxValue;
    })
  ) {
    return {
      ok: false,
      error: cubeParserError('cube-domain-invalid', sourceKey, 'DOMAIN_MIN/MAX', {
        domainMin,
        domainMax,
      }),
    };
  }
  const expectedValues = size ** 3 * 3;
  if (values.length !== expectedValues) {
    return {
      ok: false,
      error: cubeParserError('cube-data-count-invalid', sourceKey, 'RGB rows', {
        expected: expectedValues / 3,
        actual: values.length / 3,
      }),
    };
  }
  return {
    ok: true,
    value: {
      size: size as 16 | 32 | 64,
      domainMin,
      domainMax,
      values: new Float32Array(values),
      sourceKey,
    },
  };
}

export function cubeLutBytes(lut: CubeLut): Uint8Array {
  const bytes = new Uint8Array(lut.size ** 3 * 4 * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < lut.size ** 3; index += 1) {
    const valueOffset = index * 3;
    const byteOffset = index * 8;
    view.setUint16(byteOffset, float32ToFloat16(lut.values[valueOffset] ?? 0), true);
    view.setUint16(byteOffset + 2, float32ToFloat16(lut.values[valueOffset + 1] ?? 0), true);
    view.setUint16(byteOffset + 4, float32ToFloat16(lut.values[valueOffset + 2] ?? 0), true);
    view.setUint16(byteOffset + 6, 0x3c00, true);
  }
  return bytes;
}
