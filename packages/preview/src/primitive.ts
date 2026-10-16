import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import {
  type MaterialBinding,
  type MaterialPreviewRequest,
  materialPreviewDescriptor,
} from './material.js';
import { type MeshBinding, type MeshPreviewRequest, meshPreviewDescriptor } from './mesh.js';
import {
  type TextureBinding,
  type TexturePreviewRequest,
  texturePreviewDescriptor,
} from './texture.js';
import {
  type VfxBinding,
  type VfxPreviewRequest,
  type VfxSimulationInput,
  vfxPreviewDescriptor,
} from './vfx.js';

export type PreviewSnapshot = MaterialPreviewRequest['snapshot'];
export type MaterialPreviewPrimitive = MaterialPreviewRequest & {
  readonly operationId: typeof materialPreviewDescriptor.id;
  readonly source: 'engine';
};
export type MeshPreviewPrimitive = MeshPreviewRequest & {
  readonly operationId: typeof meshPreviewDescriptor.id;
  readonly source: 'engine';
};
export type VfxPreviewPrimitive = VfxPreviewRequest & {
  readonly operationId: typeof vfxPreviewDescriptor.id;
  readonly source: 'engine';
};
export type TexturePreviewPrimitive = TexturePreviewRequest & {
  readonly operationId: typeof texturePreviewDescriptor.id;
  readonly source: 'engine';
};

export function previewSnapshot(subjectGuid: string, revision = 0): PreviewSnapshot {
  if (subjectGuid.length === 0 || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('preview primitive requires a stable subject snapshot');
  }
  return { revision, digest: `project-snapshot:${subjectGuid}:${revision}` };
}

export function materialBindingFromPayload(
  guid: string,
  payload: MaterialAsset,
): MaterialBinding | undefined {
  if (payload.kind !== 'material' || payload.passes === undefined || payload.passes.length === 0)
    return undefined;
  const program = payload.passes[0]?.program;
  if (!program?.module || payload.parameters === undefined || payload.parameters.length === 0)
    return undefined;
  return {
    guid,
    programDigest: `material-program:${program.module}`,
    bindings: payload.parameters.map((parameter) => parameter.name),
  };
}

export function meshBindingFromPayload(guid: string, payload: MeshAsset): MeshBinding | undefined {
  if (
    payload.kind !== 'mesh' ||
    payload.vertices.length === 0 ||
    !payload.aabb ||
    payload.aabb.length !== 6
  )
    return undefined;
  const indices = payload.indices?.length ?? payload.vertices.length / 3;
  const [minX, minY, minZ, maxX, maxY, maxZ] = payload.aabb;
  if (
    minX === undefined ||
    minY === undefined ||
    minZ === undefined ||
    maxX === undefined ||
    maxY === undefined ||
    maxZ === undefined
  )
    return undefined;
  const submeshes =
    payload.submeshes.length > 0
      ? payload.submeshes.map((submesh, index) => ({
          id: `submesh-${index}`,
          vertexCount: submesh.vertexCount,
          indexCount: submesh.indexCount,
        }))
      : [{ id: 'mesh', vertexCount: payload.vertices.length / 3, indexCount: indices }];
  if (submeshes.some((submesh) => submesh.vertexCount <= 0 || submesh.indexCount <= 0))
    return undefined;
  return {
    guid,
    vertexDigest: `mesh-vertices:${payload.vertices.length}`,
    indexDigest: `mesh-indices:${indices}`,
    submeshes,
    aabb: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    },
  };
}

function assertSnapshot(snapshot: PreviewSnapshot): void {
  if (
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    snapshot.digest.length === 0
  )
    throw new Error('preview primitive requires a revisioned snapshot');
}

function assertSubject(subjectGuid: string, bindingGuid: string, domain: string): void {
  if (subjectGuid.length === 0 || bindingGuid !== subjectGuid)
    throw new Error(`${domain} preview primitive subject and binding are disconnected`);
}

function subjectKind(operationId: string): string {
  if (operationId === 'asset.material.preview') return 'MaterialAsset';
  if (operationId === 'asset.mesh.preview') return 'MeshAsset';
  if (operationId === 'asset.vfx.preview') return 'ParticleEffectAsset';
  return 'TextureAsset';
}

function base<
  T extends {
    readonly subject: { readonly guid: string };
    readonly binding: { readonly guid: string };
  },
>(
  operationId: string,
  subjectGuid: string,
  snapshot: PreviewSnapshot,
  binding: T['binding'],
  value: Omit<T, 'subject' | 'snapshot' | 'binding' | 'operationId' | 'source'>,
): T & { readonly operationId: string; readonly source: 'engine' } {
  assertSnapshot(snapshot);
  assertSubject(subjectGuid, binding.guid, operationId);
  return Object.freeze({
    ...value,
    operationId,
    source: 'engine' as const,
    subject: { kind: subjectKind(operationId), guid: subjectGuid },
    snapshot,
    binding,
  }) as unknown as T & { readonly operationId: string; readonly source: 'engine' };
}

export function createMaterialPreviewPrimitive(input: {
  readonly subjectGuid: string;
  readonly snapshot: PreviewSnapshot;
  readonly binding: MaterialBinding;
}): MaterialPreviewPrimitive {
  if (input.binding.programDigest.length === 0 || input.binding.bindings.length === 0)
    throw new Error('material preview primitive requires program bindings');
  return base<MaterialPreviewPrimitive>(
    materialPreviewDescriptor.id,
    input.subjectGuid,
    input.snapshot,
    input.binding,
    {},
  ) as MaterialPreviewPrimitive;
}

export function createMeshPreviewPrimitive(input: {
  readonly subjectGuid: string;
  readonly snapshot: PreviewSnapshot;
  readonly binding: MeshBinding;
}): MeshPreviewPrimitive {
  if (
    input.binding.vertexDigest.length === 0 ||
    input.binding.indexDigest.length === 0 ||
    input.binding.submeshes.length === 0
  )
    throw new Error('mesh preview primitive requires complete geometry bindings');
  return base<MeshPreviewPrimitive>(
    meshPreviewDescriptor.id,
    input.subjectGuid,
    input.snapshot,
    input.binding,
    {},
  ) as MeshPreviewPrimitive;
}

export function createVfxPreviewPrimitive(input: {
  readonly subjectGuid: string;
  readonly snapshot: PreviewSnapshot;
  readonly binding: VfxBinding;
  readonly simulation: VfxSimulationInput;
}): VfxPreviewPrimitive {
  if (input.binding.effectDigest.length === 0 || input.simulation.frames < 1)
    throw new Error('vfx preview primitive requires a bounded effect simulation');
  return base<VfxPreviewPrimitive>(
    vfxPreviewDescriptor.id,
    input.subjectGuid,
    input.snapshot,
    input.binding,
    { simulation: input.simulation },
  ) as VfxPreviewPrimitive;
}

export function createTexturePreviewPrimitive(input: {
  readonly subjectGuid: string;
  readonly snapshot: PreviewSnapshot;
  readonly binding: TextureBinding;
}): TexturePreviewPrimitive {
  if (
    input.binding.width < 1 ||
    input.binding.height < 1 ||
    input.binding.format.length === 0 ||
    input.binding.mipLevels < 1 ||
    input.binding.channels < 1
  )
    throw new Error('texture preview primitive requires complete dimensions and format facts');
  return base<TexturePreviewPrimitive>(
    texturePreviewDescriptor.id,
    input.subjectGuid,
    input.snapshot,
    input.binding,
    {},
  ) as TexturePreviewPrimitive;
}
