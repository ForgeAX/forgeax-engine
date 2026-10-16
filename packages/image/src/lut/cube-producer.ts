import type {
  ImportContext,
  ImportedAsset,
  ImportResult,
  TextureAsset,
} from '@forgeax/engine-types';
import { IMPORT_ERROR_HINTS, ImportError } from '@forgeax/engine-types';
import type { CubeParserError } from '../errors.js';
import { cubeLutBytes, parseCubeLut } from './cube-parser.js';

export interface CubeTextureProducerInput {
  readonly source: string;
  readonly sourceKey: string;
  readonly guid: string;
}

export type CubeTextureProducerResult =
  | { readonly ok: true; readonly value: ImportedAsset<TextureAsset> }
  | { readonly ok: false; readonly error: CubeParserError };

export function produceCubeTexture(
  input: CubeTextureProducerInput,
  source: string,
): CubeTextureProducerResult {
  const parsed = parseCubeLut(source, input.sourceKey);
  if (!parsed.ok) return parsed;
  const bytes = cubeLutBytes(parsed.value);
  return {
    ok: true,
    value: {
      guid: input.guid,
      kind: 'texture',
      payload: {
        kind: 'texture',
        shape: {
          viewDimension: '3d',
          extent: { width: parsed.value.size, height: parsed.value.size, depth: parsed.value.size },
        },
        format: 'rgba16float',
        data: bytes,
        colorSpace: 'linear',
        mips: { kind: 'none' },
      },
      refs: [],
      artifacts: {
        body: {
          mediaType: 'application/x-forgeax-rgba16float',
          assetCodec: { name: 'rgba16float', version: '1' },
          bytes,
        },
      },
    },
  };
}

export async function importCubeSource(ctx: ImportContext): Promise<ImportResult> {
  const subAsset = ctx.subAssets.length === 1 ? ctx.subAssets[0] : undefined;
  if (subAsset === undefined || subAsset.kind !== 'texture' || subAsset.sourceIndex !== 0) {
    return {
      ok: false,
      error: new ImportError({
        code: 'source-validation-failed',
        expected: 'one texture subAsset at sourceIndex 0',
        actual: JSON.stringify(ctx.subAssets),
        hint: IMPORT_ERROR_HINTS['source-validation-failed'],
        detail: {
          diagnostics: [
            {
              code: 'cube-subasset-topology',
              severity: 'error',
              sourcePath: `${ctx.source}#subAssets`,
              sourceRange: { start: 0, end: 0, line: 1, column: 1 },
              rule: 'cube-required-single-texture',
              expected: 'one texture subAsset at sourceIndex 0',
              actual: JSON.stringify(ctx.subAssets),
              hint: 'declare one ordinary texture subAsset and retry the same sourceKey',
            },
          ],
        },
      }),
    };
  }
  const source = await ctx.readSource();
  if (!source.ok) {
    return {
      ok: false,
      error: new ImportError({
        code: 'source-read-failed',
        expected: `readable .cube source at "${ctx.source}"`,
        actual: String(source.error),
        hint: IMPORT_ERROR_HINTS['source-read-failed'],
        detail: { source: ctx.source, reason: String(source.error) },
      }),
    };
  }
  const produced = produceCubeTexture(
    {
      source: ctx.source,
      sourceKey: subAsset.sourceKey ?? `${ctx.source}:texture`,
      guid: subAsset.guid,
    },
    new TextDecoder().decode(source.value),
  );
  if (!produced.ok) {
    return {
      ok: false,
      error: new ImportError({
        code: 'source-validation-failed',
        expected: produced.error.expected,
        actual: JSON.stringify(produced.error.detail),
        hint: produced.error.hint,
        detail: {
          diagnostics: [
            {
              code: produced.error.code,
              severity: 'error',
              sourcePath: `${ctx.source}#${produced.error.detail.field}`,
              sourceRange: {
                start: 0,
                end: 0,
                line: produced.error.detail.line ?? 1,
                column: 1,
              },
              rule: 'cube-source-parser',
              expected: produced.error.expected,
              actual: JSON.stringify(produced.error.detail.actual),
              hint: produced.error.hint,
            },
          ],
        },
      }),
    };
  }
  return { ok: true, value: { assets: [produced.value], sourceDependencies: [ctx.source] } };
}
