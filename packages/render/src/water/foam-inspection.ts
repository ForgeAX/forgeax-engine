import { materialProgramContextKey } from '@forgeax/engine-pack';
import type { CompiledRenderGraphInfo } from '@forgeax/engine-render-graph';
import { derive } from '@forgeax/engine-types';
import {
  activeWaterFoamMaterialInput,
  snapshotWaterBakedQueryLineage,
  type WaterFoamMaterialInput,
} from '@forgeax/engine-water';
import { requireWaterValue } from '@forgeax/engine-water/internal';
import type { RenderSystemInternals } from '../record/render-context';
import type { MaterialSnapshot } from '../render-system-extract';
import type { sharedFeatureGraphInspection } from '../world/feature-graph-systems';
import {
  type WaterBakedDrawReceiptFact,
  waterBakedDrawClosureKey,
} from '../world/view-draw-receipt';
import type { WaterFluidBodyDescriptorInspection } from './fluid-graph';

export interface WaterFoamDrawEvidence {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration?: number;
  readonly viewIdentity?: string;
  readonly drawKey?: string;
  readonly ownerWorldIdentity?: string;
  readonly materialWorldIdentity?: string;
  readonly entityKey?: number;
  readonly materialSlot?: number;
  readonly submitted: boolean;
  readonly descriptor: WaterFluidBodyDescriptorInspection | undefined;
  readonly shared: ReturnType<typeof sharedFeatureGraphInspection>;
  readonly waterBakedDraws?: readonly WaterBakedDrawReceiptFact[];
  readonly waterBakedUnavailableReason?: 'snapshot-too-large';
}

type WaterBakedSourceWithRevision = NonNullable<WaterBakedDrawReceiptFact['sources']>[number] & {
  readonly lineage: import('@forgeax/engine-water').WaterBakedQueryLineage & {
    readonly textureRevision: number;
  };
};

function hasWaterBakedTextureRevision(
  source: NonNullable<WaterBakedDrawReceiptFact['sources']>[number],
): source is WaterBakedSourceWithRevision {
  const lineage = snapshotWaterBakedQueryLineage(source.lineage);
  return lineage !== undefined && lineage.textureRevision !== undefined;
}

function dependsOn(graph: CompiledRenderGraphInfo, consumer: string, producer: string): boolean {
  const pass = graph.passes.find((row) => row.name === consumer);
  const from = graph.passes.find((row) => row.name === producer);
  if (pass === undefined || from === undefined || from.executionIndex >= pass.executionIndex)
    return false;
  const pending = new Set(pass.dependencies);
  for (const name of pending) {
    if (name === producer) return true;
    for (const dependency of graph.passes.find((row) => row.name === name)?.dependencies ?? [])
      pending.add(dependency);
  }
  return false;
}

function sharedFoamProduced(
  graph: CompiledRenderGraphInfo | undefined,
  evidence: WaterFoamDrawEvidence | undefined,
): boolean {
  const descriptor = evidence?.descriptor;
  const shared = evidence?.shared;
  if (
    graph === undefined ||
    evidence?.submitted !== true ||
    descriptor?.sharedFoam !== true ||
    shared?.frameId !== evidence.frameId ||
    shared.deviceGeneration !== evidence.deviceGeneration ||
    descriptor.frameId !== evidence.frameId ||
    descriptor.deviceGeneration !== evidence.deviceGeneration
  )
    return false;
  const produced = shared.graph.resources.find(
    (resource) => resource.label === 'water-fluid-foam-final',
  );
  const imported = graph.resources.find(
    (resource) => resource.label === 'shared:water-fluid-foam-final',
  );
  if (
    produced?.descriptor.kind !== 'texture' ||
    imported?.origin !== 'imported' ||
    produced.physicalAllocationKey === undefined ||
    produced.physicalAllocationKey !== imported.physicalAllocationKey ||
    JSON.stringify(produced.descriptor) !== JSON.stringify(imported.descriptor)
  )
    return false;
  const writer = shared.graph.passes.find((pass) => pass.name === 'water-fluid-foam-final-write');
  const upload = graph.passes.find((pass) => pass.name === `${descriptor.resource}-upload`);
  if (
    writer?.kind !== 'raster' ||
    !writer.accesses.some(
      (access) => access.resource === produced.label && access.usage === 'color-attachment',
    ) ||
    upload?.kind !== 'copy' ||
    !upload.accesses.some(
      (access) => access.resource === descriptor.resource && access.usage === 'copy-dst',
    )
  )
    return false;
  return graph.passes.some(
    (pass) =>
      pass.name === 'water-slw-inner-color' &&
      pass.kind === 'raster' &&
      pass.accesses.some(
        (access) => access.resource === imported.label && access.usage === 'sampled-read',
      ) &&
      pass.accesses.some(
        (access) => access.resource === descriptor.resource && access.usage === 'storage-read',
      ) &&
      dependsOn(graph, pass.name, upload.name),
  );
}

export interface WaterFoamDrawInspection {
  readonly inputs: WaterFoamMaterialInput;
  /** Actual reflected consumer; author switch presence alone is not draw proof. */
  readonly foamRtConsumer: boolean;
  readonly bakedSource:
    | Readonly<{ status: 'disabled' }>
    | Readonly<{
        status: 'provenance-unavailable';
        reason:
          | 'submission-not-accepted'
          | 'view-identity-missing'
          | 'view-mismatch'
          | 'frame-mismatch'
          | 'device-generation-mismatch'
          | 'graph-generation-mismatch'
          | 'draw-identity-missing'
          | 'material-identity-missing'
          | 'draw-receipt-missing'
          | 'ambiguous-draw-match'
          | 'snapshot-too-large'
          | 'world-identity-mismatch'
          | 'source-identity-incomplete'
          | 'source-lineage-unavailable';
      }>
    | Readonly<{
        status: 'provenance-available';
        drawKey: string;
        materialIdentity: Readonly<{
          materialGuid: string;
          publicationGeneration: number;
          specializationKey: string;
          artifactHash: string;
          programKey: string;
        }>;
        sourceBodyIndices: readonly number[];
        programIdentity: Readonly<{
          pass: string;
          context: import('@forgeax/engine-pack').MaterialCookProgramContext;
          address: 'direct';
          specializationKey: string;
          artifactHash: string;
        }>;
        sources: readonly Readonly<{
          bodyIndex: number;
          bodyGuid: string;
          worldIdentity: string;
          bodyGeneration: number;
          zoneGeneration: number;
          descriptorRange: readonly [number, number];
          sampleRange: readonly [number, number];
          binding: NonNullable<WaterBakedDrawReceiptFact['sources']>[number]['binding'];
          lineage: import('@forgeax/engine-water').WaterBakedQueryLineage;
        }>[];
      }>;
  readonly foamRt: Readonly<{
    mode: 'no-simulation' | 'produced' | 'unavailable';
    target: 'water-foam-simulation' | 'water-fluid-foam-final';
    graphGeneration: number;
    initialized: boolean;
    clear: readonly [0, 0, 0, 1];
  }>;
}

function inspectWaterBakedSource(
  material: MaterialSnapshot,
  evidence: WaterFoamDrawEvidence | undefined,
  graphGeneration: number,
): WaterFoamDrawInspection['bakedSource'] {
  if (material.staticSwitches?.waterBakedSimulation !== true) return { status: 'disabled' };
  if (evidence?.submitted !== true)
    return { status: 'provenance-unavailable', reason: 'submission-not-accepted' };
  if (evidence.viewIdentity === undefined)
    return { status: 'provenance-unavailable', reason: 'view-identity-missing' };
  const drawKey = evidence.drawKey;
  if (drawKey === undefined || drawKey.length === 0)
    return { status: 'provenance-unavailable', reason: 'draw-identity-missing' };
  const publication = material.materialPublication;
  const identity = publication?.identity;
  if (publication === undefined || identity === undefined)
    return { status: 'provenance-unavailable', reason: 'material-identity-missing' };
  if ((evidence.waterBakedDraws?.length ?? 0) === 0 && evidence.waterBakedUnavailableReason)
    return { status: 'provenance-unavailable', reason: evidence.waterBakedUnavailableReason };
  const candidates = (evidence.waterBakedDraws ?? []).filter((draw) => {
    const program = draw.programIdentity;
    const selectedProgram =
      program !== undefined &&
      publication.programs.some(
        (candidate) =>
          candidate.pass === program.pass &&
          candidate.address === program.address &&
          candidate.specializationKey === program.specializationKey &&
          candidate.artifactHash === program.artifactHash &&
          materialProgramContextKey(candidate.context) ===
            materialProgramContextKey(program.context),
      );
    return (
      draw.drawKey === drawKey &&
      draw.entityKey === evidence.entityKey &&
      draw.materialSlot === evidence.materialSlot &&
      draw.materialIdentity.materialGuid === identity.materialGuid &&
      draw.materialIdentity.publicationGeneration === identity.publicationGeneration &&
      draw.materialIdentity.specializationKey === identity.specializationKey &&
      draw.materialIdentity.artifactHash === identity.artifactHash &&
      draw.materialIdentity.programKey === program?.specializationKey &&
      selectedProgram
    );
  });
  if (candidates.length === 0)
    return { status: 'provenance-unavailable', reason: 'draw-receipt-missing' };
  const matchSubmittedDraws = (
    candidates: readonly WaterBakedDrawReceiptFact[],
    evidence: WaterFoamDrawEvidence,
    graphGeneration: number,
  ) => {
    const matchingDraws = candidates.filter(
      (draw) =>
        draw.viewIdentity === evidence.viewIdentity &&
        draw.frameId === evidence.frameId &&
        draw.deviceGeneration === evidence.deviceGeneration &&
        draw.graphGeneration === (evidence.graphGeneration ?? graphGeneration) &&
        evidence.ownerWorldIdentity !== undefined &&
        evidence.materialWorldIdentity !== undefined &&
        draw.ownerWorldIdentity === evidence.ownerWorldIdentity &&
        draw.materialWorldIdentity === evidence.materialWorldIdentity,
    );
    const matches = [
      ...new Map(matchingDraws.map((draw) => [waterBakedDrawClosureKey(draw), draw])),
    ].map(([, draw]) => draw);
    if (matches.length === 0) {
      const staged = candidates[0];
      const reason: Extract<
        WaterFoamDrawInspection['bakedSource'],
        { status: 'provenance-unavailable' }
      >['reason'] =
        staged?.availability?.status === 'unavailable'
          ? staged.availability.reason
          : staged?.viewIdentity !== evidence.viewIdentity
            ? 'view-mismatch'
            : staged?.frameId !== evidence.frameId
              ? 'frame-mismatch'
              : staged?.deviceGeneration !== evidence.deviceGeneration
                ? 'device-generation-mismatch'
                : evidence.ownerWorldIdentity === undefined ||
                    evidence.materialWorldIdentity === undefined ||
                    staged?.ownerWorldIdentity !== evidence.ownerWorldIdentity ||
                    staged?.materialWorldIdentity !== evidence.materialWorldIdentity
                  ? 'world-identity-mismatch'
                  : 'graph-generation-mismatch';
      return { ok: false as const, failure: { status: 'provenance-unavailable' as const, reason } };
    }

    return { ok: true as const, matches };
  };
  const matched = matchSubmittedDraws(candidates, evidence, graphGeneration);
  if (!matched.ok) return matched.failure;
  const matches = matched.matches;
  const publishBakedSourceInspection = (
    matches: readonly WaterBakedDrawReceiptFact[],
  ): WaterFoamDrawInspection['bakedSource'] => {
    if (matches.length !== 1)
      return { status: 'provenance-unavailable', reason: 'ambiguous-draw-match' };
    const draw = matches[0];
    if (draw === undefined)
      return { status: 'provenance-unavailable', reason: 'ambiguous-draw-match' };
    if (draw.availability?.status === 'unavailable')
      return { status: 'provenance-unavailable', reason: draw.availability.reason };
    if (
      draw.availability?.status !== 'complete' ||
      draw.materialIdentity.programKey === undefined ||
      draw.programIdentity === undefined ||
      draw.sourceBodyIndices.length === 0 ||
      draw.sources?.length !== draw.sourceBodyIndices.length ||
      draw.sources.some((source, index) => source.bodyIndex !== draw.sourceBodyIndices[index])
    )
      return { status: 'provenance-unavailable', reason: 'source-identity-incomplete' };
    const sources = draw.sources.filter(hasWaterBakedTextureRevision);
    if (sources.length !== draw.sources.length)
      return { status: 'provenance-unavailable', reason: 'source-lineage-unavailable' };
    return Object.freeze({
      status: 'provenance-available',
      drawKey,
      materialIdentity: Object.freeze({
        materialGuid: identity.materialGuid,
        publicationGeneration: identity.publicationGeneration,
        specializationKey: identity.specializationKey,
        artifactHash: identity.artifactHash,
        programKey: draw.materialIdentity.programKey,
      }),
      programIdentity: Object.freeze({
        ...draw.programIdentity,
        context: Object.freeze({ ...draw.programIdentity.context }),
      }),
      sourceBodyIndices: Object.freeze([...draw.sourceBodyIndices]),
      sources: Object.freeze(
        sources.map((source) =>
          Object.freeze({
            bodyIndex: source.bodyIndex,
            bodyGuid: source.bodyGuid,
            worldIdentity: source.worldIdentity,
            bodyGeneration: source.bodyGeneration,
            zoneGeneration: source.zoneGeneration,
            descriptorRange: Object.freeze([...source.descriptorRange]) as readonly [
              number,
              number,
            ],
            sampleRange: Object.freeze([...source.sampleRange]) as readonly [number, number],
            binding: Object.freeze({ ...source.binding }),
            lineage: requireWaterValue(snapshotWaterBakedQueryLineage(source.lineage)),
          }),
        ),
      ),
    });
  };
  return publishBakedSourceInspection(matches);
}

/** Read the exact material source closure and compiled graph used by this view.
 * The existing material/residency owners retain all payloads and GPU bindings. */
export function inspectWaterFoamDraw(
  material: MaterialSnapshot,
  internals: RenderSystemInternals,
  graph: CompiledRenderGraphInfo | undefined,
  graphGeneration: number,
  evidence?: WaterFoamDrawEvidence,
): WaterFoamDrawInspection | undefined {
  if (material.waterDeformation === undefined && material.surfaceModel !== 'single-layer-water')
    return undefined;
  const source = material.sourceAssets;
  const switches = material.staticSwitches;
  const reference = (field: string) => {
    const handle = material.textureHandles?.get(field);
    const asset = source?.assets.find((value) => value.handle === handle);
    return asset?.source === undefined
      ? undefined
      : Object.freeze({ guid: asset.source.guid, version: asset.revision });
  };
  const staticTexture = reference('waterFoamTexture'),
    staticNormalTexture = reference('waterFoamNormalTexture'),
    volumeNoiseTexture = reference('waterVolumeNoiseTexture');
  const artifact =
    material.materialShaderId === undefined
      ? undefined
      : internals.shaderRegistry?.findMaterialArtifact(material.materialShaderId);
  const consumer =
    artifact?.ok === true &&
    artifact.value.program.materialBindings?.includes(
      derive(artifact.value.paramSchema ?? []).userRegionBindingEnd + 17,
    ) === true;
  const initialized =
    graph?.passes.some((pass) => pass.name === 'water-foam-no-simulation-initialize') === true;
  const target =
    graph?.resources.some((resource) => resource.label === 'water-foam-simulation') === true;
  const fluidConsumer =
    consumer &&
    artifact?.ok === true &&
    artifact.value.receipt?.systemInputs?.water === 'water-frame/3' &&
    [19, 20].every(
      (offset) =>
        artifact.value.program.materialBindings?.includes(
          derive(artifact.value.paramSchema ?? []).userRegionBindingEnd + offset,
        ) === true,
    );
  const produced = fluidConsumer && sharedFoamProduced(graph, evidence);
  const inputs = activeWaterFoamMaterialInput({
    sourceGeneration: source?.revision ?? 0,
    ...(staticTexture === undefined ? {} : { staticTexture }),
    ...(staticNormalTexture === undefined ? {} : { staticNormalTexture }),
    ...(volumeNoiseTexture === undefined ? {} : { volumeNoiseTexture }),
    materialSwitches: Object.freeze({
      waterOceanFoam: switches?.waterOceanFoam === true,
      fluidSimulationFoam: produced,
      waterBakedSimulation: switches?.waterBakedSimulation === true,
    }),
  });
  return Object.freeze({
    inputs,
    foamRtConsumer: consumer,
    bakedSource: Object.freeze(inspectWaterBakedSource(material, evidence, graphGeneration)),
    foamRt: Object.freeze({
      mode: produced ? 'produced' : target && initialized ? 'no-simulation' : 'unavailable',
      target: produced ? 'water-fluid-foam-final' : 'water-foam-simulation',
      graphGeneration,
      initialized: produced || initialized,
      clear: [0, 0, 0, 1] as const,
    }),
  });
}
