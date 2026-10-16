import { artifactManifestError } from './errors.js';
import type { ArtifactRef, JsonValue, SnapshotRef, ToolEvidenceKind } from './types.js';

export type PreviewArtifactRole =
  | 'report'
  | 'rhi-tape'
  | 'capture'
  | 'fresh-replay'
  | 'profile-capture'
  | 'contact-sheet';

export type PreviewArtifactKind =
  | 'report'
  | 'rhi-tape'
  | 'png'
  | 'profile-capture'
  | 'contact-sheet';

export interface PreviewArtifactIdentity {
  readonly runId: string;
  readonly snapshotDigest: string;
  readonly subjectDigest: string;
  readonly presentationDigest: string;
  readonly captureId: string;
  readonly frameId: number;
}

export interface PreviewArtifactManifestEntry
  extends Pick<ToolArtifactManifestEntry, 'owner' | 'uri' | 'digest' | 'byteLength'> {
  readonly kind: PreviewArtifactKind;
  readonly role: PreviewArtifactRole;
  readonly mediaType: string;
  readonly derivedFrom: readonly string[];
}

export interface PreviewArtifactManifest {
  readonly schemaVersion: '2.0.0';
  readonly identity: PreviewArtifactIdentity;
  readonly artifacts: readonly PreviewArtifactManifestEntry[];
}

export type PreviewArtifactManifestValidation =
  | { readonly ok: true; readonly value: PreviewArtifactManifest }
  | { readonly ok: false; readonly error: ReturnType<typeof artifactManifestError> };

export interface ToolArtifactIdentity {
  readonly runId: string;
  readonly snapshotDigest: string;
  readonly stepId: string;
  readonly frameId: number;
  readonly captureId: string;
}

export interface ToolArtifactManifestEntry {
  readonly owner: string;
  readonly kind: ToolEvidenceKind;
  readonly uri: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly mediaType?: string;
  readonly derivedFrom?: readonly string[];
}

export interface ToolArtifactManifest {
  readonly schemaVersion: '1.0.0';
  readonly identity: ToolArtifactIdentity;
  readonly artifacts: readonly ToolArtifactManifestEntry[];
}

export type ArtifactManifestValidation =
  | { readonly ok: true; readonly value: ToolArtifactManifest }
  | { readonly ok: false; readonly error: ReturnType<typeof artifactManifestError> };

export function createArtifactManifest(manifest: ToolArtifactManifest): ToolArtifactManifest {
  const result = validateArtifactManifest(manifest, []);
  if (!result.ok) throw new TypeError('artifact manifest is invalid');
  return {
    schemaVersion: '1.0.0',
    identity: { ...manifest.identity },
    artifacts: manifest.artifacts.map((artifact) => ({ ...artifact })),
  };
}

export function validateArtifactManifest(
  manifest: ToolArtifactManifest,
  required: readonly ToolEvidenceKind[],
): ArtifactManifestValidation {
  const fail = (reason: string, expected: string): ArtifactManifestValidation => ({
    ok: false,
    error: artifactManifestError(
      expected,
      'regenerate the complete manifest from the owning producers',
      {
        reason,
        ...(typeof manifest?.identity?.runId === 'string'
          ? { runId: manifest.identity.runId }
          : {}),
      },
    ),
  });
  if (manifest?.schemaVersion !== '1.0.0')
    return fail('unsupported schemaVersion', 'schemaVersion === "1.0.0"');
  const identity = manifest.identity;
  if (
    identity === undefined ||
    identity.runId.length === 0 ||
    identity.snapshotDigest.length === 0 ||
    identity.stepId.length === 0 ||
    identity.captureId.length === 0 ||
    !Number.isSafeInteger(identity.frameId) ||
    identity.frameId < 0
  )
    return fail(
      'identity is incomplete',
      'runId/snapshotDigest/stepId/captureId and non-negative frameId',
    );
  const seen = new Set<ToolEvidenceKind>();
  for (const artifact of manifest.artifacts) {
    if (
      artifact.owner.length === 0 ||
      artifact.uri.length === 0 ||
      artifact.digest.length === 0 ||
      !Number.isSafeInteger(artifact.byteLength) ||
      artifact.byteLength < 0
    )
      return fail(
        `invalid ${artifact.kind} artifact entry`,
        'owner/uri/digest and byteLength are complete',
      );
    if (seen.has(artifact.kind))
      return fail(
        `duplicate artifact kind '${artifact.kind}'`,
        'one owner entry per evidence kind',
      );
    seen.add(artifact.kind);
  }
  for (const kind of required)
    if (!seen.has(kind))
      return fail(
        `missing artifact kind '${kind}'`,
        `manifest includes requested '${kind}' evidence`,
      );
  return { ok: true, value: manifest };
}

const PREVIEW_ROLE_KINDS: Readonly<Record<PreviewArtifactRole, PreviewArtifactKind>> = {
  report: 'report',
  'rhi-tape': 'rhi-tape',
  capture: 'png',
  'fresh-replay': 'png',
  'profile-capture': 'profile-capture',
  'contact-sheet': 'contact-sheet',
};

export function createPreviewArtifactManifest(
  manifest: PreviewArtifactManifest,
): PreviewArtifactManifest {
  const result = validatePreviewArtifactManifest(manifest, []);
  if (!result.ok) throw new TypeError('preview artifact manifest is invalid');
  return {
    schemaVersion: '2.0.0',
    identity: { ...manifest.identity },
    artifacts: manifest.artifacts.map((artifact) => ({
      ...artifact,
      derivedFrom: [...artifact.derivedFrom],
    })),
  };
}

export function validatePreviewArtifactManifest(
  manifest: PreviewArtifactManifest,
  requiredRoles: readonly PreviewArtifactRole[],
): PreviewArtifactManifestValidation {
  const fail = (reason: string): PreviewArtifactManifestValidation => ({
    ok: false,
    error: artifactManifestError(
      'schemaVersion 2.0.0 with one complete identity and role per artifact',
      'regenerate the staged report and evidence from one lexical ToolRun',
      {
        reason,
        ...(typeof manifest?.identity?.runId === 'string'
          ? { runId: manifest.identity.runId }
          : {}),
      },
    ),
  });
  if (manifest?.schemaVersion !== '2.0.0') return fail('v1 manifest or unsupported schemaVersion');
  const identity = manifest.identity;
  if (
    identity === undefined ||
    [
      identity.runId,
      identity.snapshotDigest,
      identity.subjectDigest,
      identity.presentationDigest,
      identity.captureId,
    ].some((value) => typeof value !== 'string' || value.length === 0) ||
    !Number.isSafeInteger(identity.frameId) ||
    identity.frameId < 0
  ) {
    return fail('identity is incomplete or stale');
  }
  const seenRoles = new Set<PreviewArtifactRole>();
  const digests = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (seenRoles.has(artifact.role)) return fail(`duplicate role '${artifact.role}'`);
    if (PREVIEW_ROLE_KINDS[artifact.role] !== artifact.kind) {
      return fail(`role '${artifact.role}' does not match kind '${artifact.kind}'`);
    }
    if (
      artifact.owner.length === 0 ||
      artifact.uri.length === 0 ||
      artifact.digest.length === 0 ||
      artifact.mediaType.length === 0 ||
      !Number.isSafeInteger(artifact.byteLength) ||
      artifact.byteLength < 0 ||
      artifact.derivedFrom.some((digest) => digest.length === 0)
    ) {
      return fail(`incomplete '${artifact.role}' artifact`);
    }
    seenRoles.add(artifact.role);
    digests.add(artifact.digest);
  }
  for (const artifact of manifest.artifacts) {
    if (artifact.derivedFrom.some((digest) => !digests.has(digest))) {
      return fail(`'${artifact.role}' derivedFrom references an unpublished artifact`);
    }
  }
  for (const role of requiredRoles) {
    if (!seenRoles.has(role)) return fail(`missing required role '${role}'`);
  }
  return { ok: true, value: manifest };
}

export function isSerializableValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((entry) => isSerializableValue(entry, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(
    ([key, entry]) => typeof key === 'string' && isSerializableValue(entry, seen),
  );
}

export function createArtifactRef(input: {
  readonly kind: ToolEvidenceKind | 'tool-result' | 'receipt';
  readonly digest: string;
  readonly uri?: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
}): ArtifactRef {
  if (input.digest.length === 0) throw new TypeError('ArtifactRef digest must not be empty');
  if (
    input.sizeBytes !== undefined &&
    (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0)
  ) {
    throw new TypeError('ArtifactRef sizeBytes must be a non-negative safe integer');
  }
  return { ...input };
}

export function createSnapshotRef(input: SnapshotRef): SnapshotRef {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new TypeError('SnapshotRef revision must be a non-negative safe integer');
  }
  if (input.digest.length === 0) throw new TypeError('SnapshotRef digest must not be empty');
  return { revision: input.revision, digest: input.digest };
}

export function validateArtifactRefs(value: unknown): value is readonly ArtifactRef[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof Reflect.get(entry, 'kind') === 'string' &&
        typeof Reflect.get(entry, 'digest') === 'string' &&
        (Reflect.get(entry, 'uri') === undefined || typeof Reflect.get(entry, 'uri') === 'string'),
    )
  );
}
