import {
  deriveVertexLayoutProjection,
  type VertexLayoutProjection,
} from '@forgeax/engine-geometry';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MeshAsset } from '@forgeax/engine-types';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import {
  type BatchGeometry,
  captureBatchGeometry,
  prepareBatchExecution,
} from '../gpu-driven/batch-execution';
import type {
  GpuDrivenDrawRange,
  GpuDrivenGeometryReceipt,
  PreparedGpuDrivenDraw,
} from '../gpu-driven/prepared-draw';
import { ownGpuDrivenVertexInputs } from '../gpu-driven/prepared-draw';
import type { MaterialSnapshot } from '../render-system-extract';

export {
  GpuDrivenPreparationError,
  type GpuDrivenPreparationErrorCode,
  type GpuDrivenPreparationErrorDetail,
  type GpuDrivenPreparationReason,
} from '../errors/gpu-driven';
export {
  type GpuDrivenDrawRange,
  type GpuDrivenGeometryReceipt,
  type PreparedGpuDrivenDraw,
  type PrepareGpuDrivenDrawInput,
  prepareGpuDrivenDraw,
} from '../gpu-driven/prepared-draw';

export interface GpuDrivenDrawSnapshot {
  /** Stable source submesh identity; compact draw arrays must not renumber it. */
  readonly drawItemIndex?: number;
  readonly kind: GpuDrivenDrawRange['kind'];
  readonly first: GpuDrivenDrawRange['first'];
  readonly count: GpuDrivenDrawRange['count'];
  readonly baseVertex: GpuDrivenDrawRange['baseVertex'];
  readonly materialSlot: number;
  readonly topology: GpuDrivenDrawRange['topology'];
  readonly pipelineClass: string;
  readonly materialResourceClass: string;
  /** Geometry exists independently of material preparation and Pass routing. */
  readonly geometry: BatchGeometry;
  /** Producer-owned prepared ABI facts used by the PBR GPU lane. */
  readonly prepared?: PreparedGpuDrivenDraw;
  /** Structured producer failure; record never interprets an incomplete draw. */
  readonly preparationError?: GpuDrivenPreparationError;
  /** Optional lower-detail ranges aligned with the snapshot's LOD levels. */
  readonly lodRanges?: readonly {
    readonly first: number;
    readonly count: number;
    readonly baseVertex: number;
  }[];
}

export { gpuDrivenMaterialArtifactKey } from '../gpu-driven/prepared-draw';

/** Resolve the producer-owned source identity for one compact draw snapshot. */
export function gpuDrivenSourceDrawItemIndex(
  draw: GpuDrivenDrawSnapshot,
  compactIndex: number,
): number {
  return draw.drawItemIndex ?? compactIndex;
}

const EMPTY_MATERIAL_RESOURCE_CLASS = JSON.stringify({ textures: [], samplers: [] });

/**
 * Derives the resource identity consumed by the existing GPU-driven batch
 * owner. The extract stage is the only place that resolves material values;
 * this helper keeps the batch adapter from re-reading assets later.
 */
export function gpuDrivenMaterialResourceClass(material: MaterialSnapshot): string {
  if ((material.textureHandles?.size ?? 0) === 0 && (material.samplerHandles?.size ?? 0) === 0) {
    return EMPTY_MATERIAL_RESOURCE_CLASS;
  }
  const textures = [...(material.textureHandles?.entries() ?? [])]
    .map(([name, handle]) => [name, Number(handle)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const samplers = [...(material.samplerHandles?.entries() ?? [])]
    .map(([name, handle]) => [name, Number(handle)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify({
    textures,
    samplers,
  });
}

/**
 * Projects already-resolved mesh facts into the existing GPU-driven draw
 * snapshot. No World or AssetRegistry access is permitted at this boundary.
 */
interface BuildGpuDrivenDrawsInput {
  readonly mesh: MeshAsset | undefined;
  readonly materials: readonly MaterialSnapshot[];
  readonly fallbackMaterial: MaterialSnapshot;
  readonly deformation: 'rigid' | 'skin';
  readonly getMaterialShaderArtifact?: (
    materialShaderId: string,
    request?: {
      readonly vertexColorAvailable?: boolean;
      readonly deformation?: 'rigid' | 'skin';
      readonly pass?: 'forward' | 'shadow' | 'depth';
      readonly address?: 'direct' | 'scene-index';
    },
  ) => MaterialShaderArtifact | undefined;
  /** Resolved lower-detail meshes, in the same order as the authored LOD chain. */
  readonly lodMeshes?: readonly (MeshAsset | undefined)[];
}

// Geometry owns immutable layouts by canonical attribute mask. Share the derived
// input table across meshes and bindings without caching mutable author maps.
const vertexInputsByLayout = new WeakMap<
  VertexLayoutProjection,
  GpuDrivenGeometryReceipt['vertexInputs']
>();

export function buildGpuDrivenDraws(input: BuildGpuDrivenDrawsInput): GpuDrivenDrawSnapshot[] {
  const parsedMesh = input.mesh;
  if (parsedMesh === undefined) return [];
  const indexed = parsedMesh.indices !== undefined;
  const submeshes = parsedMesh.submeshes;
  const layoutProjection = deriveVertexLayoutProjection(parsedMesh.attributes);
  let vertexInputs = vertexInputsByLayout.get(layoutProjection);
  if (vertexInputs === undefined) {
    vertexInputs = ownGpuDrivenVertexInputs(
      layoutProjection.attributes.map((attribute) => ({
        semantic: attribute.key,
        location: attribute.shaderLocation,
        format: attribute.format,
      })),
    );
    vertexInputsByLayout.set(layoutProjection, vertexInputs);
  }
  const geometry: GpuDrivenGeometryReceipt = {
    identity: `${(parsedMesh as { guid?: string }).guid ?? '<no-guid>'}:${layoutProjection.digest}`,
    vertexInputs,
    topology: submeshes[0]?.topology ?? 'triangle-list',
    indexed,
  };
  let nonIndexedFirst = 0;
  return submeshes.flatMap((submesh, drawItemIndex) => {
    const drawMaterial = input.materials[submesh.materialSlot] ?? input.fallbackMaterial;
    const first = indexed ? submesh.indexOffset : nonIndexedFirst;
    nonIndexedFirst += submesh.vertexCount;
    const draw = {
      drawItemIndex,
      kind: indexed ? ('indexed' as const) : ('non-indexed' as const),
      first,
      count: indexed ? submesh.indexCount : submesh.vertexCount,
      baseVertex: 0,
      materialSlot: submesh.materialSlot,
      topology: submesh.topology,
      pipelineClass: `${drawMaterial.materialShaderId ?? 'forgeax::default-unlit'}|${submesh.topology}|${JSON.stringify(drawMaterial.renderState ?? null)}`,
      materialResourceClass: gpuDrivenMaterialResourceClass(drawMaterial),
    };
    const lodRanges = input.lodMeshes?.map((lodMesh) => {
      if (lodMesh === undefined) return undefined;
      const lower = lodMesh.submeshes[drawItemIndex];
      if (lower === undefined) return undefined;
      const lowerIndexed = lodMesh.indices !== undefined;
      const lowerFirst = lowerIndexed
        ? lower.indexOffset
        : lodMesh.submeshes
            .slice(0, drawItemIndex)
            .reduce((offset, entry) => offset + entry.vertexCount, 0);
      return {
        first: lowerFirst,
        count: lowerIndexed ? lower.indexCount : lower.vertexCount,
        baseVertex: 0,
      };
    });
    const withLodRanges =
      lodRanges?.length !== 0 && lodRanges?.every((range) => range !== undefined)
        ? { lodRanges: lodRanges as { first: number; count: number; baseVertex: number }[] }
        : {};
    const binding: BatchGeometry = captureBatchGeometry({
      receipt: { ...geometry, topology: draw.topology, indexed: draw.kind === 'indexed' },
      layout: layoutProjection,
      draw: {
        kind: draw.kind,
        first: draw.first,
        count: draw.count,
        baseVertex: draw.baseVertex,
        topology: draw.topology,
      },
      deformation: input.deformation,
    });
    const prepared =
      input.getMaterialShaderArtifact === undefined
        ? undefined
        : (() => {
            const shaderId = drawMaterial.materialShaderId;
            const sceneIndexProgramKey = Object.entries(
              drawMaterial.materialSceneIndexProgramKeys ?? {},
            ).find(
              ([name, program]) =>
                program.pass === 'forward' && drawMaterial.materialProgramKeys?.[name] === shaderId,
            )?.[1]?.specializationKey;
            const execution = prepareBatchExecution(
              binding,
              drawMaterial,
              shaderId === undefined
                ? undefined
                : {
                    kind: 'forward',
                    shaderId,
                    ...(sceneIndexProgramKey === undefined ? {} : { sceneIndexProgramKey }),
                    ...(drawMaterial.renderState === undefined
                      ? {}
                      : { renderState: drawMaterial.renderState }),
                  },
              input.getMaterialShaderArtifact,
            );
            return execution.ok
              ? execution.value.route === 'gpu'
                ? execution.value.prepared
                : undefined
              : execution.error;
          })();
    if (prepared instanceof GpuDrivenPreparationError) {
      return [{ ...draw, geometry: binding, preparationError: prepared, ...withLodRanges }];
    }
    return [
      prepared === undefined
        ? { ...draw, geometry: binding, ...withLodRanges }
        : { ...draw, geometry: binding, prepared, ...withLodRanges },
    ];
  });
}
