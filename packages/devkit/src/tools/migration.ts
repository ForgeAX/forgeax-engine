import type { MigrationCapabilityProbe, MigrationOperation } from '@forgeax/engine-tool-runtime';
import {
  type ArtifactRef,
  capabilityUnavailableError,
  createServiceCapability,
  type ServiceCapability,
  type ToolEvidenceKind,
  type ToolRealm,
} from '@forgeax/engine-tool-runtime';

export {
  createCapabilityToken,
  createMigrationRecipe,
  type MigrationCapabilityProbe,
  type MigrationOperation,
  type MigrationRecipe,
  probeMigrationTarget,
} from '@forgeax/engine-tool-runtime';

export type MigrationPath = 'private' | 'service';

export interface MigrationTarget extends MigrationCapabilityProbe {}

export interface MigrationRosterEntry {
  readonly operation: MigrationOperation;
  readonly owner: string;
  readonly realm: ToolRealm;
  readonly artifacts: readonly MigrationEvidence[];
  readonly benefit: string;
  readonly fallback: 'private';
}

export interface MigrationEvidence {
  readonly owner: string;
  readonly source: 'M3';
  readonly ref: ArtifactRef;
}

export interface MigrationResolution {
  readonly path: MigrationPath;
  readonly operation: MigrationOperation;
  readonly owner: string;
  readonly artifacts: readonly MigrationEvidence[];
  readonly service: ServiceCapability;
}

export type MigrationResolutionResult =
  | { readonly ok: true; readonly value: MigrationResolution }
  | { readonly ok: false; readonly error: ReturnType<typeof capabilityUnavailableError> };

const roster: readonly MigrationRosterEntry[] = [
  {
    operation: 'project.preview',
    owner: 'devkit/preview-host',
    realm: 'host',
    artifacts: previewArtifacts(),
    benefit: 'reuse the real WebGPU hidden preview recipe',
    fallback: 'private',
  },
  {
    operation: 'asset.material.preview',
    owner: 'engine-preview/material',
    realm: 'host',
    artifacts: previewArtifacts(),
    benefit: 'preview one material subject through the canonical lit rig',
    fallback: 'private',
  },
  {
    operation: 'asset.mesh.preview',
    owner: 'engine-preview/mesh',
    realm: 'host',
    artifacts: previewArtifacts(),
    benefit: 'preview one mesh subject with every submesh and AABB evidence',
    fallback: 'private',
  },
  {
    operation: 'asset.vfx.preview',
    owner: 'engine-preview/vfx',
    realm: 'host',
    artifacts: previewArtifacts(),
    benefit: 'preview one bounded VFX timeline with compute evidence',
    fallback: 'private',
  },
  {
    operation: 'asset.texture.preview',
    owner: 'engine-preview/texture',
    realm: 'host',
    artifacts: previewArtifacts(),
    benefit: 'preview one texture on the aspect-preserving unlit quad',
    fallback: 'private',
  },
];

function previewArtifacts(): readonly MigrationEvidence[] {
  return [
    {
      owner: 'preview-tool-proof',
      source: 'M3',
      ref: {
        kind: 'rhi-tape',
        digest: 'sha256:e62a302dd29e302e1d0928306fe9c90c47ee336aa2e9e35fdc1d75586ae0018d',
        uri: 'repo:apps/preview/__tests__/tool-proof.recipe.integration.test.ts',
      },
    },
    {
      owner: 'preview-tool-proof',
      source: 'M3',
      ref: {
        kind: 'profile-capture',
        digest: 'sha256:11ec9024e1ea08b38f0901db272847ac402d2dce0c757efe744315608e889c5c',
        uri: 'repo:packages/profiler/src/__tests__/fixtures/profile-capture/model-input.json',
      },
    },
  ];
}

function validEvidence(entry: MigrationRosterEntry): boolean {
  return (
    entry.owner.length > 0 &&
    entry.artifacts.length > 0 &&
    entry.artifacts.every(
      ({ owner, source, ref }) =>
        owner.length > 0 &&
        source === 'M3' &&
        /^sha256:[0-9a-f]{64}$/.test(ref.digest) &&
        typeof ref.uri === 'string' &&
        ref.uri.startsWith('repo:') &&
        isSupportedEvidenceKind(ref.kind),
    )
  );
}

function isSupportedEvidenceKind(kind: ArtifactRef['kind']): kind is ToolEvidenceKind {
  return kind === 'rhi-tape' || kind === 'profile-capture' || kind === 'png';
}

export function createMigrationRoster(): readonly MigrationRosterEntry[] {
  return roster.filter(validEvidence).map((entry) => ({
    ...entry,
    artifacts: entry.artifacts.map((artifact) => ({ ...artifact, ref: { ...artifact.ref } })),
  }));
}

export function resolveMigration(
  entries: readonly MigrationRosterEntry[],
  operation: MigrationOperation,
  target: MigrationTarget,
): MigrationResolutionResult {
  const entry = entries.find((candidate) => candidate.operation === operation);
  if (entry === undefined || !validEvidence(entry)) {
    return {
      ok: false,
      error: capabilityUnavailableError(`migration:${operation}`, target.realm),
    };
  }
  if (entry.realm !== target.realm || target.catalogDigest.length === 0) {
    return { ok: false, error: capabilityUnavailableError(`migration:${operation}`, target.realm) };
  }
  if (entry.realm === 'host' && target.rhiBackend !== 'webgpu') {
    return { ok: false, error: capabilityUnavailableError(`rhi:${operation}`, target.realm) };
  }
  const evidenceKinds = entry.artifacts.map(({ ref }) => ref.kind).filter(isSupportedEvidenceKind);
  if (!evidenceKinds.every((kind) => target.evidence.includes(kind))) {
    return { ok: false, error: capabilityUnavailableError(`evidence:${operation}`, target.realm) };
  }
  const service: ServiceCapability = createServiceCapability(undefined, {
    toolId: operation,
    descriptorDigest: entry.artifacts[0]?.ref.digest ?? '',
    recipeDigest: entry.artifacts[0]?.ref.digest ?? '',
    workloadClass: `migration:${operation}`,
    codeDigest: target.catalogDigest,
    browserVersion: 'unavailable',
    backend: 'webgpu',
  });
  return {
    ok: true,
    value: {
      path: service.available ? 'service' : 'private',
      operation,
      owner: entry.owner,
      artifacts: entry.artifacts.map((artifact) => ({ ...artifact, ref: { ...artifact.ref } })),
      service,
    },
  };
}
