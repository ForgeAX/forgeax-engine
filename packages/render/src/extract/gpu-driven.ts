import {
  deriveVertexBufferLayoutFromProjection,
  deriveVertexLayoutProjection,
} from '@forgeax/engine-geometry';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MeshAsset } from '@forgeax/engine-types';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import {
  type GpuDrivenDrawRange,
  type GpuDrivenGeometryReceipt,
  type GpuDrivenSkinReceipt,
  type PreparedGpuDrivenDraw,
  type PrepareGpuDrivenDrawInput,
  prepareGpuDrivenDraw,
} from '../gpu-driven/prepared-draw';
import { isCanonicalStandardPbrMaterialShader } from '../pbr-pipeline';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';

export {
  GpuDrivenPreparationError,
  type GpuDrivenPreparationErrorCode,
  type GpuDrivenPreparationErrorDetail,
  type GpuDrivenPreparationReason,
} from '../errors/gpu-driven';
export {
  type GpuDrivenDrawRange,
  type GpuDrivenGeometryReceipt,
  type GpuDrivenSkinReceipt,
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

/** Stable ownership key for one entity/material/concrete GPU draw item. */
export function gpuDrivenDrawKey(
  worldEntity: number,
  materialHandle: number,
  drawItemIndex: number,
): string {
  return `${worldEntity}:${materialHandle}:${drawItemIndex}`;
}

/** Stable ShadowCaster ownership key: entity, concrete GPU draw item, and pass. */
export function gpuDrivenShadowDrawKey(
  worldEntity: number,
  materialHandle: number,
  drawItemIndex: number,
  passIndex: number,
): string {
  return `${gpuDrivenDrawKey(worldEntity, materialHandle, drawItemIndex)}:${passIndex}`;
}

export { gpuDrivenMaterialArtifactKey } from '../gpu-driven/prepared-draw';

/** Resolve the producer-owned source identity for one compact draw snapshot. */
export function gpuDrivenSourceDrawItemIndex(
  draw: GpuDrivenDrawSnapshot,
  compactIndex: number,
): number {
  return draw.drawItemIndex ?? compactIndex;
}

/**
 * Resolves prepared facts once at extract time; record never re-reads assets.
 * The resolver surfaces UV, reflection, vertex, alpha, resource, and
 * generation failures as GpuDrivenPreparationError before recording.
 */
export function resolvePreparedGpuDrivenDraw(input: PrepareGpuDrivenDrawInput):
  | { readonly ok: true; readonly value: PreparedGpuDrivenDraw }
  | {
      readonly ok: false;
      readonly error: import('../errors/gpu-driven').GpuDrivenPreparationError;
    } {
  return prepareGpuDrivenDraw(input);
}

/** Keeps the artifact type visible at this owner boundary for contract checks. */
export type PreparedGpuDrivenArtifact = MaterialShaderArtifact;

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
 * Dynamic renderer-local targets and video frames are owned by their host
 * producers and do not have a stable scene-index binding in this feature.
 * Keep them on the explicit CPU semantic lane instead of inventing a
 * per-instance resource table or grouping opaque source objects by shape.
 */
function hasCpuOnlyMaterialResources(material: MaterialSnapshot): boolean {
  return (material.textureSources?.size ?? 0) > 0 || (material.videoTextureFields?.size ?? 0) > 0;
}

/**
 * Projects already-resolved mesh facts into the existing GPU-driven draw
 * snapshot. No World or AssetRegistry access is permitted at this boundary.
 */
interface BuildGpuDrivenDrawsInput {
  readonly mesh: MeshAsset | undefined;
  readonly materials: readonly MaterialSnapshot[];
  readonly fallbackMaterial: MaterialSnapshot;
  readonly baseSnapshot: RenderableSnapshot;
  readonly getMaterialShaderArtifact?: (
    materialShaderId: string,
    request?: {
      readonly vertexColorAvailable?: boolean;
      readonly deformation?: 'rigid' | 'skin';
      readonly pass?: 'forward' | 'shadow' | 'depth';
      readonly address?: 'direct' | 'scene-index';
    },
  ) => MaterialShaderArtifact | undefined;
  /** Resolved lower-detail meshes, in the same order as baseSnapshot.lods. */
  readonly lodMeshes?: readonly (MeshAsset | undefined)[];
}

interface LegacyBuildGpuDrivenDrawsInput {
  readonly submeshes: readonly MeshAsset['submeshes'][number][];
  readonly indexed: boolean;
  readonly materials: readonly MaterialSnapshot[];
  readonly fallbackMaterial: MaterialSnapshot;
  readonly prepare?: (
    draw: GpuDrivenDrawSnapshot,
    material: MaterialSnapshot,
  ) => PreparedGpuDrivenDraw | undefined;
}

export function buildGpuDrivenDraws(input: BuildGpuDrivenDrawsInput): GpuDrivenDrawSnapshot[];
export function buildGpuDrivenDraws(input: LegacyBuildGpuDrivenDrawsInput): GpuDrivenDrawSnapshot[];
export function buildGpuDrivenDraws(
  input: BuildGpuDrivenDrawsInput | LegacyBuildGpuDrivenDrawsInput,
): GpuDrivenDrawSnapshot[] {
  const legacy = 'submeshes' in input;
  if (!legacy && input.mesh === undefined) return [];
  const parsedMesh = legacy ? undefined : input.mesh;
  if (!legacy && parsedMesh === undefined) return [];
  const indexed = legacy ? input.indexed : parsedMesh?.indices !== undefined;
  const submeshes = legacy ? input.submeshes : (parsedMesh?.submeshes ?? []);
  const layoutProjection =
    parsedMesh === undefined ? undefined : deriveVertexLayoutProjection(parsedMesh.attributes);
  const geometry: GpuDrivenGeometryReceipt = {
    identity:
      parsedMesh === undefined
        ? '<no-mesh>'
        : `${(parsedMesh as { guid?: string }).guid ?? '<no-guid>'}:${layoutProjection?.digest ?? ''}`,
    vertexInputs: (layoutProjection?.attributes ?? []).map((attribute) => ({
      semantic: attribute.key,
      location: attribute.shaderLocation,
      format: attribute.format,
    })),
    topology: submeshes[0]?.topology ?? 'triangle-list',
    indexed,
  };
  let nonIndexedFirst = 0;
  return submeshes.flatMap((submesh, drawItemIndex) => {
    const drawMaterial = input.materials[submesh.materialSlot] ?? input.fallbackMaterial;
    const first = indexed ? submesh.indexOffset : nonIndexedFirst;
    nonIndexedFirst += submesh.vertexCount;
    if (drawMaterial.transparent === true) return [];
    const draw: GpuDrivenDrawSnapshot = {
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
    const lodRanges = !legacy
      ? input.lodMeshes?.map((lodMesh) => {
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
        })
      : undefined;
    const withLodRanges =
      lodRanges?.length !== 0 && lodRanges?.every((range) => range !== undefined)
        ? { lodRanges: lodRanges as { first: number; count: number; baseVertex: number }[] }
        : {};
    const prepared = legacy
      ? input.prepare?.(draw, drawMaterial)
      : hasCpuOnlyMaterialResources(drawMaterial)
        ? undefined
        : (() => {
            const materialShaderId = drawMaterial.materialShaderId;
            const vertexColorAvailable = geometry.vertexInputs.some(
              (input) => input.semantic === 'color',
            );
            // The snapshot keeps the direct program key as its logical
            // material identity.  A published scene-index program has a
            // separate specialization key; resolve that concrete artifact
            // before preparing the draw so the indirect pipeline receives the
            // scene entry rather than silently reusing the direct shader.
            const sceneIndexProgramKey = Object.entries(
              drawMaterial.materialSceneIndexProgramKeys ?? {},
            ).find(
              ([passName, program]) =>
                program.pass === 'forward' &&
                drawMaterial.materialProgramKeys?.[passName] === materialShaderId,
            )?.[1]?.specializationKey;
            const artifact =
              materialShaderId === undefined
                ? undefined
                : input.getMaterialShaderArtifact?.(sceneIndexProgramKey ?? materialShaderId, {
                    vertexColorAvailable,
                    deformation: input.baseSnapshot.skin === undefined ? 'rigid' : 'skin',
                    pass: 'forward',
                    address: 'scene-index',
                  });
            // Canonical roots and explicitly published scene-index programs
            // require their producer receipt. Legacy direct-only aliases do not.
            const requiresReceipt =
              isCanonicalStandardPbrMaterialShader(materialShaderId) ||
              sceneIndexProgramKey !== undefined;

            if (artifact === undefined) {
              return input.getMaterialShaderArtifact !== undefined && requiresReceipt
                ? new GpuDrivenPreparationError('missing-material-receipt', {
                    reason: 'material-receipt-missing',
                    owner: 'material',
                    expected: `artifact for ${materialShaderId}`,
                  })
                : undefined;
            }
            const receipt = artifact.receipt;
            if (receipt === undefined) {
              return new GpuDrivenPreparationError('missing-material-receipt', {
                reason: 'material-receipt-missing',
                owner: 'material',
                expected: `receipt for ${materialShaderId}`,
              });
            }
            // A published direct-only ABI is a supported ordinary-lane choice.
            // Canonical Scene programs still fail closed when their entry is lost.
            if (receipt.sceneIndexEntry === undefined && !requiresReceipt) return undefined;
            const skinReceipt: GpuDrivenSkinReceipt | undefined =
              input.baseSnapshot.skin !== undefined && receipt.skinPaletteAddress !== undefined
                ? {
                    identity: input.baseSnapshot.skin.identity,
                    generation: input.baseSnapshot.skin.generation,
                    group: receipt.skinPaletteAddress.group,
                    binding: receipt.skinPaletteAddress.binding,
                    byteOffset: input.baseSnapshot.skin.byteOffset,
                  }
                : undefined;
            const selectedArtifact =
              artifact === undefined ||
              sceneIndexProgramKey === undefined ||
              materialShaderId === undefined
                ? artifact
                : {
                    ...artifact,
                    material: materialShaderId,
                    specializationKey: sceneIndexProgramKey,
                  };
            // Admission sees the same clamp-to-last UV aliases as recording.
            // Aliases must reuse resident bytes; a layout that adds a zero-UV
            // region cannot describe this already packed geometry.
            const layout =
              layoutProjection === undefined ||
              artifact.uvSetCount === undefined ||
              receipt.vertexInputs.every((input) =>
                geometry.vertexInputs.some((actual) => actual.location === input.location),
              )
                ? undefined
                : deriveVertexBufferLayoutFromProjection(layoutProjection, {
                    shaderUvSetCount: artifact.uvSetCount,
                  })[0];
            const aliases =
              layout?.arrayStride !== layoutProjection?.arrayStride
                ? []
                : receipt.vertexInputs.filter(
                    (input) =>
                      !geometry.vertexInputs.some((actual) => actual.location === input.location) &&
                      layout?.attributes.some(
                        (actual) =>
                          actual.shaderLocation === input.location &&
                          actual.format === input.format,
                      ),
                  );
            const result = resolvePreparedGpuDrivenDraw({
              snapshot: { ...input.baseSnapshot, material: drawMaterial },
              artifact: selectedArtifact ?? artifact,
              geometry: {
                ...geometry,
                vertexInputs:
                  aliases.length === 0
                    ? geometry.vertexInputs
                    : [...geometry.vertexInputs, ...aliases],
                topology: draw.topology,
                indexed: draw.kind === 'indexed',
              },
              generation: receipt.generation,
              draw,
              ...(skinReceipt === undefined ? {} : { skinReceipt }),
            });
            return result.ok ? result.value : result.error;
          })();
    if (prepared instanceof GpuDrivenPreparationError) {
      return [{ ...draw, preparationError: prepared, ...withLodRanges }];
    }
    return [
      prepared === undefined
        ? { ...draw, ...withLodRanges }
        : { ...draw, prepared, ...withLodRanges },
    ];
  });
}

/** Numeric cache retention follows the exact admitted draw key publication. */
export function gpuDrivenDrawEntityKeys(drawKeys: ReadonlySet<string>): ReadonlySet<number> {
  const entities = new Set<number>();
  for (const key of drawKeys) {
    const separator = key.indexOf(':');
    if (separator <= 0) continue;
    const entity = Number(key.slice(0, separator));
    if (Number.isSafeInteger(entity)) entities.add(entity);
  }
  return entities;
}
