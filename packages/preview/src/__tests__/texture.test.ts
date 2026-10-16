import { describe, expect, it } from 'vitest';
import { inspectTextureSubject } from '../domains/texture.js';
import {
  createTexturePreviewContribution,
  type TextureBinding,
  type TexturePreviewRequest,
  texturePreviewDescriptor,
} from '../texture.js';

const request: TexturePreviewRequest = {
  subject: { kind: 'TextureAsset', guid: 'texture-001' },
  snapshot: { revision: 2, digest: 'sha256:texture-snapshot' },
  binding: {
    guid: 'texture-001',
    width: 640,
    height: 360,
    format: 'rgba16float',
    colorSpace: 'linear',
    alpha: true,
    mipLevels: 4,
    channels: 4,
  },
};

describe('texture.preview canonical contract', () => {
  it('derives dimensions from the current TextureAsset shape schema', () => {
    const bindingFacts: TextureBinding = {
      guid: 'texture-001',
      width: 4,
      height: 2,
      format: 'rgba8unorm',
      colorSpace: 'srgb',
      alpha: true,
      mipLevels: 1,
      channels: 4,
    };
    expect(
      inspectTextureSubject({
        guid: bindingFacts.guid,
        asset: {
          kind: 'texture',
          shape: { viewDimension: '2d', extent: { width: 4, height: 2 } },
          format: bindingFacts.format,
          data: new Uint8Array(4 * 2 * 4).fill(255),
          colorSpace: bindingFacts.colorSpace,
          mips: { kind: 'none' },
        },
        ownerFacts: {
          subjectDigest: 'sha256:subject',
          boundDigest: 'sha256:bound',
          uvDigest: 'sha256:uv',
          bindingDigest: 'sha256:binding',
          format: bindingFacts.format,
          colorSpace: bindingFacts.colorSpace,
          filter: 'linear',
          mipCount: 1,
          payloadClass: 'color',
        },
      }),
    ).toMatchObject({ ok: true, value: { dimensions: [4, 2], mipCount: 1 } });
  });

  it('derives packed mip count from the TextureAsset payload', () => {
    expect(
      inspectTextureSubject({
        guid: 'texture-001',
        asset: {
          kind: 'texture',
          shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
          format: 'rgba8unorm',
          data: new Uint8Array((16 + 4 + 1) * 4).fill(255),
          colorSpace: 'srgb',
          mips: { kind: 'packed', levelCount: 3 },
        },
        ownerFacts: {
          subjectDigest: 'sha256:subject',
          boundDigest: 'sha256:bound',
          uvDigest: 'sha256:uv',
          bindingDigest: 'sha256:binding',
          format: 'rgba8unorm',
          colorSpace: 'srgb',
          filter: 'linear',
          payloadClass: 'color',
        },
      }),
    ).toMatchObject({ ok: true, value: { dimensions: [4, 4], mipCount: 3 } });
  });

  it('rejects invalid packed mip metadata instead of silently using one level', () => {
    expect(
      inspectTextureSubject({
        guid: 'texture-001',
        asset: {
          kind: 'texture',
          shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
          format: 'rgba8unorm',
          data: new Uint8Array([255, 255, 255, 255]),
          colorSpace: 'srgb',
          mips: { kind: 'packed', levelCount: 0 },
        },
        ownerFacts: {
          subjectDigest: 'sha256:subject',
          boundDigest: 'sha256:bound',
          uvDigest: 'sha256:uv',
          bindingDigest: 'sha256:binding',
          format: 'rgba8unorm',
          colorSpace: 'srgb',
          filter: 'linear',
          payloadClass: 'color',
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'resource-preview-subject-invalid' } });
  });

  it('does not treat the second channel of rg8 as alpha', () => {
    expect(
      inspectTextureSubject({
        guid: 'texture-001',
        asset: {
          kind: 'texture',
          shape: { viewDimension: '2d', extent: { width: 2, height: 1 } },
          format: 'rg8unorm',
          data: new Uint8Array([255, 0, 255, 0]),
          colorSpace: 'linear',
          mips: { kind: 'none' },
        },
        ownerFacts: {
          subjectDigest: 'sha256:subject',
          boundDigest: 'sha256:bound',
          uvDigest: 'sha256:uv',
          bindingDigest: 'sha256:binding',
          format: 'rg8unorm',
          colorSpace: 'linear',
          filter: 'linear',
          mipCount: 1,
        },
      }),
    ).toMatchObject({ ok: true, value: { payloadClass: 'color' } });
  });

  it('publishes a dedicated descriptor for inspector evidence', () => {
    expect(texturePreviewDescriptor.id).toBe('asset.texture.preview');
    expect(texturePreviewDescriptor.realm).toBe('engine');
    expect(texturePreviewDescriptor.evidence).toEqual(['rhi-tape', 'png', 'profile-capture']);
  });

  it('requires dimensions, format, color space, and the requested texture GUID', () => {
    expect(
      texturePreviewDescriptor.argsSchema.parse({
        ...request,
        binding: { ...request.binding, guid: 'other' },
      }),
    ).toMatchObject({ ok: false });
    expect(
      texturePreviewDescriptor.argsSchema.parse({
        ...request,
        binding: { ...request.binding, width: 0 },
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects texture replacement and aspect-ratio/checker falsification', async () => {
    const contribution = createTexturePreviewContribution(async () => ({
      ok: true,
      value: {
        subject: request.subject,
        snapshot: request.snapshot,
        report: {
          kind: 'texture',
          bindingGuid: request.subject.guid,
          width: 1,
          height: 1,
          format: 'rgba8unorm',
          colorSpace: 'srgb',
          alpha: false,
          mipLevels: 1,
          channels: 4,
          aspectRatio: 1,
          checkerPixels: 0,
          subjectNonBlackPixels: 0,
        },
        artifacts: [],
      },
    }));
    await expect(contribution.execute(request, {} as never)).resolves.toMatchObject({
      ok: false,
      error: { code: 'preview-subject-falsified' },
    });
  });
});
