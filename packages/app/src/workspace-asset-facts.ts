import { deriveVertexCount, deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { textureViewSource } from '@forgeax/engine-preview';
import { type Asset, isMaterialTextureParameterType, type MeshAsset } from '@forgeax/engine-types';

export interface WorkspaceMeshFacts extends Readonly<Record<string, unknown>> {
  readonly kind: 'mesh';
  readonly vertexCount: number | null;
  readonly indexCount: number;
  readonly triangleCount: number;
  readonly uvChannelCount: number;
  readonly submeshes: MeshAsset['submeshes'];
  readonly materialSlots: MeshAsset['materialSlots'];
  readonly aabb?: readonly number[];
  readonly indexFormat: 'uint16' | 'uint32' | 'none';
  readonly attributes: readonly string[];
  readonly geometryBytes: number;
  readonly lodCount: number;
  readonly skinned: boolean;
  readonly morphTargetCount: number;
  readonly collision: {
    readonly present: boolean;
    readonly vertexCount: number;
    readonly triangleCount: number;
  };
}

export interface WorkspaceTextureFacts extends Readonly<Record<string, unknown>> {
  readonly kind: 'texture' | 'equirect';
  readonly shape: Extract<Asset, { kind: 'texture' }>['shape'];
  readonly format: string;
  readonly colorSpace: string;
  readonly mips: Extract<Asset, { kind: 'texture' }>['mips'];
  readonly dataBytes: number;
}

export interface WorkspaceMaterialFacts extends Readonly<Record<string, unknown>> {
  readonly kind: 'material';
  readonly passCount: number | null;
  readonly parameterCount: number | null;
  readonly textureParameterCount: number | null;
  readonly passes: readonly {
    readonly name: string;
    readonly program: string;
    readonly renderState: Readonly<Record<string, unknown>> | null;
  }[];
}

export type EngineWorkspaceAssetFacts =
  | WorkspaceMeshFacts
  | WorkspaceTextureFacts
  | WorkspaceMaterialFacts;

export function workspaceAssetKind(kind: string): string {
  return kind === 'particle-effect' ? 'vfx' : kind;
}

/** Walk declared sections, preserving strip restart boundaries and non-indexed ranges. */
export function workspaceMeshTriangles(
  mesh: MeshAsset,
  visit: (a: number, b: number, c: number) => void,
): void {
  let vertexOffset = 0;
  const restart = mesh.indices instanceof Uint16Array ? 0xffff : 0xffffffff;
  for (const section of mesh.submeshes) {
    const start = mesh.indices ? section.indexOffset : vertexOffset;
    const count = mesh.indices ? section.indexCount : section.vertexCount;
    vertexOffset += section.vertexCount;
    const at = (offset: number) => mesh.indices?.[offset] ?? offset;
    if (section.topology === 'triangle-list') {
      for (let i = start; i + 2 < start + count; i += 3) visit(at(i), at(i + 1), at(i + 2));
    } else if (section.topology === 'triangle-strip') {
      let strip: number[] = [];
      let parity = 0;
      for (let i = start; i < start + count; i++) {
        const c = at(i);
        if (mesh.indices && c === restart) {
          strip = [];
          parity = 0;
          continue;
        }
        if (strip.length === 2) {
          const a = strip[0],
            b = strip[1];
          if (a !== undefined && b !== undefined && a !== b && b !== c && a !== c)
            visit(parity % 2 ? b : a, parity % 2 ? a : b, c);
          strip.shift();
          parity++;
        }
        strip.push(c);
      }
    }
  }
}

/** Detached, bounded facts from the payload retained by the preview owner. */
export function workspaceAssetFacts(payload: Asset): EngineWorkspaceAssetFacts | undefined {
  if (payload.kind === 'mesh') {
    let triangleCount = 0;
    workspaceMeshTriangles(payload, () => {
      triangleCount++;
    });
    return {
      kind: 'mesh',
      vertexCount:
        deriveVertexCount(payload.vertices, deriveVertexLayoutProjection(payload.attributes)) ??
        null,
      indexCount: payload.indices?.length ?? 0,
      triangleCount,
      uvChannelCount: Object.keys(payload.attributes).filter((key) => /^uv[1-7]?$/.test(key))
        .length,
      submeshes: structuredClone(payload.submeshes),
      materialSlots: structuredClone(payload.materialSlots),
      ...(payload.aabb ? { aabb: Array.from(payload.aabb) } : {}),
      indexFormat:
        payload.indices === undefined
          ? 'none'
          : payload.indices instanceof Uint16Array
            ? 'uint16'
            : 'uint32',
      attributes: Object.keys(payload.attributes),
      geometryBytes: payload.vertices.byteLength + (payload.indices?.byteLength ?? 0),
      lodCount: 1 + (payload.lods?.length ?? 0),
      skinned:
        payload.attributes.skinIndex !== undefined || payload.attributes.skinWeight !== undefined,
      morphTargetCount: payload.morphTargets?.length ?? 0,
      collision: {
        present: payload.collision !== undefined,
        vertexCount: (payload.collision?.positions.length ?? 0) / 3,
        triangleCount: (payload.collision?.indices.length ?? 0) / 3,
      },
    };
  }
  if (payload.kind === 'texture' || payload.kind === 'equirect') {
    const source = textureViewSource(payload);
    return {
      kind: payload.kind,
      shape: structuredClone(source.shape),
      format: source.format,
      colorSpace: source.colorSpace,
      mips: structuredClone(source.mips),
      dataBytes: source.data.byteLength,
    };
  }
  if (payload.kind === 'material')
    return {
      kind: 'material',
      passCount: payload.passes?.length ?? null,
      parameterCount: payload.parameters?.length ?? null,
      textureParameterCount:
        payload.parameters?.filter((parameter) => isMaterialTextureParameterType(parameter.type))
          .length ?? null,
      passes: (payload.passes ?? []).map((pass) => ({
        name: pass.name,
        program: pass.program.module,
        renderState: pass.renderState ? structuredClone(pass.renderState) : null,
      })),
    };
  return undefined;
}
