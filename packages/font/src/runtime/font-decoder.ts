import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  type AssetDecoderContribution,
  type AssetKind,
  err,
  type FontAsset,
  ok,
} from '@forgeax/engine-types';

function parseGuid(value: unknown): FontAsset['atlas'] | undefined {
  if (value instanceof Uint8Array && value.length === 16) return value as FontAsset['atlas'];
  if (
    Array.isArray(value) &&
    value.length === 16 &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  ) {
    return Uint8Array.from(value) as FontAsset['atlas'];
  }
  if (typeof value !== 'string') return undefined;
  const parsed = AssetGuid.parse(value);
  return parsed.ok ? parsed.value : undefined;
}

function validCommon(value: unknown): value is FontAsset['common'] {
  if (value === null || typeof value !== 'object') return false;
  const common = value as Record<string, unknown>;
  return ['lineHeight', 'base', 'distanceRange', 'pxRange', 'atlasWidth', 'atlasHeight'].every(
    (key) => typeof common[key] === 'number' && Number.isFinite(common[key]),
  );
}

export const fontContribution: AssetDecoderContribution<FontAsset, 'font'> = {
  kind: { kind: 'font' } as AssetKind<FontAsset, 'font'>,
  consumer: 'GlyphTextLayout',
  decoder: {
    async decode({ envelope }) {
      const payload = envelope.payload as unknown;
      if (payload !== null && typeof payload === 'object') {
        const source = payload as Record<string, unknown>;
        const atlas = parseGuid(source.atlas ?? source.atlasGuid);
        const sampler = parseGuid(source.sampler ?? source.samplerGuid);
        if (
          (source.kind === undefined || source.kind === 'font') &&
          atlas !== undefined &&
          sampler !== undefined &&
          source.glyphs !== null &&
          typeof source.glyphs === 'object' &&
          validCommon(source.common)
        ) {
          return ok({
            kind: 'font',
            atlas,
            sampler,
            glyphs: source.glyphs as FontAsset['glyphs'],
            common: source.common,
            ...(source.notdef === undefined
              ? {}
              : { notdef: source.notdef as NonNullable<FontAsset['notdef']> }),
          });
        }
      }
      return err({
        code: 'asset-package-invalid',
        expected: 'a font payload with atlas and sampler references',
        hint: 'recook the font atlas and publish its local sub-assets',
        detail: { guid: envelope.guid, reason: 'font owner validation failed' },
      });
    },
  },
};
