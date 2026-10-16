import {
  defineTool,
  type SnapshotRef,
  type ToolContribution,
  type ToolPreviewContract,
  type ToolSchema,
  type ToolSubjectRef,
} from '@forgeax/engine-tool-runtime';
import { executeMeshPreview } from './domains/mesh.js';
import { nativePreviewPlugin, subjectDescriptor } from './domains/subject.js';
import { previewHostCapability } from './host/preview-host.js';
import {
  domainFailure,
  type PreviewDomainResult,
  type PreviewDomainRunner,
  previewRuntimeUnavailable,
  validateDomainValue,
} from './host.js';

export interface MeshSubmeshBinding {
  readonly id: string;
  readonly vertexCount: number;
  readonly indexCount: number;
}

export interface MeshAabb {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface MeshBinding {
  readonly guid: string;
  readonly vertexDigest: string;
  readonly indexDigest: string;
  readonly submeshes: readonly MeshSubmeshBinding[];
  readonly aabb: MeshAabb;
}

export interface MeshPreviewRequest {
  readonly subject: ToolSubjectRef;
  readonly snapshot: SnapshotRef;
  readonly binding: MeshBinding;
}

export interface MeshPreviewReport {
  readonly kind: 'mesh';
  readonly bindingGuid: string;
  readonly submeshCount: number;
  readonly expectedSubmeshCount: number;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly framing: 'aabb' | 'inverted-aabb';
}

const meshPreviewArgsSchema: ToolSchema<MeshPreviewRequest> = {
  parse(value) {
    if (value === null || typeof value !== 'object')
      return { ok: false, error: 'expected a mesh preview request object' };
    const request = value as Partial<MeshPreviewRequest>;
    const binding = request.binding;
    if (request.subject?.kind !== 'MeshAsset' || typeof request.subject.guid !== 'string')
      return { ok: false, error: 'expected a MeshAsset subject' };
    if (
      request.snapshot === undefined ||
      !Number.isSafeInteger(request.snapshot.revision) ||
      typeof request.snapshot.digest !== 'string'
    )
      return { ok: false, error: 'expected a revisioned snapshot' };
    if (
      binding === undefined ||
      binding.guid !== request.subject.guid ||
      binding.vertexDigest.length === 0 ||
      binding.indexDigest.length === 0 ||
      binding.submeshes.length === 0 ||
      binding.submeshes.some(
        (submesh) => submesh.id.length === 0 || submesh.vertexCount <= 0 || submesh.indexCount <= 0,
      ) ||
      binding.aabb.min.some((value) => !Number.isFinite(value)) ||
      binding.aabb.max.some((value) => !Number.isFinite(value)) ||
      binding.aabb.min.some((value, index) => value >= (binding.aabb.max[index] ?? Number.NaN))
    )
      return { ok: false, error: 'expected complete mesh buffers and a valid AABB' };
    return { ok: true, value: request as MeshPreviewRequest };
  },
  describe:
    '{"type":"object","required":["subject","snapshot","binding"],"properties":{"subject":{"type":"object","required":["kind","guid"],"properties":{"kind":{"const":"MeshAsset"},"guid":{"type":"string"}}},"snapshot":{"type":"object","required":["revision","digest"]},"binding":{"type":"object","required":["guid","vertexDigest","indexDigest","submeshes","aabb"]}}}',
};

const meshPreviewResultSchema: ToolSchema<unknown> = {
  parse: (value) => ({ ok: true, value }),
  describe: '{"type":"object","required":["subject","snapshot","report","artifacts"]}',
};

export const meshPreviewDescriptor = {
  id: 'asset.mesh.preview',
  title: 'Preview mesh asset',
  summary: 'Draws every bound mesh submesh with neutral material and AABB framing.',
  realm: 'engine' as const,
  argsSchema: meshPreviewArgsSchema,
  resultSchema: meshPreviewResultSchema,
  evidence: ['rhi-tape', 'png', 'profile-capture'] as const,
  preview: {
    realm: 'engine' as const,
    subject: { kind: 'MeshAsset', guid: '<request>' },
    snapshot: { revision: 0, digest: '<request>' },
    requiredEvidence: ['rhi-tape', 'png', 'profile-capture'] as const,
  } satisfies ToolPreviewContract,
};

function defaultMeshRunner(
  request: MeshPreviewRequest,
): Promise<PreviewDomainResult<MeshPreviewReport>> {
  return Promise.resolve(previewRuntimeUnavailable(request.subject, request.snapshot, 'mesh'));
}

export function createMeshPreviewContribution(
  runner: PreviewDomainRunner<MeshPreviewRequest, MeshPreviewReport> = async (request) =>
    defaultMeshRunner(request),
): ToolContribution<MeshPreviewRequest, unknown> {
  return defineTool(meshPreviewDescriptor, async (request, context) => {
    const result = await runner(request, context);
    if (!result.ok) return result;
    const report = result.value.report;
    if (
      report.bindingGuid !== request.subject.guid ||
      report.submeshCount !== report.expectedSubmeshCount ||
      report.submeshCount !== request.binding.submeshes.length ||
      report.vertexCount !==
        request.binding.submeshes.reduce((sum, submesh) => sum + submesh.vertexCount, 0) ||
      report.indexCount !==
        request.binding.submeshes.reduce((sum, submesh) => sum + submesh.indexCount, 0) ||
      report.framing !== 'aabb'
    ) {
      return domainFailure(
        'preview-subject-falsified',
        'all requested submeshes and the source AABB to drive the presentation',
        'Reject partial geometry, fallback meshes, and inverted framing before publishing evidence.',
        {
          requestGuid: request.subject.guid,
          reportBindingGuid: report.bindingGuid,
          expectedSubmeshCount: request.binding.submeshes.length,
          actualSubmeshCount: report.submeshCount,
          framing: report.framing,
        },
      );
    }
    const validated = validateDomainValue(result.value, request);
    if (!validated.ok) return validated;
    return { ok: true, value: validated.value };
  });
}

export const meshPreview = defineTool(subjectDescriptor('mesh'), (args, context) =>
  (async () => {
    const host = context.require(previewHostCapability);
    if (!host.ok) return host;
    return host.value.withSession(async (mechanisms) => executeMeshPreview(args, mechanisms));
  })(),
);
export const meshPreviewPlugin = nativePreviewPlugin('mesh', meshPreview);
export default meshPreviewPlugin;
