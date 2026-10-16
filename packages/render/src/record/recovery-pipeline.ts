import {
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  deriveVertexLayoutProjection,
  type VertexLayoutProjection,
} from '@forgeax/engine-geometry';
import type { MaterialRenderState, PassKind, PrimitiveTopology } from '@forgeax/engine-types';
import { isTriangleTopology } from '@forgeax/engine-types';
import { standardTransmissionAdmission } from '../assembly/device-feature-admission';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '../materials';
import {
  isStandardPbrMaterialShader,
  SHADOW_CASTER_SHADER_ID,
  SKIN_MATERIAL_SHADER_ID,
  SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET,
  shadowCasterVariantSet,
} from '../pbr-pipeline';
import type { StandardTopologyInputValue } from '../pipeline/standard-lighting/topology';
import {
  cacheKeyOf,
  colorFormatsForPassKind,
  type PipelineSpec,
  PipelineSpecError,
  standardStorageVariantSet,
  standardTopologyVariantSet,
  variantSetFromVertexLayoutProjection,
} from '../pipeline-spec';
import { POINTS_LINES_MATERIAL_SHADER_ID, pointsLinesFragmentEntry } from '../points-lines/record';
import type { CameraSnapshot } from '../render-contract';
import type { DispatchEntry, MaterialSnapshot } from '../render-system-extract';
import type { ValidatedRenderable } from './frame-snapshot';
import { geometryRenderStateForPass } from './main-pass-geometry';
import { geometryRenderStateForTopology } from './main-pass-material';
import type {
  MaterialShaderPipelineEntry,
  PipelineState,
  RenderSystemInternals,
} from './render-context';

export interface RecoveryPipelineReadiness {
  readonly pipelineSpecs: readonly PipelineSpec[];
  /** Re-resolve every candidate request and assert a stable cache hit. */
  readonly assertPreparedCache: () => void;
  readonly assertFirstRecoveryFrame: () => void;
}

interface RecoveryPipelineRequest {
  readonly spec: PipelineSpec;
  readonly resolve: () => MaterialShaderPipelineEntry | null;
}

function optionalRenderState(
  state: MaterialRenderState | undefined,
): { readonly renderState: MaterialRenderState } | Record<string, never> {
  return state === undefined ? {} : { renderState: state };
}

function optionalVariant(
  variant: string | undefined,
): { readonly variantSet: string } | Record<string, never> {
  return variant === undefined ? {} : { variantSet: variant };
}

function optionalColorFormat(
  format: GPUTextureFormat | undefined,
): { readonly colorFormatOverride: GPUTextureFormat } | Record<string, never> {
  return format === undefined ? {} : { colorFormatOverride: format };
}

function optionalFragmentEntry(
  entry: string | undefined,
): { readonly fragmentEntry: string } | Record<string, never> {
  return entry === undefined ? {} : { fragmentEntry: entry };
}

function projectionVariant(
  projection: VertexLayoutProjection,
  requested: string | undefined,
  preserveUndefined = false,
): string | undefined {
  if (preserveUndefined && requested === undefined) return undefined;
  const resolved = variantSetFromVertexLayoutProjection(projection, requested);
  if (!resolved.ok) {
    throw new PipelineSpecError({
      code: 'spec-inconsistent',
      detail: { reason: resolved.error.message },
      hint: 'recovery candidate variant must agree with the LKG vertex layout projection',
    });
  }
  return resolved.value;
}

function recoveryRenderState(
  materialShaderId: string,
  material: MaterialSnapshot,
  topology: PrimitiveTopology,
): MaterialRenderState | undefined {
  const sprite =
    materialShaderId === 'forgeax::sprite' || materialShaderId === 'forgeax::sprite-lit';
  if (sprite) {
    return {
      ...material.renderState,
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
      cullMode: 'none',
      blend: material.renderState?.blend ?? SPRITE_PREMULTIPLIED_ALPHA_BLEND,
    };
  }
  return geometryRenderStateForTopology(topology, material.renderState);
}

function addRequest(input: {
  readonly requests: RecoveryPipelineRequest[];
  readonly requestKeys: Set<string>;
  readonly internals: RenderSystemInternals;
  readonly pipelineState: PipelineState;
  readonly materialShaderId: string;
  readonly isHdrTarget: boolean;
  readonly renderState?: MaterialRenderState;
  readonly topology?: PrimitiveTopology;
  readonly indexFormat?: 'uint16' | 'uint32';
  readonly variantSet?: string;
  readonly passKind?: PassKind;
  readonly sampleCount?: number;
  readonly colorFormatOverride?: GPUTextureFormat;
  readonly additionalColorFormats?: readonly GPUTextureFormat[];
  readonly depthFormatOverride?: GPUTextureFormat | null;
  readonly vertexLayoutProjection?: VertexLayoutProjection;
  readonly vertexEntry?: string;
  readonly fragmentEntry?: string;
  readonly layoutKindOverride?:
    | 'pbr'
    | 'pbr-skin'
    | 'surface-direct-pbr'
    | 'surface-direct-cluster-pbr';
  readonly preserveUndefinedVariant?: boolean;
  readonly variantAlreadyResolved?: boolean;
}): void {
  const passKind = input.passKind ?? 'forward';
  const projection = input.vertexLayoutProjection;
  const resolvedVariantSet =
    input.variantAlreadyResolved === true
      ? input.variantSet
      : projection === undefined
        ? input.variantSet
        : projectionVariant(projection, input.variantSet, input.preserveUndefinedVariant === true);
  const colorFormat = input.isHdrTarget
    ? 'rgba16float'
    : (input.colorFormatOverride ?? input.pipelineState.colorAttachmentFormat);
  const colorFormats =
    input.renderState?.outputs?.map((output) => output.format) ??
    (input.additionalColorFormats === undefined
      ? colorFormatsForPassKind(passKind, colorFormat)
      : [colorFormat, ...input.additionalColorFormats]);
  const depthFormat =
    passKind === 'shadow-caster' || passKind === 'point-shadow-caster'
      ? 'depth32float'
      : input.depthFormatOverride === null
        ? undefined
        : (input.depthFormatOverride ?? 'depth32float-stencil8');
  const shaderUvSetCount = input.internals.getMaterialShaderUvSetCount?.(input.materialShaderId);
  const spec: PipelineSpec = Object.freeze({
    shader: Object.freeze({
      id: input.materialShaderId,
      passKind,
      variantSet: resolvedVariantSet,
      ...(input.vertexEntry === undefined ? {} : { vertexEntry: input.vertexEntry }),
      ...(input.fragmentEntry === undefined ? {} : { fragmentEntry: input.fragmentEntry }),
    }),
    attachments: Object.freeze({
      colorFormats: Object.freeze([...colorFormats]),
      depthFormat,
      sampleCount: (input.sampleCount === 4 ? 4 : 1) as 1 | 4,
    }),
    geometry: Object.freeze({
      topology: input.topology ?? 'triangle-list',
      stripIndexFormat: input.indexFormat,
      vertexLayout: DEFAULT_VERTEX_ATTRIBUTE_MAP,
      ...(projection === undefined ? {} : { vertexLayoutProjection: projection }),
      ...(shaderUvSetCount !== undefined && shaderUvSetCount > 1
        ? {
            shaderUvSetCount,
          }
        : {}),
    }),
    renderState: input.renderState,
  });
  const key = cacheKeyOf(spec);
  if (input.requestKeys.has(key)) return;
  input.requestKeys.add(key);
  const resolve = (): MaterialShaderPipelineEntry | null =>
    input.internals.getMaterialShaderPipelineEntry?.(
      input.materialShaderId,
      input.isHdrTarget,
      input.renderState,
      input.topology,
      input.indexFormat,
      resolvedVariantSet,
      passKind,
      undefined,
      input.sampleCount,
      input.colorFormatOverride,
      undefined,
      undefined,
      undefined,
      projection,
      'immediate',
      input.layoutKindOverride,
      undefined,
      input.additionalColorFormats,
      input.vertexEntry,
      input.fragmentEntry,
    ) ?? null;
  input.requests.push({ spec, resolve });
}

function addStandardMaterialRequests(input: {
  readonly requests: RecoveryPipelineRequest[];
  readonly requestKeys: Set<string>;
  readonly internals: RenderSystemInternals;
  readonly pipelineState: PipelineState;
  readonly validated: readonly ValidatedRenderable[];
  readonly dispatch: readonly DispatchEntry[];
  readonly standardLighting: StandardTopologyInputValue | undefined;
  readonly sampleCount: number;
  readonly isHdrTarget: boolean;
  readonly colorFormatOverride?: GPUTextureFormat;
  readonly reflectionFallbackAvailable: boolean;
}): void {
  const pointsLinesProjection = deriveVertexLayoutProjection(DEFAULT_VERTEX_ATTRIBUTE_MAP);
  const forwardPrograms = new Map<string, DispatchEntry>();
  for (const candidate of input.dispatch) {
    if (candidate.tags.LightMode !== 'Forward' || candidate.materialShaderId === undefined)
      continue;
    const key = `${candidate.renderableIndex}:${candidate.materialHandle}`;
    if (!forwardPrograms.has(key)) forwardPrograms.set(key, candidate);
  }
  for (const entry of input.validated) {
    if (entry.source.pointsLines !== undefined) {
      const pointsLinesMaterial = entry.source.material;
      addRequest({
        requests: input.requests,
        requestKeys: input.requestKeys,
        internals: input.internals,
        pipelineState: input.pipelineState,
        materialShaderId: POINTS_LINES_MATERIAL_SHADER_ID,
        isHdrTarget: input.isHdrTarget,
        renderState: {
          ...pointsLinesMaterial.renderState,
          cullMode: 'none',
        },
        topology: 'triangle-list',
        indexFormat: 'uint32',
        sampleCount: input.sampleCount,
        ...optionalColorFormat(input.colorFormatOverride),
        vertexLayoutProjection: pointsLinesProjection,
        ...optionalFragmentEntry(pointsLinesFragmentEntry(entry.source.pointsLines.style)),
      });
      continue;
    }
    const meshProjection = entry.mesh.layoutProjection;
    const hasVertexColor = meshProjection.attributes.some((attribute) => attribute.key === 'color');
    const capabilityVariantSet = standardTopologyVariantSet(
      input.standardLighting,
      input.internals.device.caps.storageBuffer,
      hasVertexColor,
    );
    // The probe record is an object-level ABI extension of the built-in
    // Standard PBR family. Recovery must request the same variant that the
    // live record path will select, otherwise the first post-recovery draw
    // discovers avoidable cold PSO work.
    const probeBlendRecordAvailable =
      input.internals.device.caps.storageBuffer && entry.source.probeBlendRecord !== undefined;
    const standardPbrCapabilityVariantSet = standardTopologyVariantSet(
      input.standardLighting,
      input.internals.device.caps.storageBuffer,
      hasVertexColor,
      probeBlendRecordAvailable,
    );
    const unlitProjection = projectionVariant(meshProjection, undefined);
    const unlitHasColor = unlitProjection === 'VERTEX_COLOR_AVAILABLE=true';
    for (const submesh of entry.mesh.submeshes) {
      const material = entry.source.materials[submesh.materialSlot] ?? entry.source.material;
      const forwardProgram = forwardPrograms.get(
        `${entry.renderableIndex}:${material.materialHandle ?? -1}`,
      );
      const materialShaderId =
        entry.source.skin === undefined
          ? (forwardProgram?.materialShaderId ??
            material.materialShaderId ??
            'forgeax::default-unlit')
          : SKIN_MATERIAL_SHADER_ID;
      const renderState = geometryRenderStateForPass(
        recoveryRenderState(materialShaderId, material, submesh.topology) as ReturnType<
          typeof geometryRenderStateForTopology
        >,
        'forward',
      );
      if (entry.source.skin !== undefined && submesh === entry.mesh.submeshes[0]) {
        const skinProbeVariant = projectionVariant(meshProjection, standardPbrCapabilityVariantSet);
        addRequest({
          requests: input.requests,
          requestKeys: input.requestKeys,
          internals: input.internals,
          pipelineState: input.pipelineState,
          materialShaderId: SKIN_MATERIAL_SHADER_ID,
          isHdrTarget: input.isHdrTarget,
          ...optionalRenderState(entry.source.material.renderState),
          topology: entry.mesh.submeshes[0]?.topology ?? 'triangle-list',
          indexFormat: entry.mesh.indexFormat,
          ...optionalVariant(skinProbeVariant),
          sampleCount: input.sampleCount,
          ...optionalColorFormat(input.colorFormatOverride),
          vertexLayoutProjection: meshProjection,
          variantAlreadyResolved: true,
        });
      }
      if (
        materialShaderId === 'forgeax::default-unlit' ||
        materialShaderId === 'forgeax::default-standard-unlit'
      ) {
        addRequest({
          requests: input.requests,
          requestKeys: input.requestKeys,
          internals: input.internals,
          pipelineState: input.pipelineState,
          materialShaderId,
          isHdrTarget: input.isHdrTarget,
          ...optionalRenderState(renderState),
          topology: submesh.topology,
          indexFormat: entry.mesh.indexFormat,
          variantSet: standardStorageVariantSet(
            input.internals.device.caps.storageBuffer,
            unlitHasColor,
          ),
          sampleCount: input.sampleCount,
          ...optionalColorFormat(input.colorFormatOverride),
          vertexLayoutProjection: meshProjection,
        });
        continue;
      }
      const isSprite =
        materialShaderId === 'forgeax::sprite' || materialShaderId === 'forgeax::sprite-lit';
      const topologyVariantSet = isStandardPbrMaterialShader(materialShaderId)
        ? standardPbrCapabilityVariantSet
        : capabilityVariantSet;
      // Candidate requests must select the same admitted transmission module
      // as live recording; recovery only prewarms modules used by the old generation.
      const transmission = standardTransmissionAdmission(
        material,
        input.internals.device.limits.maxSampledTexturesPerShaderStage,
      );
      const materialCapabilityVariantSet =
        transmission !== undefined &&
        transmission.kind !== 'exceeded' &&
        !topologyVariantSet.includes('TRANSMISSION_AVAILABLE=')
          ? `${topologyVariantSet}+TRANSMISSION_AVAILABLE=true`
          : topologyVariantSet;
      const surfaceLayoutKind =
        material.surfaceModel === 'single-layer-medium'
          ? input.standardLighting?.kind === 'clustered' &&
            input.internals.device.caps.storageBuffer
            ? ('surface-direct-cluster-pbr' as const)
            : ('surface-direct-pbr' as const)
          : undefined;
      const requestedVariant = isSprite
        ? materialShaderId === 'forgeax::sprite' && entry.source.spriteInstances !== undefined
          ? SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET
          : undefined
        : entry.variantSet === undefined
          ? materialCapabilityVariantSet
          : `${materialCapabilityVariantSet}+${entry.variantSet}`;
      const reflectionFallbackVariant =
        input.reflectionFallbackAvailable && materialShaderId === 'forgeax::default-standard-pbr'
          ? (() => {
              const projected = projectionVariant(meshProjection, requestedVariant);
              return projected === ''
                ? projected
                : `${projected}+REFLECTION_FALLBACK_AVAILABLE=true`;
            })()
          : requestedVariant;
      addRequest({
        requests: input.requests,
        requestKeys: input.requestKeys,
        internals: input.internals,
        pipelineState: input.pipelineState,
        materialShaderId,
        isHdrTarget: input.isHdrTarget,
        ...optionalRenderState(renderState),
        topology: submesh.topology,
        indexFormat: entry.mesh.indexFormat,
        ...optionalVariant(reflectionFallbackVariant),
        passKind: 'forward',
        ...(forwardProgram?.vertexEntry === undefined
          ? {}
          : { vertexEntry: forwardProgram.vertexEntry }),
        ...(forwardProgram?.fragmentEntry === undefined
          ? {}
          : { fragmentEntry: forwardProgram.fragmentEntry }),
        sampleCount: input.sampleCount,
        ...optionalColorFormat(input.colorFormatOverride),
        ...(input.reflectionFallbackAvailable &&
        materialShaderId === 'forgeax::default-standard-pbr'
          ? { additionalColorFormats: ['rgba16float'] as const }
          : {}),
        vertexLayoutProjection: meshProjection,
        ...(surfaceLayoutKind === undefined ? {} : { layoutKindOverride: surfaceLayoutKind }),
        preserveUndefinedVariant: isSprite && requestedVariant === undefined,
        variantAlreadyResolved:
          isSprite ||
          (input.reflectionFallbackAvailable &&
            materialShaderId === 'forgeax::default-standard-pbr'),
      });
    }
  }
}

function addTransparentSpriteRequests(input: {
  readonly requests: RecoveryPipelineRequest[];
  readonly requestKeys: Set<string>;
  readonly internals: RenderSystemInternals;
  readonly pipelineState: PipelineState;
  readonly validated: readonly ValidatedRenderable[];
  readonly standardLighting: StandardTopologyInputValue | undefined;
  readonly sampleCount: number;
  readonly isHdrTarget: boolean;
  readonly colorFormat: GPUTextureFormat;
}): void {
  const spriteRenderState: MaterialRenderState = {
    depthWriteEnabled: false,
    depthCompare: 'less-equal',
    cullMode: 'none',
    blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND,
  };
  // recordSpritePass resolves all three built-in sprite pipelines before it
  // walks the visible entities. A generic transparent material is enough to
  // enter that pass, so candidate preparation must warm the same complete
  // request set even when the LKG contains no sprite entity. These calls also
  // intentionally omit vertexLayoutProjection: the record path omits that
  // argument and the factory's default sprite layout is the cache identity.
  for (const request of [
    {
      materialShaderId: 'forgeax::sprite',
      variantSet: undefined,
      preserveUndefinedVariant: true,
    },
    {
      materialShaderId: 'forgeax::sprite',
      variantSet: SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET,
      preserveUndefinedVariant: false,
    },
    {
      materialShaderId: 'forgeax::sprite-lit',
      variantSet: standardTopologyVariantSet(
        input.standardLighting,
        input.internals.device.caps.storageBuffer,
        false,
      ),
      preserveUndefinedVariant: false,
    },
  ] as const) {
    addRequest({
      requests: input.requests,
      requestKeys: input.requestKeys,
      internals: input.internals,
      pipelineState: input.pipelineState,
      materialShaderId: request.materialShaderId,
      isHdrTarget: input.isHdrTarget,
      renderState: spriteRenderState,
      topology: 'triangle-list',
      ...optionalVariant(request.variantSet),
      sampleCount: input.sampleCount,
      colorFormatOverride: input.colorFormat,
      preserveUndefinedVariant: request.preserveUndefinedVariant,
      variantAlreadyResolved: true,
    });
  }

  for (const entry of input.validated) {
    const entityShaderId = entry.source.material.materialShaderId;
    if (
      entityShaderId === 'forgeax::sprite' ||
      entityShaderId === 'forgeax::sprite-lit' ||
      entry.source.skin !== undefined ||
      entry.source.instances !== undefined
    ) {
      continue;
    }
    const projectedVariant = projectionVariant(
      entry.mesh.layoutProjection,
      standardTopologyVariantSet(
        input.standardLighting,
        input.internals.device.caps.storageBuffer,
        entry.mesh.layoutProjection.attributes.some((attribute) => attribute.key === 'color'),
      ),
    );
    for (const submesh of entry.mesh.submeshes) {
      const material = entry.source.materials[submesh.materialSlot] ?? entry.source.material;
      if (material.transparent !== true || material.materialShaderId === undefined) continue;
      addRequest({
        requests: input.requests,
        requestKeys: input.requestKeys,
        internals: input.internals,
        pipelineState: input.pipelineState,
        materialShaderId: material.materialShaderId,
        isHdrTarget: input.isHdrTarget,
        ...optionalRenderState(material.renderState),
        topology: submesh.topology,
        indexFormat: entry.mesh.indexFormat,
        ...optionalVariant(projectedVariant),
        sampleCount: input.sampleCount,
        colorFormatOverride: input.colorFormat,
        vertexLayoutProjection: entry.mesh.layoutProjection,
        variantAlreadyResolved: true,
      });
    }
  }
}

function addShadowRequests(input: {
  readonly requests: RecoveryPipelineRequest[];
  readonly requestKeys: Set<string>;
  readonly internals: RenderSystemInternals;
  readonly pipelineState: PipelineState;
  readonly validated: readonly ValidatedRenderable[];
  readonly dispatch: readonly DispatchEntry[];
}): void {
  // Recovery has no record context, so it cannot use the context-backed
  // shadowShaderMap. Group the producer dispatch facts directly and warm every
  // authored ShadowCaster pass for the matching renderable/material pair.
  const dispatches = new Map<number, Map<number, DispatchEntry[]>>();
  for (const candidate of input.dispatch) {
    if (candidate.tags.LightMode !== 'ShadowCaster' || candidate.materialShaderId === undefined)
      continue;
    const byMaterial = dispatches.get(candidate.renderableIndex);
    if (byMaterial === undefined) {
      dispatches.set(candidate.renderableIndex, new Map([[candidate.materialHandle, [candidate]]]));
    } else {
      const entries = byMaterial.get(candidate.materialHandle);
      if (entries === undefined) byMaterial.set(candidate.materialHandle, [candidate]);
      else entries.push(candidate);
    }
  }
  for (const entry of input.validated) {
    for (const submesh of entry.mesh.submeshes) {
      if (!isTriangleTopology(submesh.topology)) continue;
      const material = entry.source.materials[submesh.materialSlot] ?? entry.source.material;
      const shadowDispatches =
        dispatches.get(entry.renderableIndex)?.get(material.materialHandle ?? 0) ?? [];
      for (const dispatch of shadowDispatches.length === 0 ? [undefined] : shadowDispatches) {
        const materialShaderId =
          dispatch?.materialShaderId === 'forgeax::default-standard-pbr' ||
          dispatch?.materialShaderId === undefined
            ? SHADOW_CASTER_SHADER_ID
            : dispatch.materialShaderId;
        addRequest({
          requests: input.requests,
          requestKeys: input.requestKeys,
          internals: input.internals,
          pipelineState: input.pipelineState,
          materialShaderId,
          isHdrTarget: false,
          ...optionalRenderState(dispatch?.renderState),
          topology: submesh.topology,
          indexFormat: entry.mesh.indexFormat,
          ...optionalVariant(
            materialShaderId === SHADOW_CASTER_SHADER_ID
              ? shadowCasterVariantSet(
                  input.internals.device.caps.storageBuffer,
                  entry.source.skin !== undefined,
                )
              : undefined,
          ),
          passKind: 'shadow-caster',
          sampleCount: 1,
          vertexLayoutProjection: entry.mesh.layoutProjection,
          layoutKindOverride: entry.source.skin === undefined ? 'pbr' : 'pbr-skin',
          ...(dispatch?.vertexEntry === undefined ? {} : { vertexEntry: dispatch.vertexEntry }),
          ...(dispatch?.fragmentEntry === undefined
            ? {}
            : { fragmentEntry: dispatch.fragmentEntry }),
          variantAlreadyResolved: true,
        });
      }
    }
  }
}

export function prepareRecoveryPipelineReadiness(input: {
  readonly internals: RenderSystemInternals;
  readonly pipelineState: PipelineState;
  readonly camera: CameraSnapshot;
  readonly standardLighting: StandardTopologyInputValue | undefined;
  readonly validated: readonly ValidatedRenderable[];
  readonly dispatch: readonly DispatchEntry[];
  readonly shadowCastersActive: boolean;
  readonly splitLdrSprite: boolean;
  readonly reflectionFallbackAvailable: boolean;
}): RecoveryPipelineReadiness {
  const requests: RecoveryPipelineRequest[] = [];
  const requestKeys = new Set<string>();
  const sampleCount =
    input.camera.antialias === 'msaa' && input.internals.device.caps.backendKind !== 'wgpu-webgl2'
      ? 4
      : 1;
  const isHdrTarget = input.camera.tonemap !== 'none' || input.reflectionFallbackAvailable;
  addStandardMaterialRequests({
    requests,
    requestKeys,
    internals: input.internals,
    pipelineState: input.pipelineState,
    validated: input.validated,
    dispatch: input.dispatch,
    standardLighting: input.standardLighting,
    sampleCount,
    isHdrTarget,
    reflectionFallbackAvailable: input.reflectionFallbackAvailable,
  });
  if (input.splitLdrSprite) {
    // The split pass is the non-tonemapped Standard scene target, not the
    // swap-chain storage/view format. StandardForwardLane keeps that target
    // rgba16float on every non-clear linear-LDR path; using the surface format
    // here would prepare a different PipelineSpec from the record seam and
    // force a first-frame PSO miss.
    const colorFormat = 'rgba16float' as GPUTextureFormat;
    addTransparentSpriteRequests({
      requests,
      requestKeys,
      internals: input.internals,
      pipelineState: input.pipelineState,
      validated: input.validated,
      standardLighting: input.standardLighting,
      sampleCount,
      isHdrTarget: isHdrTarget || colorFormat === 'rgba16float',
      colorFormat,
    });
  }
  const hasTriangleGeometry = input.validated.some((entry) =>
    entry.mesh.submeshes.some(
      (submesh) => submesh.topology === 'triangle-list' || submesh.topology === 'triangle-strip',
    ),
  );
  if (input.shadowCastersActive && hasTriangleGeometry) {
    addShadowRequests({
      requests,
      requestKeys,
      internals: input.internals,
      pipelineState: input.pipelineState,
      validated: input.validated,
      dispatch: input.dispatch,
    });
  }
  const assertPreparedCache = (): void => {
    for (const request of requests) {
      const first = request.resolve();
      const second = request.resolve();
      if (first === null || second === null || first.pipeline !== second.pipeline) {
        throw new PipelineSpecError({
          code: 'pipeline-build-failed',
          detail: {
            spec: request.spec,
            stablePipeline: first !== null && second !== null && first.pipeline === second.pipeline,
          },
          hint: 'the recovery candidate must resolve every LKG pipeline twice from its prepared cache',
        });
      }
    }
  };
  assertPreparedCache();
  return {
    pipelineSpecs: Object.freeze(requests.map((request) => request.spec)),
    assertPreparedCache,
    assertFirstRecoveryFrame: assertPreparedCache,
  };
}
