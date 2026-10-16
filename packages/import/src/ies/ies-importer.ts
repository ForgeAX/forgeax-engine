import type {
  IesProfileAsset,
  ImportContext,
  Importer,
  ImportResult,
  Result,
} from '@forgeax/engine-types';
import {
  err,
  IES_PROFILE_BYTE_LENGTH,
  IES_PROFILE_HEIGHT,
  IES_PROFILE_WIDTH,
  IMPORT_ERROR_HINTS,
  ImportError,
  ok,
} from '@forgeax/engine-types';
import { parseLm63TypeC } from './parse-lm63.js';
import { resampleTypeC } from './resample-type-c.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeFloat16(bytes: Uint8Array, offset: number): number {
  const bits = (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 2 ** 10);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 2 ** 10);
}

export function validateIesProfilePayload(value: unknown): Result<IesProfileAsset, Error> {
  if (!isRecord(value) || value.kind !== 'ies-profile') {
    return err(new Error('IES payload kind must be ies-profile'));
  }
  const data = value.data;
  if (!(data instanceof Uint8Array) || data.byteLength !== IES_PROFILE_BYTE_LENGTH) {
    return err(
      new Error(
        `IES payload must contain ${IES_PROFILE_WIDTH}x${IES_PROFILE_HEIGHT} little-endian f16 samples`,
      ),
    );
  }
  for (let offset = 0; offset < data.byteLength; offset += 2) {
    if (!Number.isFinite(decodeFloat16(data, offset))) {
      return err(new Error('IES payload contains a non-finite f16 sample'));
    }
  }
  return ok(value as unknown as IesProfileAsset);
}

function sourceValidationError(ctx: ImportContext, reason: string): ImportError {
  return new ImportError({
    code: 'source-validation-failed',
    expected: 'LM-63 Type C source with TILT=NONE',
    hint: IMPORT_ERROR_HINTS['source-validation-failed'],
    detail: {
      diagnostics: [
        {
          code: 'ies-source-invalid',
          severity: 'error',
          sourcePath: ctx.source,
          sourceRange: { start: 0, end: 0, line: 1, column: 1 },
          rule: 'LM-63 Type C TILT=NONE',
          expected: 'LM-63 Type C source with TILT=NONE',
          actual: reason,
          hint: 'repair the IES source and rerun the build-time importer',
        },
      ],
    },
  });
}

async function importIes(ctx: ImportContext): Promise<ImportResult> {
  const source = await ctx.readSource();
  if (!source.ok) {
    return {
      ok: false,
      error: new ImportError({
        code: 'source-read-failed',
        expected: `readable IES source at ${ctx.source}`,
        hint: IMPORT_ERROR_HINTS['source-read-failed'],
        detail: { source: ctx.source, reason: String(source.error) },
      }),
    };
  }
  const parsed = parseLm63TypeC(new TextDecoder().decode(source.value));
  if (!parsed.ok) return { ok: false, error: sourceValidationError(ctx, parsed.error.reason) };
  const declaration = ctx.subAssets.find((asset) => asset.kind === 'ies-profile');
  if (declaration === undefined) {
    return {
      ok: false,
      error: sourceValidationError(ctx, 'missing ies-profile sub-asset declaration'),
    };
  }
  const data = resampleTypeC(parsed.value);
  const payload: IesProfileAsset = { kind: 'ies-profile', data };
  return {
    ok: true,
    value: {
      assets: [
        {
          guid: declaration.guid,
          kind: 'ies-profile',
          payload,
          refs: [],
          artifacts: {
            body: {
              mediaType: 'application/octet-stream',
              assetCodec: { name: 'forgeax-ies-profile', version: '1' },
              bytes: data,
            },
          },
        },
      ],
      sourceDependencies: [ctx.source],
    },
  };
}

export const iesImporter: Importer = {
  key: 'ies',
  import: importIes,
};
