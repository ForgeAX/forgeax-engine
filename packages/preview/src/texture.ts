import {
  defineTool,
  type SnapshotRef,
  type ToolContribution,
  type ToolPreviewContract,
  type ToolSchema,
  type ToolSubjectRef,
} from '@forgeax/engine-tool-runtime';
import { nativePreviewPlugin, subjectDescriptor } from './domains/subject.js';
import { executeTexturePreview } from './domains/texture.js';
import { previewHostCapability } from './host/preview-host.js';
import {
  domainFailure,
  type PreviewDomainResult,
  type PreviewDomainRunner,
  previewRuntimeUnavailable,
  REQUIRED_PREVIEW_EVIDENCE,
  validateDomainValue,
} from './host.js';
import { isNonemptyString, isSafeInteger, parsePreviewRequest } from './request-schema.js';

export type TextureColorSpace = 'linear' | 'srgb' | 'hdr';

export interface TextureBinding {
  readonly guid: string;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly colorSpace: TextureColorSpace;
  readonly alpha: boolean;
  readonly mipLevels: number;
  readonly channels: number;
}

export interface TexturePreviewRequest {
  readonly subject: ToolSubjectRef;
  readonly snapshot: SnapshotRef;
  readonly binding: TextureBinding;
}

export interface TexturePreviewReport {
  readonly kind: 'texture';
  readonly bindingGuid: string;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly colorSpace: TextureColorSpace;
  readonly alpha: boolean;
  readonly mipLevels: number;
  readonly channels: number;
  readonly aspectRatio: number;
  readonly checkerPixels: number;
  readonly subjectNonBlackPixels: number;
}

const texturePreviewArgsSchema: ToolSchema<TexturePreviewRequest> = {
  parse(value) {
    const envelope = parsePreviewRequest(value, 'TextureAsset');
    if (!envelope.ok) return envelope;
    const request = envelope.value;
    const binding = request.binding;
    if (
      !isSafeInteger(binding.width) ||
      binding.width < 1 ||
      !isSafeInteger(binding.height) ||
      binding.height < 1 ||
      !isNonemptyString(binding.format) ||
      (binding.colorSpace !== 'linear' &&
        binding.colorSpace !== 'srgb' &&
        binding.colorSpace !== 'hdr') ||
      typeof binding.alpha !== 'boolean' ||
      !isSafeInteger(binding.mipLevels) ||
      binding.mipLevels < 1 ||
      !isSafeInteger(binding.channels) ||
      binding.channels < 1 ||
      binding.channels > 4
    )
      return {
        ok: false,
        error: 'expected complete texture dimensions, format, and color-space facts',
      };
    return {
      ok: true,
      value: {
        ...request,
        binding: {
          guid: request.subject.guid,
          width: binding.width,
          height: binding.height,
          format: binding.format,
          colorSpace: binding.colorSpace,
          alpha: binding.alpha,
          mipLevels: binding.mipLevels,
          channels: binding.channels,
        },
      },
    };
  },
  describe:
    '{"type":"object","required":["subject","snapshot","binding"],"properties":{"subject":{"type":"object","required":["kind","guid"],"properties":{"kind":{"const":"TextureAsset"},"guid":{"type":"string"}}},"snapshot":{"type":"object","required":["revision","digest"]},"binding":{"type":"object","required":["guid","width","height","format","colorSpace","alpha","mipLevels","channels"]}}}',
};

const texturePreviewResultSchema: ToolSchema<unknown> = {
  parse: (value) => ({ ok: true, value }),
  describe: '{"type":"object","required":["subject","snapshot","report","artifacts"]}',
};

export const texturePreviewDescriptor = {
  id: 'asset.texture.preview',
  title: 'Preview texture asset',
  summary: 'Presents one texture on an aspect-correct quad with alpha checker evidence.',
  realm: 'engine' as const,
  argsSchema: texturePreviewArgsSchema,
  resultSchema: texturePreviewResultSchema,
  evidence: REQUIRED_PREVIEW_EVIDENCE,
  preview: {
    realm: 'engine' as const,
    subject: { kind: 'TextureAsset', guid: '<request>' },
    snapshot: { revision: 0, digest: '<request>' },
    requiredEvidence: REQUIRED_PREVIEW_EVIDENCE,
  } satisfies ToolPreviewContract,
};

function defaultTextureRunner(
  request: TexturePreviewRequest,
): Promise<PreviewDomainResult<TexturePreviewReport>> {
  return Promise.resolve(previewRuntimeUnavailable(request.subject, request.snapshot, 'texture'));
}

export function createTexturePreviewContribution(
  runner: PreviewDomainRunner<TexturePreviewRequest, TexturePreviewReport> = async (request) =>
    defaultTextureRunner(request),
): ToolContribution<TexturePreviewRequest, unknown> {
  return defineTool(texturePreviewDescriptor, async (request, context) => {
    const result = await runner(request, context);
    if (!result.ok) return result;
    const report = result.value.report;
    const binding = request.binding;
    if (
      report.bindingGuid !== request.subject.guid ||
      report.width !== binding.width ||
      report.height !== binding.height ||
      report.format !== binding.format ||
      report.colorSpace !== binding.colorSpace ||
      report.alpha !== binding.alpha ||
      report.mipLevels !== binding.mipLevels ||
      report.channels !== binding.channels ||
      report.aspectRatio !== binding.width / binding.height ||
      report.checkerPixels <= 0 ||
      report.subjectNonBlackPixels <= 0
    ) {
      return domainFailure(
        'preview-subject-falsified',
        'the texture binding facts and aspect-correct checker presentation to agree',
        'Reject texture replacement, color-space drift, and background-only captures.',
        {
          requestGuid: request.subject.guid,
          reportBindingGuid: report.bindingGuid,
          expectedFormat: binding.format,
          actualFormat: report.format,
          expectedColorSpace: binding.colorSpace,
          actualColorSpace: report.colorSpace,
          expectedAspectRatio: binding.width / binding.height,
          actualAspectRatio: report.aspectRatio,
        },
      );
    }
    const validated = validateDomainValue(result.value, request);
    if (!validated.ok) return validated;
    return { ok: true, value: validated.value };
  });
}

export const texturePreview = defineTool(subjectDescriptor('texture'), (args, context) => {
  const host = context.require(previewHostCapability);
  if (!host.ok) return host;
  return host.value.withSession(async (mechanisms) =>
    executeTexturePreview(args, {
      ...(mechanisms.subject === undefined ? {} : { subject: mechanisms.subject }),
      ...(mechanisms.renderer === undefined ? {} : { renderer: mechanisms.renderer }),
      runId: mechanisms.runId,
      ...(mechanisms.artifacts === undefined ? {} : { artifacts: mechanisms.artifacts }),
    }),
  );
});
export const texturePreviewPlugin = nativePreviewPlugin('texture', texturePreview);
export default texturePreviewPlugin;
