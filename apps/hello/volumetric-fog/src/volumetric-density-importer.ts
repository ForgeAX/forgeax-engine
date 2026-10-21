import {
  IMPORT_ERROR_HINTS,
  type ImportContext,
  ImportError,
  type ImportedAsset,
  type Importer,
  type ImportResult,
  type TextureAsset,
} from '@forgeax/engine-types';

export const VOLUMETRIC_DENSITY_KIND = 'texture';

export interface VolumetricDensitySource {
  readonly format: 'forgeax-volumetric-density';
  readonly width: 64 | 128;
  readonly height: 64 | 128;
  readonly depth: 64 | 128;
  readonly base?: number;
  readonly gradient?: number;
  readonly noise?: 'improved-perlin';
  readonly scale?: number;
  readonly repeatFactor?: number;
}

const SOURCE_RANGE = { start: 0, end: 0, line: 1, column: 1 } as const;

function sourceValidationError(
  ctx: ImportContext,
  code: string,
  rule: string,
  expected: string,
  actual: string,
  hint: string,
): ImportError {
  return new ImportError({
    code: 'source-validation-failed',
    expected,
    actual,
    hint: IMPORT_ERROR_HINTS['source-validation-failed'],
    detail: {
      diagnostics: [
        {
          code,
          severity: 'error',
          sourcePath: ctx.source,
          sourceRange: SOURCE_RANGE,
          rule,
          expected,
          actual,
          hint,
        },
      ],
    },
  });
}

function sourceReadError(ctx: ImportContext, error: unknown): ImportError {
  return new ImportError({
    code: 'source-read-failed',
    expected: `readable source file at meta.source "${ctx.source}"`,
    hint: IMPORT_ERROR_HINTS['source-read-failed'],
    detail: {
      source: ctx.source,
      reason: error instanceof Error ? error.message : String(error),
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSource(ctx: ImportContext, bytes: Uint8Array): VolumetricDensitySource | ImportError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return sourceValidationError(
      ctx,
      'mvd-json-invalid',
      'mvd-json-parse',
      'valid JSON containing a volumetric density source',
      reason,
      'repair the MVD JSON syntax and retry the same source and Meta',
    );
  }

  if (!isRecord(parsed)) {
    return sourceValidationError(
      ctx,
      'mvd-source-object-required',
      'mvd-source-object',
      'a JSON object containing a volumetric density source',
      typeof parsed,
      'provide the MVD descriptor object rather than a JSON primitive or array',
    );
  }

  const format = parsed.format;
  const width = parsed.width;
  const height = parsed.height;
  const depth = parsed.depth;
  if (
    format !== 'forgeax-volumetric-density' ||
    (width !== 64 && width !== 128) ||
    (height !== 64 && height !== 128) ||
    (depth !== 64 && depth !== 128) ||
    width !== height ||
    height !== depth
  ) {
    const actual = `format=${String(format)}, width=${String(width)}, height=${String(height)}, depth=${String(depth)}`;
    return sourceValidationError(
      ctx,
      'mvd-extent-invalid',
      'mvd-extent-cubed',
      'format forgeax-volumetric-density with a 64^3 or 128^3 extent',
      actual,
      'set format to forgeax-volumetric-density and use a 64 or 128 cubic extent',
    );
  }

  if (parsed.noise === 'improved-perlin') {
    const scale = parsed.scale;
    const repeatFactor = parsed.repeatFactor;
    if (
      typeof scale !== 'number' ||
      !Number.isFinite(scale) ||
      typeof repeatFactor !== 'number' ||
      !Number.isFinite(repeatFactor)
    ) {
      const actual = `noise=improved-perlin, scale=${String(scale)}, repeatFactor=${String(repeatFactor)}`;
      return sourceValidationError(
        ctx,
        'mvd-noise-invalid',
        'mvd-improved-perlin-parameters',
        'improved-perlin noise with finite scale and repeatFactor values',
        actual,
        'provide finite numeric ImprovedNoise parameters in the source descriptor',
      );
    }
    return {
      format: 'forgeax-volumetric-density',
      width,
      height,
      depth,
      noise: 'improved-perlin',
      scale,
      repeatFactor,
    };
  }

  const base = parsed.base;
  const gradient = parsed.gradient;
  if (
    typeof base !== 'number' ||
    !Number.isFinite(base) ||
    typeof gradient !== 'number' ||
    !Number.isFinite(gradient)
  ) {
    const actual = `base=${String(base)}, gradient=${String(gradient)}`;
    return sourceValidationError(
      ctx,
      'mvd-optics-invalid',
      'mvd-density-values-finite',
      'finite numeric base and gradient values',
      actual,
      'provide finite numeric density values in the source descriptor',
    );
  }

  return {
    format: 'forgeax-volumetric-density',
    width,
    height,
    depth,
    base,
    gradient,
  };
}

const IMPROVED_NOISE_PERMUTATION = [
  151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142,
  8, 99, 37, 240, 21, 10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203,
  117, 35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165,
  71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230, 220, 105, 92,
  41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208,
  89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217,
  226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58,
  17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155,
  167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218,
  246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249, 14,
  239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150,
  254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180,
];

const IMPROVED_NOISE_TABLE = Uint8Array.from([
  ...IMPROVED_NOISE_PERMUTATION,
  ...IMPROVED_NOISE_PERMUTATION,
]);

function improvedNoiseTableValue(index: number): number {
  return IMPROVED_NOISE_TABLE[index] ?? 0;
}

function improvedNoiseFade(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

function improvedNoiseGradient(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return (h & 1) === 0 ? u + ((h & 2) === 0 ? v : -v) : -u + ((h & 2) === 0 ? v : -v);
}

function improvedNoiseLerp(alpha: number, left: number, right: number): number {
  return left + alpha * (right - left);
}

function improvedNoise(x: number, y: number, z: number): number {
  const floorX = Math.floor(x);
  const floorY = Math.floor(y);
  const floorZ = Math.floor(z);
  const X = floorX & 255;
  const Y = floorY & 255;
  const Z = floorZ & 255;
  x -= floorX;
  y -= floorY;
  z -= floorZ;
  const xMinus1 = x - 1;
  const yMinus1 = y - 1;
  const zMinus1 = z - 1;
  const u = improvedNoiseFade(x);
  const v = improvedNoiseFade(y);
  const w = improvedNoiseFade(z);
  const A = improvedNoiseTableValue(X) + Y;
  const AA = improvedNoiseTableValue(A) + Z;
  const AB = improvedNoiseTableValue(A + 1) + Z;
  const B = improvedNoiseTableValue(X + 1) + Y;
  const BA = improvedNoiseTableValue(B) + Z;
  const BB = improvedNoiseTableValue(B + 1) + Z;
  return improvedNoiseLerp(
    w,
    improvedNoiseLerp(
      v,
      improvedNoiseLerp(
        u,
        improvedNoiseGradient(improvedNoiseTableValue(AA), x, y, z),
        improvedNoiseGradient(improvedNoiseTableValue(BA), xMinus1, y, z),
      ),
      improvedNoiseLerp(
        u,
        improvedNoiseGradient(improvedNoiseTableValue(AB), x, yMinus1, z),
        improvedNoiseGradient(improvedNoiseTableValue(BB), xMinus1, yMinus1, z),
      ),
    ),
    improvedNoiseLerp(
      v,
      improvedNoiseLerp(
        u,
        improvedNoiseGradient(improvedNoiseTableValue(AA + 1), x, y, zMinus1),
        improvedNoiseGradient(improvedNoiseTableValue(BA + 1), xMinus1, y, zMinus1),
      ),
      improvedNoiseLerp(
        u,
        improvedNoiseGradient(improvedNoiseTableValue(AB + 1), x, yMinus1, zMinus1),
        improvedNoiseGradient(improvedNoiseTableValue(BB + 1), xMinus1, yMinus1, zMinus1),
      ),
    ),
  );
}

export function makeVolumetricDensity(source: VolumetricDensitySource): Uint8Array {
  const data = new Uint8Array(source.width * source.height * source.depth);
  if (source.noise === 'improved-perlin') {
    const scale = source.scale ?? 10;
    const repeatFactor = source.repeatFactor ?? 5;
    let index = 0;
    for (let z = 0; z < source.depth; z += 1) {
      for (let y = 0; y < source.height; y += 1) {
        for (let x = 0; x < source.width; x += 1) {
          const nx = (x / source.width) * repeatFactor;
          const ny = (y / source.height) * repeatFactor;
          const nz = (z / source.depth) * repeatFactor;
          data[index] = 128 + 128 * improvedNoise(nx * scale, ny * scale, nz * scale);
          index += 1;
        }
      }
    }
    return data;
  }
  const base = source.base ?? 0;
  const gradient = source.gradient ?? 0;
  if (gradient === 0) {
    data.fill(Math.round(base));
    return data;
  }
  for (let z = 0; z < source.depth; z += 1) {
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const index = z * source.width * source.height + y * source.width + x;
        const normalizedX = (x + 0.5) / source.width;
        const normalizedY = (y + 0.5) / source.height;
        const normalizedZ = (z + 0.5) / source.depth;
        // Three authored spatial scales keep the payload deterministic while
        // avoiding a baked screen-space cone: broad chamber haze, a medium
        // architectural rhythm, and a fine grain for filtered reconstruction.
        const broad =
          0.5 +
          0.5 *
            Math.sin(normalizedX * Math.PI * 2.0) *
            Math.sin(normalizedY * Math.PI * 1.5) *
            Math.sin(normalizedZ * Math.PI * 2.0);
        const medium =
          0.5 +
          0.5 *
            Math.sin(normalizedX * Math.PI * 6.0 + 0.4) *
            Math.sin(normalizedY * Math.PI * 5.0) *
            Math.sin(normalizedZ * Math.PI * 4.0 + 0.7);
        const fine =
          0.5 +
          0.5 *
            Math.sin(normalizedX * Math.PI * 14.0) *
            Math.sin(normalizedY * Math.PI * 11.0 + 0.3) *
            Math.sin(normalizedZ * Math.PI * 13.0);
        const threeScale = broad * 0.55 + medium * 0.3 + fine * 0.15;
        const heightBias = 0.7 + 0.3 * normalizedY;
        data[index] = Math.round((base + gradient * threeScale) * heightBias);
      }
    }
  }
  return data;
}

export function volumetricDensityImporter(): Importer {
  return {
    key: 'volumetric-density',
    async import(ctx: ImportContext): Promise<ImportResult> {
      const source = await ctx.readSource();
      if (!source.ok) return { ok: false, error: sourceReadError(ctx, source.error) };
      const parsed = parseSource(ctx, source.value);
      if (parsed instanceof ImportError) return { ok: false, error: parsed };
      const subAsset = ctx.subAssets[0];
      if (subAsset === undefined) {
        return {
          ok: false,
          error: new ImportError({
            code: 'import-produced-no-assets',
            expected: 'the MVD Meta to declare at least one output sub-asset',
            hint: IMPORT_ERROR_HINTS['import-produced-no-assets'],
            detail: { missingGuids: [] },
          }),
        };
      }
      const data = makeVolumetricDensity(parsed);
      const payload: TextureAsset = {
        kind: 'texture',
        shape: {
          viewDimension: '3d',
          extent: { width: parsed.width, height: parsed.height, depth: parsed.depth },
        },
        format: 'r8unorm',
        colorSpace: 'linear',
        mips: { kind: 'none' },
        data,
      };
      const asset: ImportedAsset = {
        guid: subAsset.guid,
        kind: VOLUMETRIC_DENSITY_KIND,
        name: subAsset.kind,
        payload,
        refs: [],
        artifacts: {
          body: {
            mediaType: 'application/x-forgeax-r8',
            assetCodec: { name: 'r8unorm', version: '1' },
            bytes: data,
          },
        },
      };
      return { ok: true, value: { assets: [asset], sourceDependencies: [ctx.source] } };
    },
  };
}
