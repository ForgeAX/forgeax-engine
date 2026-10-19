import { isSerializableValue } from './artifacts.js';
import { capabilityUnavailableError } from './errors.js';
import type {
  ArtifactRef,
  JsonValue,
  SnapshotRef,
  ToolEvidenceKind,
  ToolRealm,
  ToolRuntimeError,
} from './types.js';

export type MigrationOperation =
  | 'project.build'
  | 'author.plugin-install'
  | 'preview.run'
  | 'project.preview'
  | 'asset.material.preview'
  | 'asset.mesh.preview'
  | 'asset.vfx.preview'
  | 'asset.texture.preview';

export interface MigrationCapabilityProbe {
  readonly realm: ToolRealm;
  readonly catalogDigest: string;
  readonly rhiBackend: 'webgpu' | 'null' | 'unknown';
  readonly evidence: readonly ToolEvidenceKind[];
  readonly carrier: boolean;
  readonly service: boolean;
}

export interface CapabilityToken {
  readonly kind: 'forgeax-tool-capability';
  readonly version: '1.0.0';
  readonly operation: MigrationOperation;
  readonly source: MigrationCapabilityProbe;
  readonly target: MigrationCapabilityProbe;
}

export interface MigrationRecipe {
  readonly operation: MigrationOperation;
  readonly args: JsonValue;
  readonly snapshot?: SnapshotRef;
  readonly artifacts: readonly ArtifactRef[];
}

export type MigrationPayloadValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ToolRuntimeError };

const liveStateKeys = new Set([
  'world',
  'renderer',
  'canvas',
  'context',
  'fiber',
  'page',
  'carrier',
  'ui',
  'selection',
  'draft',
  'undo',
  'session',
]);

function liveStateError(path: string, key: string): ToolRuntimeError {
  return {
    code: 'tool-migration-live-state',
    expected: 'migration payload to contain only recipe, snapshot, and artifact references',
    hint: 'Recreate the operation from serializable authority facts; do not migrate live state.',
    detail: { path, key },
  };
}

export function createCapabilityToken(
  operation: MigrationOperation,
  source: MigrationCapabilityProbe,
  version: '1.0.0',
  target: MigrationCapabilityProbe,
): CapabilityToken {
  if (source.catalogDigest.length === 0 || target.catalogDigest.length === 0)
    throw new TypeError('capability probe catalogDigest must not be empty');
  return {
    kind: 'forgeax-tool-capability',
    version,
    operation,
    source: { ...source, evidence: [...source.evidence] },
    target: { ...target, evidence: [...target.evidence] },
  };
}

export function probeMigrationTarget(
  token: CapabilityToken,
  target: MigrationCapabilityProbe,
):
  | { readonly ok: true; readonly value: MigrationCapabilityProbe }
  | {
      readonly ok: false;
      readonly error: ToolRuntimeError;
    } {
  const sameEvidence = token.target.evidence.every((kind) => target.evidence.includes(kind));
  const matches =
    token.target.realm === target.realm &&
    token.target.catalogDigest === target.catalogDigest &&
    token.target.rhiBackend === target.rhiBackend &&
    sameEvidence;
  if (!matches) {
    return {
      ok: false,
      error: capabilityUnavailableError(`migration:${token.operation}`, target.realm),
    };
  }
  return { ok: true, value: { ...target, evidence: [...target.evidence] } };
}

export function createMigrationRecipe(input: {
  readonly operation: MigrationOperation;
  readonly args: JsonValue;
  readonly snapshot?: SnapshotRef;
  readonly artifacts?: readonly ArtifactRef[];
}): MigrationRecipe {
  const recipe: MigrationRecipe = {
    operation: input.operation,
    args: input.args,
    ...(input.snapshot === undefined ? {} : { snapshot: { ...input.snapshot } }),
    artifacts: (input.artifacts ?? []).map((artifact) => ({ ...artifact })),
  };
  const validation = validateMigrationPayload(recipe);
  if (!validation.ok) {
    const path =
      validation.error.code === 'tool-migration-live-state' ? validation.error.detail.path : '$';
    throw new TypeError(path);
  }
  return recipe;
}

export function validateMigrationPayload(value: unknown): MigrationPayloadValidation {
  if (!isSerializableValue(value)) {
    return { ok: false, error: liveStateError('$', '$') };
  }
  const visit = (candidate: JsonValue, path: string): MigrationPayloadValidation => {
    if (candidate === null || typeof candidate !== 'object') return { ok: true };
    if (Array.isArray(candidate)) {
      for (const [index, child] of candidate.entries()) {
        const result = visit(child, `${path}[${index}]`);
        if (!result.ok) return result;
      }
      return { ok: true };
    }
    for (const [key, child] of Object.entries(candidate)) {
      const normalized = key.replaceAll('_', '').replaceAll('-', '').toLowerCase();
      if (liveStateKeys.has(normalized)) return { ok: false, error: liveStateError(path, key) };
      const result = visit(child, `${path}.${key}`);
      if (!result.ok) return result;
    }
    return { ok: true };
  };
  return visit(value, '$');
}
