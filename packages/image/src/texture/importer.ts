import type {
  ImportContext,
  ImportedAsset,
  TextureAsset,
  TextureError,
} from '@forgeax/engine-types';
import { deriveTextureLayout, err, ImportError, ok, type Result } from '@forgeax/engine-types';
import {
  parseTextureSourceDescriptor,
  type TextureSourceDescriptor,
  type TextureSourceDescriptorError,
} from './source-descriptor.js';

export interface TextureSourceInput {
  readonly descriptor: unknown;
  readonly guid: string;
  readonly sourceKey: string;
  readSibling(
    uri: string,
  ): Promise<
    | { readonly ok: true; readonly value: Uint8Array }
    | { readonly ok: false; readonly error: unknown }
  >;
}

export interface TextureSourceReadError {
  readonly code: 'source-read-failed';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly sourceKey: string;
    readonly sibling: string;
    readonly reason: string;
  };
}

export type TextureSourceError =
  | TextureSourceDescriptorError
  | TextureSourceReadError
  | TextureError;

export type TextureSourceResult = Result<ImportedAsset<TextureAsset>, TextureSourceError>;

function sourceReadError(input: TextureSourceInput, reason: unknown): TextureSourceReadError {
  return {
    code: 'source-read-failed',
    expected: `readable raw sibling "${input.descriptor && typeof input.descriptor === 'object' && 'rawSibling' in input.descriptor ? input.descriptor.rawSibling : 'rawSibling'}"`,
    hint: 'repair the raw sibling path or bytes and re-import the same texture GUID',
    detail: {
      sourceKey: input.sourceKey,
      sibling:
        input.descriptor && typeof input.descriptor === 'object' && 'rawSibling' in input.descriptor
          ? String(input.descriptor.rawSibling)
          : 'rawSibling',
      reason: reason instanceof Error ? reason.message : String(reason),
    },
  };
}

function bodyMediaType(format: GPUTextureFormat): string {
  return format === 'r8unorm' ? 'application/x-forgeax-r8' : `application/x-forgeax-${format}`;
}

/** Produce one canonical TextureAsset and body artifact from a descriptor sibling. */
export async function produceTextureSource(
  input: TextureSourceInput,
): Promise<TextureSourceResult> {
  const descriptorResult = parseTextureSourceDescriptor(input.descriptor);
  if (!descriptorResult.ok) return descriptorResult;
  const descriptor = descriptorResult.value;
  const sibling = await input.readSibling(descriptor.rawSibling);
  if (!sibling.ok) return err(sourceReadError(input, sibling.error));

  const layout = deriveTextureLayout({
    shape: descriptor.shape,
    format: descriptor.format,
    mips: descriptor.mips,
    actualByteLength: sibling.value.byteLength,
    order: 'mip-major,image-major,row-major',
  });
  if (!layout.ok) return layout;

  const data = new Uint8Array(sibling.value);
  return ok({
    guid: input.guid,
    kind: 'texture',
    payload: {
      kind: 'texture',
      shape: descriptor.shape,
      format: descriptor.format,
      colorSpace: descriptor.colorSpace,
      mips: descriptor.mips,
      data,
    },
    refs: [],
    artifacts: {
      body: {
        mediaType: bodyMediaType(descriptor.format),
        assetCodec: { name: descriptor.format, version: '1' },
        bytes: data,
      },
    },
  });
}

function sourceValidationError(ctx: ImportContext, error: TextureSourceError): ImportError {
  const detail = 'detail' in error ? error.detail : { field: 'descriptor', actual: error };
  return new ImportError({
    code: 'source-validation-failed',
    expected: error.expected,
    hint: error.hint,
    detail: {
      diagnostics: [
        {
          code: `texture-source-${error.code}`,
          severity: 'error',
          sourcePath: `${ctx.source}#${'field' in detail ? detail.field : 'rawSibling'}`,
          sourceRange: { start: 0, end: 0, line: 1, column: 1 },
          rule: 'texture-source-descriptor',
          expected: error.expected,
          actual: JSON.stringify(detail),
          hint: error.hint,
        },
      ],
    },
  });
}

/** Import a JSON descriptor whose canonical bytes live in one raw sibling. */
export async function importTextureSource(ctx: ImportContext): Promise<
  | {
      readonly ok: true;
      readonly value: {
        readonly assets: readonly ImportedAsset[];
        readonly sourceDependencies: readonly string[];
      };
    }
  | { readonly ok: false; readonly error: ImportError }
> {
  const source = await ctx.readSource();
  if (!source.ok) {
    const reason = String(source.error);
    return {
      ok: false,
      error: new ImportError({
        code: 'source-read-failed',
        expected: `readable texture descriptor at "${ctx.source}"`,
        hint: 'repair the texture descriptor path and retry the import',
        detail: { source: ctx.source, reason },
      }),
    };
  }

  let descriptor: unknown;
  try {
    descriptor = JSON.parse(new TextDecoder().decode(source.value));
  } catch (error) {
    return {
      ok: false,
      error: sourceValidationError(ctx, {
        code: 'texture-source-descriptor-invalid',
        expected: 'JSON texture source descriptor',
        hint: 'repair the descriptor JSON and retry the import',
        detail: {
          field: 'descriptor',
          actual: error instanceof Error ? error.message : String(error),
        },
      }),
    };
  }
  const subAsset = ctx.subAssets.length === 1 ? ctx.subAssets[0] : undefined;
  if (subAsset === undefined || subAsset.kind !== 'texture' || subAsset.sourceIndex !== 0) {
    return {
      ok: false,
      error: sourceValidationError(ctx, {
        code: 'texture-source-descriptor-invalid',
        expected: 'one texture subAsset at sourceIndex 0',
        hint: 'repair Meta subAssets and retry the same texture GUID',
        detail: { field: 'subAssets', actual: ctx.subAssets },
      }),
    };
  }
  const produced = await produceTextureSource({
    descriptor,
    guid: subAsset.guid,
    sourceKey: subAsset.sourceKey ?? `${ctx.source}:texture`,
    readSibling: ctx.readSibling,
  });
  if (!produced.ok) return { ok: false, error: sourceValidationError(ctx, produced.error) };
  const parsed = parseTextureSourceDescriptor(descriptor);
  const sibling = parsed.ok ? parsed.value.rawSibling : ctx.source;
  return {
    ok: true,
    value: { assets: [produced.value], sourceDependencies: [ctx.source, sibling] },
  };
}

export type { TextureSourceDescriptor };
