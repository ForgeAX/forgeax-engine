import { evaluateMeshOracle, type MeshOracleInput } from '../evidence/oracle.js';
import { canonicalPresentation, createCanonicalPreviewRecipe } from '../kit/canonical.js';
import {
  loadResourceSubject,
  type ResourcePreviewArgs,
  type ResourcePreviewInput,
  subjectFailure,
} from './subject.js';

export interface MeshSubjectInspection {
  readonly subjectDigest: string;
  readonly vertexDigest: string;
  readonly indexDigest: string;
  readonly submeshDigest: string;
  readonly aabbDigest: string;
  readonly aabb: readonly [number, number, number, number, number, number];
  readonly submeshCount: number;
  readonly materialSlotCount: number;
}

type InspectionResult =
  | { readonly ok: true; readonly value: MeshSubjectInspection }
  | ReturnType<typeof subjectFailure>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function digest(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function observedAabb(
  observation: Readonly<Record<string, string | number | boolean | readonly number[]>>,
): readonly [number, number, number, number, number, number] | undefined {
  const value = observation.aabb;
  if (
    !Array.isArray(value) ||
    value.length !== 6 ||
    value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))
  )
    return undefined;
  const [minX, minY, minZ, maxX, maxY, maxZ] = value;
  if (minX > maxX || minY > maxY || minZ > maxZ) return undefined;
  return [minX, minY, minZ, maxX, maxY, maxZ];
}

export function inspectMeshSubject(input: {
  readonly guid: string;
  readonly asset: unknown;
  readonly digest?: string;
  readonly ownerFacts?: Readonly<Record<string, string | number | boolean>>;
}): InspectionResult {
  if (!isRecord(input.asset) || input.asset.kind !== 'mesh') {
    return subjectFailure('resource-preview-kind-mismatch', 'a MeshAsset with kind mesh', {
      phase: 'subject',
      guid: input.guid,
      actualKind:
        isRecord(input.asset) && typeof input.asset.kind === 'string'
          ? input.asset.kind
          : 'unknown',
    });
  }
  const aabbValue = input.asset.aabb;
  const aabb =
    aabbValue instanceof Float32Array ? [...aabbValue] : Array.isArray(aabbValue) ? aabbValue : [];
  if (
    aabb.length !== 6 ||
    aabb.some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    return subjectFailure('resource-preview-subject-invalid', 'a finite six-value MeshAsset AABB', {
      phase: 'subject',
      guid: input.guid,
      field: 'aabb',
    });
  }
  const [minX, minY, minZ, maxX, maxY, maxZ] = aabb;
  if (minX > maxX || minY > maxY || minZ > maxZ) {
    return subjectFailure('resource-preview-subject-invalid', 'a non-empty MeshAsset AABB', {
      phase: 'subject',
      guid: input.guid,
      field: 'aabb',
    });
  }
  const slots = input.asset.materialSlots;
  const submeshes = input.asset.submeshes;
  if (!Array.isArray(slots) || slots.length === 0) {
    return subjectFailure(
      'resource-preview-subject-invalid',
      'every mesh submesh to have a material slot',
      {
        phase: 'subject',
        guid: input.guid,
        field: 'materialSlots',
      },
    );
  }
  if (!Array.isArray(submeshes) || submeshes.length === 0) {
    return subjectFailure(
      'resource-preview-subject-invalid',
      'every MeshAsset to declare at least one submesh',
      {
        phase: 'subject',
        guid: input.guid,
        field: 'submeshes',
      },
    );
  }
  for (const submesh of submeshes) {
    if (!isRecord(submesh)) {
      return subjectFailure(
        'resource-preview-subject-invalid',
        'each mesh submesh to be structured',
        {
          phase: 'subject',
          guid: input.guid,
          field: 'submeshes',
        },
      );
    }
    const materialSlot = submesh.materialSlot;
    const indexOffset = submesh.indexOffset;
    const indexCount = submesh.indexCount;
    if (
      typeof materialSlot !== 'number' ||
      materialSlot < 0 ||
      materialSlot >= slots.length ||
      typeof indexOffset !== 'number' ||
      typeof indexCount !== 'number' ||
      indexOffset < 0 ||
      indexCount <= 0
    ) {
      return subjectFailure(
        'resource-preview-subject-invalid',
        'every submesh range and material slot to be valid',
        {
          phase: 'subject',
          guid: input.guid,
          field: 'submeshes',
        },
      );
    }
  }
  const owner = input.asset.ownerFacts;
  const ownerFacts = isRecord(owner) ? owner : input.ownerFacts;
  const subjectDigest = digest(input.asset.digest ?? input.digest ?? ownerFacts?.subjectDigest);
  const vertexDigest = digest(input.asset.vertexDigest ?? ownerFacts?.vertexDigest);
  const indexDigest = digest(input.asset.indexDigest ?? ownerFacts?.indexDigest);
  const submeshDigest = digest(input.asset.submeshDigest ?? ownerFacts?.submeshDigest);
  const aabbDigest = digest(input.asset.aabbDigest ?? ownerFacts?.aabbDigest);
  if (
    subjectDigest === undefined ||
    vertexDigest === undefined ||
    indexDigest === undefined ||
    submeshDigest === undefined ||
    aabbDigest === undefined
  ) {
    return subjectFailure(
      'resource-preview-subject-invalid',
      'the MeshAsset owner to publish vertex, index, submesh, AABB, and subject digests',
      { phase: 'subject', guid: input.guid, field: 'ownerFacts' },
    );
  }
  return {
    ok: true,
    value: {
      subjectDigest,
      vertexDigest,
      indexDigest,
      submeshDigest,
      aabbDigest,
      aabb: [minX, minY, minZ, maxX, maxY, maxZ],
      submeshCount: submeshes.length,
      materialSlotCount: slots.length,
    },
  };
}

export async function executeMeshPreview(args: ResourcePreviewArgs, input: ResourcePreviewInput) {
  const loaded = await loadResourceSubject(args.guid, input, 'mesh');
  if (!loaded.ok) return loaded;
  const inspected = inspectMeshSubject(loaded.value);
  if (!inspected.ok) return inspected;
  const renderer = input.renderer;
  if (
    renderer?.rendererReady !== true ||
    renderer.worldReady !== true ||
    renderer.drawCalls <= 0 ||
    renderer.nonBlackPixels <= 0 ||
    renderer.observation === undefined
  )
    return subjectFailure(
      'resource-preview-oracle-failed',
      'shared World and Renderer to be ready',
      { phase: 'renderer', runId: input.runId },
    );
  const aabb = observedAabb(renderer.observation);
  const submeshCount = renderer.observation.submeshCount;
  const materialSlotCount = renderer.observation.materialSlotCount;
  if (
    aabb === undefined ||
    typeof submeshCount !== 'number' ||
    typeof materialSlotCount !== 'number'
  ) {
    return subjectFailure(
      'resource-preview-oracle-failed',
      'the rendered mesh observation to include AABB and material-slot facts',
      { phase: 'renderer-observation', runId: input.runId },
    );
  }
  const observed: MeshOracleInput['observed'] = {
    ...inspected.value,
    subjectDigest: digest(renderer.observation.subjectDigest) ?? '',
    vertexDigest: digest(renderer.observation.vertexDigest) ?? '',
    indexDigest: digest(renderer.observation.indexDigest) ?? '',
    submeshDigest: digest(renderer.observation.submeshDigest) ?? '',
    aabbDigest: digest(renderer.observation.aabbDigest) ?? '',
    aabb,
    submeshCount,
    materialSlotCount,
    rendererHealthy: renderer.rendererReady && renderer.worldReady,
    drawCalls: renderer.drawCalls,
    nonBlackPixels: renderer.nonBlackPixels,
  };
  const oracle = evaluateMeshOracle({ requested: inspected.value, observed });
  if (oracle.status !== 'passed') {
    return subjectFailure(
      'resource-preview-oracle-failed',
      'the rendered mesh observation to match the loaded owner facts',
      { phase: 'oracle', runId: input.runId, ...oracle.detail },
    );
  }
  return {
    ok: true as const,
    value: {
      subject: { kind: 'mesh' as const, guid: args.guid, digest: inspected.value.subjectDigest },
      presentation: canonicalPresentation('mesh'),
      recipe: createCanonicalPreviewRecipe('mesh'),
      oracle,
      artifacts: input.artifacts ?? [],
    },
    artifacts: input.artifacts ?? [],
  };
}
