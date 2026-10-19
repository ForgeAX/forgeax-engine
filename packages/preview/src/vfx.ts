import {
  defineTool,
  type SnapshotRef,
  type ToolContribution,
  type ToolPreviewContract,
  type ToolSchema,
  type ToolSubjectRef,
} from '@forgeax/engine-tool-runtime';
import { nativePreviewPlugin, subjectDescriptor } from './domains/subject.js';
import { executeVfxPreview } from './domains/vfx.js';
import { previewHostCapability } from './host/preview-host.js';
import {
  domainFailure,
  type PreviewDomainResult,
  type PreviewDomainRunner,
  previewRuntimeUnavailable,
  REQUIRED_PREVIEW_EVIDENCE,
  validateDomainValue,
} from './host.js';
import {
  isNonemptyString,
  isRecord,
  isSafeInteger,
  parsePreviewRequest,
} from './request-schema.js';

export interface VfxBinding {
  readonly guid: string;
  readonly effectDigest: string;
}

export interface VfxSimulationInput {
  readonly seed: number;
  readonly deltaSeconds: number;
  readonly frames: number;
}

export interface VfxPreviewRequest {
  readonly subject: ToolSubjectRef;
  readonly snapshot: SnapshotRef;
  readonly binding: VfxBinding;
  readonly simulation: VfxSimulationInput;
}

export interface VfxPreviewReport {
  readonly kind: 'vfx';
  readonly bindingGuid: string;
  readonly seed: number;
  readonly deltaSeconds: number;
  readonly frames: number;
  readonly computeSteps: number;
  readonly drawCalls: number;
  readonly subjectOutputDigest: string;
  readonly deterministicDigest: string;
  readonly captureNonBlackPixels: number;
}

const vfxPreviewArgsSchema: ToolSchema<VfxPreviewRequest> = {
  parse(value) {
    const envelope = parsePreviewRequest(value, 'ParticleEffectAsset');
    if (!envelope.ok) return envelope;
    const request = envelope.value;
    const { binding, simulation } = request;
    if (
      !isNonemptyString(binding.effectDigest) ||
      !isRecord(simulation) ||
      !isSafeInteger(simulation.seed) ||
      typeof simulation.deltaSeconds !== 'number' ||
      simulation.deltaSeconds <= 0 ||
      !Number.isFinite(simulation.deltaSeconds) ||
      !isSafeInteger(simulation.frames) ||
      simulation.frames < 1 ||
      simulation.frames > 240
    )
      return { ok: false, error: 'expected a bound effect and bounded deterministic timeline' };
    return {
      ok: true,
      value: {
        ...request,
        binding: { guid: request.subject.guid, effectDigest: binding.effectDigest },
        simulation: {
          seed: simulation.seed,
          deltaSeconds: simulation.deltaSeconds,
          frames: simulation.frames,
        },
      },
    };
  },
  describe:
    '{"type":"object","required":["subject","snapshot","binding","simulation"],"properties":{"subject":{"type":"object","required":["kind","guid"],"properties":{"kind":{"const":"ParticleEffectAsset"},"guid":{"type":"string"}}},"snapshot":{"type":"object","required":["revision","digest"]},"binding":{"type":"object","required":["guid","effectDigest"]},"simulation":{"type":"object","required":["seed","deltaSeconds","frames"]}}}',
};

const vfxPreviewResultSchema: ToolSchema<unknown> = {
  parse: (value) => ({ ok: true, value }),
  describe: '{"type":"object","required":["subject","snapshot","report","artifacts"]}',
};

export const vfxPreviewDescriptor = {
  id: 'asset.vfx.preview',
  title: 'Preview particle effect asset',
  summary: 'Runs a fixed-seed particle compute/draw timeline and captures its subject output.',
  realm: 'engine' as const,
  argsSchema: vfxPreviewArgsSchema,
  resultSchema: vfxPreviewResultSchema,
  evidence: REQUIRED_PREVIEW_EVIDENCE,
  preview: {
    realm: 'engine' as const,
    subject: { kind: 'ParticleEffectAsset', guid: '<request>' },
    snapshot: { revision: 0, digest: '<request>' },
    requiredEvidence: REQUIRED_PREVIEW_EVIDENCE,
  } satisfies ToolPreviewContract,
};

export function vfxDeterministicDigest(request: VfxPreviewRequest): string {
  return `sha256:vfx:${request.binding.effectDigest}:${request.simulation.seed}:${request.simulation.deltaSeconds}:${request.simulation.frames}`;
}

function defaultVfxRunner(
  request: VfxPreviewRequest,
): Promise<PreviewDomainResult<VfxPreviewReport>> {
  return Promise.resolve(previewRuntimeUnavailable(request.subject, request.snapshot, 'vfx'));
}

export function createVfxPreviewContribution(
  runner: PreviewDomainRunner<VfxPreviewRequest, VfxPreviewReport> = async (request) =>
    defaultVfxRunner(request),
): ToolContribution<VfxPreviewRequest, unknown> {
  return defineTool(vfxPreviewDescriptor, async (request, context) => {
    const result = await runner(request, context);
    if (!result.ok) return result;
    const report = result.value.report;
    const expectedDigest = vfxDeterministicDigest(request);
    if (
      report.bindingGuid !== request.subject.guid ||
      report.seed !== request.simulation.seed ||
      report.deltaSeconds !== request.simulation.deltaSeconds ||
      report.frames !== request.simulation.frames ||
      report.computeSteps !== request.simulation.frames ||
      report.drawCalls !== request.simulation.frames ||
      report.subjectOutputDigest.length === 0 ||
      report.deterministicDigest !== expectedDigest ||
      report.captureNonBlackPixels <= 0
    ) {
      return domainFailure(
        'preview-subject-falsified',
        'the effect binding, fixed simulation input, compute/draw steps, and subject output to agree',
        'Reject stale seed/delta reports and captures without a subject output.',
        {
          requestGuid: request.subject.guid,
          reportBindingGuid: report.bindingGuid,
          expectedDigest,
          actualDigest: report.deterministicDigest,
          computeSteps: report.computeSteps,
          drawCalls: report.drawCalls,
        },
      );
    }
    const validated = validateDomainValue(result.value, request);
    if (!validated.ok) return validated;
    return { ok: true, value: validated.value };
  });
}

export const vfxPreview = defineTool(subjectDescriptor('vfx'), (args, context) =>
  (async () => {
    const host = context.require(previewHostCapability);
    if (!host.ok) return host;
    return host.value.withSession(async (mechanisms) => executeVfxPreview(args, mechanisms));
  })(),
);
export const vfxPreviewPlugin = nativePreviewPlugin('vfx', vfxPreview);
export default vfxPreviewPlugin;
