import {
  defineTool,
  type SnapshotRef,
  type ToolContribution,
  type ToolPreviewContract,
  type ToolSchema,
  type ToolSubjectRef,
} from '@forgeax/engine-tool-runtime';
import { executeMaterialPreview } from './domains/material.js';
import { nativePreviewPlugin, subjectDescriptor } from './domains/subject.js';
import { previewHostCapability } from './host/preview-host.js';
import {
  domainFailure,
  type PreviewDomainResult,
  type PreviewDomainRunner,
  previewRuntimeUnavailable,
  REQUIRED_PREVIEW_EVIDENCE,
  validateDomainValue,
} from './host.js';
import { isNonemptyString, isStringArray, parsePreviewRequest } from './request-schema.js';

export interface MaterialBinding {
  readonly guid: string;
  readonly programDigest: string;
  readonly bindings: readonly string[];
}

export interface MaterialPreviewRequest {
  readonly subject: ToolSubjectRef;
  readonly snapshot: SnapshotRef;
  readonly binding: MaterialBinding;
}

export interface MaterialPreviewReport {
  readonly kind: 'material';
  readonly bindingGuid: string;
  readonly programDigest: string;
  readonly backgroundNonBlackPixels: number;
  readonly subjectNonBlackPixels: number;
  readonly presentation: 'sphere-studio';
}

const materialPreviewArgsSchema: ToolSchema<MaterialPreviewRequest> = {
  parse(value) {
    const envelope = parsePreviewRequest(value, 'MaterialAsset');
    if (!envelope.ok) return envelope;
    const request = envelope.value;
    const binding = request.binding;
    if (
      !isNonemptyString(binding.programDigest) ||
      !isStringArray(binding.bindings) ||
      binding.bindings.length === 0
    )
      return { ok: false, error: 'expected a bound MaterialAsset program and bindings' };
    return {
      ok: true,
      value: {
        ...request,
        binding: {
          guid: request.subject.guid,
          programDigest: binding.programDigest,
          bindings: binding.bindings,
        },
      },
    };
  },
  describe:
    '{"type":"object","required":["subject","snapshot","binding"],"properties":{"subject":{"type":"object","required":["kind","guid"],"properties":{"kind":{"const":"MaterialAsset"},"guid":{"type":"string"}}},"snapshot":{"type":"object","required":["revision","digest"]},"binding":{"type":"object","required":["guid","programDigest","bindings"]}}}',
};

const materialPreviewResultSchema: ToolSchema<unknown> = {
  parse: (value) => ({ ok: true, value }),
  describe: '{"type":"object","required":["subject","snapshot","report","artifacts"]}',
};

export const materialPreviewDescriptor = {
  id: 'asset.material.preview',
  title: 'Preview material asset',
  summary: 'Renders one bound MaterialAsset on the fixed studio sphere presentation.',
  realm: 'engine' as const,
  argsSchema: materialPreviewArgsSchema,
  resultSchema: materialPreviewResultSchema,
  evidence: REQUIRED_PREVIEW_EVIDENCE,
  preview: {
    realm: 'engine' as const,
    subject: { kind: 'MaterialAsset', guid: '<request>' },
    snapshot: { revision: 0, digest: '<request>' },
    requiredEvidence: REQUIRED_PREVIEW_EVIDENCE,
  } satisfies ToolPreviewContract,
};

function defaultMaterialRunner(
  request: MaterialPreviewRequest,
): Promise<PreviewDomainResult<MaterialPreviewReport>> {
  return Promise.resolve(previewRuntimeUnavailable(request.subject, request.snapshot, 'material'));
}

export function createMaterialPreviewContribution(
  runner: PreviewDomainRunner<MaterialPreviewRequest, MaterialPreviewReport> = async (request) =>
    defaultMaterialRunner(request),
): ToolContribution<MaterialPreviewRequest, unknown> {
  return defineTool(materialPreviewDescriptor, async (request, context) => {
    const result = await runner(request, context);
    if (!result.ok) return result;
    if (
      result.value.report.bindingGuid !== request.subject.guid ||
      result.value.report.subjectNonBlackPixels <= 0 ||
      result.value.report.backgroundNonBlackPixels <= 0 ||
      result.value.report.presentation !== 'sphere-studio'
    ) {
      return domainFailure(
        'preview-subject-falsified',
        'the requested material subject to render with a non-background studio presentation',
        'Reject fallback geometry, disconnected bindings, and background-only captures.',
        {
          requestGuid: request.subject.guid,
          reportBindingGuid: result.value.report.bindingGuid,
          subjectNonBlackPixels: result.value.report.subjectNonBlackPixels,
          backgroundNonBlackPixels: result.value.report.backgroundNonBlackPixels,
        },
      );
    }
    const validated = validateDomainValue(result.value, request);
    if (!validated.ok) return validated;
    return { ok: true, value: validated.value };
  });
}

export const materialPreview = defineTool(subjectDescriptor('material'), (args, context) =>
  (async () => {
    const host = context.require(previewHostCapability);
    if (!host.ok) return host;
    return host.value.withSession(async (mechanisms) => executeMaterialPreview(args, mechanisms));
  })(),
);
export const materialPreviewPlugin = nativePreviewPlugin('material', materialPreview);
export default materialPreviewPlugin;
