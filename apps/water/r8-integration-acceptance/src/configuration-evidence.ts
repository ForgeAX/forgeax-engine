import type { AssetRegistry } from '@forgeax/engine/assets-runtime';
import type { EntityHandle } from '@forgeax/engine/ecs';
import type { inspectPhysicsCapabilities, PhysicsWorld } from '@forgeax/engine/physics';
import type { FrameReceipt, RenderInspection } from '@forgeax/engine/render';
import { inspectWaterRenderCapabilities } from '@forgeax/engine/render';
import type { inspectRhiDeviceFacts } from '@forgeax/engine/rhi';
import type { WaterBuoyancyState, waterSceneZoneSnapshot } from '@forgeax/engine/runtime';
import type { AssetHandle, MaterialAsset, MaterialValue } from '@forgeax/engine/types';
import type {
  WaterBodySnapshot,
  WaterBudgetResource,
  WaterZoneSnapshot,
} from '@forgeax/engine/water';
import {
  createWaterCapabilityReport,
  estimateWaterResourceBudget,
  type WaterCapabilitySelection,
  type WaterCapabilityStatus,
  WaterQueryFlags,
  type WaterSystem,
} from '@forgeax/engine/water';
import { requireDemoValue } from '../../runtime-input';

export type ConfigurationSourceCandidate = {
  zoneRevision: number;
  zoneGenerationBefore: number;
  expectedZone: WaterZoneSnapshot['asset'];
  bodyRevisions: readonly number[];
  waveSetGuid: string;
};

export function bodyEvidence(snapshot: WaterBodySnapshot | undefined) {
  return (
    snapshot && {
      guid: snapshot.guid,
      sourceAssetGuid: snapshot.sourceAssetGuid,
      instanceEntity: snapshot.instanceEntity,
      sourceVersion: snapshot.sourceVersion,
      sourcePublication: snapshot.sourcePublication,
      sceneGeneration: snapshot.sceneGeneration,
      worldMatrixM: snapshot.worldMatrixM,
      binding: snapshot.binding,
      asset: {
        type: snapshot.asset.type,
        waveSetGuid: snapshot.asset.waveSetGuid,
        baseHeightM: snapshot.asset.baseHeightM,
        surfaceMaterialGuid: snapshot.asset.surfaceMaterialGuid,
        flags: snapshot.asset.flags,
      },
      outputs: snapshot.outputs,
      outputGenerations: snapshot.outputGenerations,
      outputReceipts: snapshot.outputReceipts,
      dirty: [...snapshot.dirty],
      dependencies: snapshot.dependencies.map((dependency) => ({
        guid: dependency.guid,
        kind: dependency.kind,
        field: dependency.field,
        status: dependency.status,
        failure: dependency.failure,
      })),
    }
  );
}

export function materialDrawEvidence(
  inspection: RenderInspection,
  handles: readonly number[],
  revisions: readonly number[],
  requireDrawReceipt = false,
) {
  const expected = new Map<number, number>(
    handles.flatMap((handle, index) => {
      const revision = revisions[index];
      return revision === undefined ? [] : [[handle, revision] as const];
    }),
  );
  return inspection.meshMaterialBindings.flatMap((draw) =>
    draw.bindings.flatMap((binding, index) => {
      const expectedRevision = expected.get(binding.handle),
        receipt = binding.drawReceipt,
        actualRevision = requireDrawReceipt
          ? binding.sourceRevision
          : draw.waterFoamInputs?.[index]?.inputs.sourceGeneration;
      return expectedRevision === undefined || (requireDrawReceipt && receipt === undefined)
        ? []
        : [
            {
              handle: binding.handle,
              expectedRevision,
              actualRevision,
              frameId: receipt?.frameId,
              deviceGeneration: receipt?.deviceGeneration,
              graphGeneration: receipt?.graphGeneration,
            },
          ];
    }),
  );
}

export function logicalBudget(inspection: RenderInspection) {
  const rows: WaterBudgetResource[] = [],
    unknown: string[] = [];
  for (const [resourceIndex, resource] of (inspection.waterGraph?.resources ?? []).entries()) {
    const descriptor = resource.descriptor;
    const label = resource.label;
    const feature: WaterBudgetResource['feature'] = label?.includes('water-info')
      ? 'water-info'
      : label?.includes('ssr')
        ? 'ssr'
        : label?.includes('water-fluid')
          ? 'fluid'
          : label?.includes('water-advanced')
            ? 'advanced'
            : label?.includes('water-ocean')
              ? 'ocean'
              : label?.includes('water-gpu')
                ? 'water-mesh'
                : label?.includes('prepass') ||
                    label?.includes('water-normal') ||
                    label?.includes('water-mask') ||
                    label?.includes('water-wpo')
                  ? 'prepass'
                  : 'scene-copy';
    const base = {
      key:
        resource.physicalAllocationKey ??
        `${inspection.frame.deviceGeneration}/${requireDemoValue(inspection.waterGraph, 'accepted authored scene member').generation}/resource-${resourceIndex}`,
      feature,
      deviceGeneration: inspection.frame.deviceGeneration,
      graphResourceVersion: String(
        requireDemoValue(inspection.waterGraph, 'accepted authored scene member').generation,
      ),
      copies: 1,
      lastUseFence: null,
      state: 'active' as const,
    };
    if (descriptor.kind === 'texture') {
      const format = descriptor.format as Extract<
        WaterBudgetResource,
        { kind: 'texture' }
      >['format'];
      const row = {
        ...base,
        kind: 'texture' as const,
        format,
        width: descriptor.width,
        height: descriptor.height,
        layers: descriptor.depthOrArrayLayers,
        mips: descriptor.mipLevelCount,
        samples: descriptor.sampleCount as 1 | 4,
      };
      if (estimateWaterResourceBudget([row]).ok) rows.push(row);
      else if (label !== undefined) unknown.push(label);
    } else if (descriptor.kind === 'buffer')
      rows.push({ ...base, kind: 'buffer', size: descriptor.size, alignment: 1 });
    else if (label !== undefined) unknown.push(label);
  }
  const unique = [...new Map(rows.map((row) => [row.key, row])).values()];
  return {
    estimate: estimateWaterResourceBudget(unique),
    unknown,
    coverage: 'current-compiled-view-water-dependency-closure-only',
    lifetimeCoverage: {
      currentGraphState: 'assumed-active-for-descriptor-estimate',
      candidateBytes: null,
      previousAndRetiringBytes: null,
      allGenerationPeakBytes: null,
      lastUseFences: 'unmeasured',
    },
    generationAllocation: inspection.renderGraphGenerationAllocation ?? null,
    physicalVram: 'unmeasured',
    gpuMilliseconds: 'unmeasured',
  };
}

export function configurationWaterInfoPublication(
  acceptedZone: ReturnType<typeof waterSceneZoneSnapshot>,
  snapshots: readonly (WaterBodySnapshot | undefined)[],
  receipt: FrameReceipt,
  inspection: RenderInspection,
): NonNullable<NonNullable<RenderInspection['waterGraph']>['waterInfo']>[number] | undefined {
  const publication =
    acceptedZone &&
    inspection.waterGraph?.waterInfo?.find(
      (row) =>
        row.frameGeneration === receipt.frameId &&
        row.deviceGeneration === receipt.deviceGeneration &&
        snapshots.every(
          (snapshot) =>
            snapshot !== undefined &&
            row.rows.some(
              (info) =>
                info.bodyGuid === snapshot.guid &&
                info.bodyGeneration === snapshot.sceneGeneration &&
                info.outputGeneration === snapshot.outputGenerations.waterInfo &&
                info.zoneGuid === acceptedZone.guid &&
                info.zoneGeneration === acceptedZone.generation &&
                row.targets.some(
                  (target) =>
                    target.targetName === info.targetName && target.graphResourceVersion.length > 0,
                ),
            ),
        ),
    );
  return publication;
}

export function checkConfigurationSource(
  candidate: ConfigurationSourceCandidate,
  acceptedZone: ReturnType<typeof waterSceneZoneSnapshot>,
  snapshots: readonly (WaterBodySnapshot | undefined)[],
  blockers: string[],
) {
  if (
    !acceptedZone ||
    acceptedZone.sourceRevision !== candidate.zoneRevision ||
    acceptedZone.generation <= candidate.zoneGenerationBefore
  )
    blockers.push('zone-revision');
  const zoneSettings = (asset: WaterZoneSnapshot['asset']) => ({
    tessellationFactor: asset.tessellationFactor,
    tileSizeM: asset.tileSizeM,
    lodScale: asset.lodScale,
    extentM: asset.extentM,
    waterInfo: asset.waterInfo,
    gpuMesh: asset.gpuMesh ?? null,
    farMaterialGuid: asset.farMaterialGuid,
  });
  if (
    !acceptedZone ||
    JSON.stringify(zoneSettings(acceptedZone.asset)) !==
      JSON.stringify(zoneSettings(candidate.expectedZone))
  )
    blockers.push('effective-zone-settings');
  if (
    snapshots.some(
      (snapshot, index) =>
        !snapshot ||
        snapshot.sourceVersion !== String(candidate.bodyRevisions[index]) ||
        snapshot.asset.waveSetGuid !== candidate.waveSetGuid ||
        snapshot.binding.kind !== 'bound' ||
        snapshot.binding.zoneGeneration !== acceptedZone?.generation,
    )
  )
    blockers.push('body-revisions');
}

export type ConfigurationMode =
  | 'Q0'
  | 'Q1'
  | 'Q2'
  | 'Q3'
  | 'Q4'
  | 'R1'
  | 'R5'
  | 'R6'
  | 'R7-shallow'
  | 'R7-bake'
  | 'R7-fft';
type ConfigurationProduct = { bodies: { ocean: { surface: string; lod: string } }; far: string };
type CompletedReceipt = Pick<FrameReceipt, 'frameId' | 'deviceGeneration' | 'graphGeneration'>;
type ZoneMesh = ReturnType<WaterSystem['zoneMeshView']>;
export interface ConfigurationCompletionCandidate extends ConfigurationSourceCandidate {
  mode: ConfigurationMode;
  frameAfter: number;
  deviceGeneration: number;
  materialHandles: readonly number[];
  materialRevisions: readonly number[];
  asyncCompletedBefore: number;
  legacyFluidEnabled: boolean;
  blockers: readonly string[];
}
export interface ConfigurationCompletionSources {
  zone: ReturnType<typeof waterSceneZoneSnapshot>;
  bodies: readonly (WaterBodySnapshot | undefined)[];
  readMesh: WaterSystem['zoneMeshView'];
  async: WaterBuoyancyState['async'];
  legacy: ReturnType<WaterSystem['fluid']['inspect']>[string] | undefined;
  appearanceProducts: Record<'Q3' | 'Q4', ConfigurationProduct>;
  appearanceSourceVersion: () => string;
}

export function completedCpuWaterMesh(
  inspection: RenderInspection,
  receipt: CompletedReceipt | undefined,
  acceptedZone: ReturnType<typeof waterSceneZoneSnapshot>,
  snapshots: readonly (WaterBodySnapshot | undefined)[],
  readMesh: WaterSystem['zoneMeshView'],
) {
  const renderer = inspectWaterRenderCapabilities(inspection);
  if (
    !receipt ||
    receipt.frameId !== inspection.frame.frameId ||
    receipt.deviceGeneration !== inspection.frame.deviceGeneration ||
    renderer.gpuMesh ||
    !acceptedZone ||
    acceptedZone.asset.gpuMesh !== undefined
  )
    return undefined;
  const publication = inspection.waterGraph?.waterInfo?.find(
    (row) =>
      row.frameGeneration === receipt.frameId &&
      row.deviceGeneration === receipt.deviceGeneration &&
      snapshots.every(
        (snapshot) =>
          snapshot !== undefined &&
          row.rows.some(
            (info) =>
              info.bodyGuid === snapshot.guid &&
              info.bodyGeneration === snapshot.sceneGeneration &&
              info.outputGeneration === snapshot.outputGenerations.waterInfo &&
              info.zoneGuid === acceptedZone.guid &&
              info.zoneGeneration === acceptedZone.generation,
          ),
      ),
  );
  if (!publication || publication.unavailable.length > 0 || !renderer.waterInfo.active)
    return undefined;
  const mesh = readMesh(acceptedZone.guid, publication.viewIdentity),
    raster = snapshots.filter((snapshot) => snapshot?.asset.flags.affectsWaterMesh);
  return mesh?.current &&
    mesh.zoneGeneration === acceptedZone.generation &&
    raster.every(
      (snapshot) =>
        snapshot !== undefined &&
        mesh.sourceGenerations[snapshot.guid] === snapshot.sceneGeneration &&
        mesh.waterMeshOutputGenerations[snapshot.guid] === snapshot.outputGenerations.waterMesh,
    )
    ? mesh
    : undefined;
}

export function configurationEvidence(
  candidate: ConfigurationCompletionCandidate,
  receipt: FrameReceipt,
  inspection: RenderInspection,
  sources: ConfigurationCompletionSources,
): ReturnType<typeof projectConfigurationEvidence> | undefined {
  const blockers: string[] = [],
    acceptedZone = sources.zone,
    snapshots = sources.bodies,
    facts = inspectWaterRenderCapabilities(inspection);
  const checkReceiptIdentity = () => {
    if (
      receipt.frameId <= candidate.frameAfter ||
      receipt.deviceGeneration !== candidate.deviceGeneration ||
      inspection.frame.frameId !== receipt.frameId ||
      inspection.frame.deviceGeneration !== receipt.deviceGeneration
    )
      blockers.push('receipt-identity');
  };
  checkReceiptIdentity();
  checkConfigurationSource(candidate, acceptedZone, snapshots, blockers);
  const publication = configurationWaterInfoPublication(
    acceptedZone,
    snapshots,
    receipt,
    inspection,
  );
  if (!publication || publication.unavailable.length > 0 || !facts.waterInfo.active)
    blockers.push('submitted-water-info');
  const mesh =
    publication && acceptedZone
      ? sources.readMesh(acceptedZone.guid, publication.viewIdentity)
      : undefined;
  const raster = snapshots.filter((snapshot) => snapshot?.asset.flags.affectsWaterMesh);
  if (
    candidate.mode === 'R1'
      ? !facts.gpuMesh
      : !mesh?.current ||
        mesh.zoneGeneration !== acceptedZone?.generation ||
        !raster.every(
          (snapshot) =>
            snapshot !== undefined &&
            mesh.sourceGenerations[snapshot.guid] === snapshot.sceneGeneration &&
            mesh.waterMeshOutputGenerations[snapshot.guid] === snapshot.outputGenerations.waterMesh,
        )
  )
    blockers.push('submitted-water-mesh');
  const checkConfigurationGraph = () => {
    if (candidate.mode === 'Q3' && (facts.gpuMesh || candidate.expectedZone.gpuMesh !== undefined))
      blockers.push('cpu-water-mesh-mode');
    if (candidate.mode === 'Q3' || candidate.mode === 'Q4') {
      const product = sources.appearanceProducts[candidate.mode];
      if (
        snapshots.some((snapshot) => {
          if (!snapshot) return true;
          const expected = product.bodies.ocean;
          return (
            snapshot.asset.surfaceMaterialGuid !== expected.surface ||
            snapshot.asset.lodMaterialGuid !== expected.lod
          );
        }) ||
        candidate.expectedZone.farMaterialGuid !== product.far
      )
        blockers.push('saved-appearance-product');
    }
    if (
      !facts.singleLayerOptics ||
      !facts.noWaterSceneCopy ||
      !facts.waterSurfaceVisibility ||
      !facts.deferredLighting ||
      !facts.captureSky ||
      (candidate.mode === 'Q2' ? facts.waterSurfaceSsr : !facts.waterSurfaceSsr)
    )
      blockers.push('mode-graph-closure');
    if (
      candidate.mode === 'R5' &&
      (sources.async.execution !== 'worker-solver' ||
        sources.async.completed <= candidate.asyncCompletedBefore)
    )
      blockers.push('async-completion');
  };
  checkConfigurationGraph();
  const requiresMaterialDrawReceipt = candidate.mode === 'Q3' || candidate.mode === 'Q4',
    materialDraws = materialDrawEvidence(
      inspection,
      candidate.materialHandles,
      candidate.materialRevisions,
      requiresMaterialDrawReceipt,
    );
  if (
    materialDraws.length === 0 ||
    materialDraws.some(
      (draw) =>
        draw.actualRevision !== draw.expectedRevision ||
        (requiresMaterialDrawReceipt &&
          (draw.frameId !== receipt.frameId ||
            draw.deviceGeneration !== receipt.deviceGeneration ||
            draw.graphGeneration !== inspection.waterGraph?.generation)),
    )
  )
    blockers.push('submitted-material-revisions');
  const legacy = sources.legacy;
  if (
    candidate.legacyFluidEnabled
      ? legacy?.kind !== 'active' ||
        legacy.deviceGeneration !== receipt.deviceGeneration ||
        !facts.fluidSimulation
      : legacy?.kind !== 'disabled'
  )
    blockers.push('legacy-fluid-composition');
  candidate.blockers = blockers;
  return blockers.length
    ? undefined
    : projectConfigurationEvidence(
        candidate,
        receipt,
        sources,
        publication,
        mesh,
        facts,
        materialDraws,
        legacy,
      );
}
type CompletedConfigurationEvidence = {
  zone: ReturnType<typeof waterSceneZoneSnapshot>;
  bodies: ReturnType<typeof bodyEvidence>[];
  waterInfo: ReturnType<typeof configurationWaterInfoPublication>;
  mesh: Omit<NonNullable<ZoneMesh>, 'receipt'> | undefined;
  graph: ReturnType<typeof inspectWaterRenderCapabilities>['resourceClosure'];
  async: WaterBuoyancyState['async'];
  materialDraws: ReturnType<typeof materialDrawEvidence>;
  cpuWaterMesh?:
    | Pick<
        NonNullable<ZoneMesh>,
        'publicationGeneration' | 'sourceGenerations' | 'waterMeshOutputGenerations'
      >
    | undefined;
  appearanceAdapter?: {
    kind: string;
    sourceVersion: string;
    frameId: number;
    materialDraws: ReturnType<typeof materialDrawEvidence>;
  };
  legacyFluid: ConfigurationCompletionSources['legacy'];
};
function projectConfigurationEvidence(
  candidate: ConfigurationCompletionCandidate,
  receipt: FrameReceipt,
  sources: ConfigurationCompletionSources,
  publication: ReturnType<typeof configurationWaterInfoPublication>,
  mesh: ZoneMesh,
  facts: ReturnType<typeof inspectWaterRenderCapabilities>,
  materialDraws: ReturnType<typeof materialDrawEvidence>,
  legacy: ConfigurationCompletionSources['legacy'],
): CompletedConfigurationEvidence {
  const acceptedZone = sources.zone,
    snapshots = sources.bodies;
  const meshEvidence = mesh && (({ receipt: _receipt, ...evidence }) => evidence)(mesh);
  return {
    zone: acceptedZone,
    bodies: snapshots.map(bodyEvidence),
    waterInfo: publication,
    mesh: meshEvidence,
    graph: facts.resourceClosure,
    async: { ...sources.async },
    materialDraws,
    ...(candidate.mode === 'Q3'
      ? {
          cpuWaterMesh: mesh && {
            publicationGeneration: mesh.publicationGeneration,
            sourceGenerations: mesh.sourceGenerations,
            waterMeshOutputGenerations: mesh.waterMeshOutputGenerations,
          },
        }
      : {}),
    ...(candidate.mode === 'Q4'
      ? {
          appearanceAdapter: {
            kind: 'flat-transparent',
            sourceVersion: sources.appearanceSourceVersion(),
            frameId: receipt.frameId,
            materialDraws,
          },
        }
      : {}),
    legacyFluid: legacy,
  };
}

export function configurationRendererFacts(
  mode: ConfigurationMode,
  inspection: RenderInspection,
  cpuMesh: boolean,
  q4Draws: ReturnType<typeof materialDrawEvidence>,
  appearanceSourceAccepted: () => boolean,
  appearanceSourceVersion: () => string,
  facts: ReturnType<typeof inspectWaterRenderCapabilities>,
) {
  return {
    ...facts,
    ...(mode === 'Q3' ? { cpuMesh: cpuMesh ? true : facts.cpuMesh } : {}),
    ...(mode === 'Q4'
      ? {
          appearanceAdapter: {
            kind: 'flat-transparent' as const,
            composed:
              facts.ready &&
              appearanceSourceAccepted() &&
              q4Draws.some(
                (draw) =>
                  draw.actualRevision === draw.expectedRevision &&
                  draw.frameId === inspection.frame.frameId &&
                  draw.deviceGeneration === inspection.frame.deviceGeneration,
              ),
            sourceVersion: appearanceSourceVersion(),
          },
        }
      : {}),
  };
}

export function waterTelemetry(
  bodies: readonly { type: string; handle: AssetHandle<'water-body'>; entity: EntityHandle }[],
  bodySnapshot: (body: {
    type: string;
    handle: AssetHandle<'water-body'>;
    entity: EntityHandle;
  }) => WaterBodySnapshot | undefined,
  water: WaterSystem,
  latest: RenderInspection | undefined,
  completedReceipt: CompletedReceipt | undefined,
  readTimeSeconds: () => number,
  readSolverClock: () => ReturnType<NonNullable<PhysicsWorld['getSolverClock']>>,
  readBodySource: (handle: AssetHandle<'water-body'>) => unknown,
  regions: Record<string, readonly [number, number, number]>,
  materials: readonly AssetHandle<'material'>[],
  readMaterialRevision: (handle: AssetHandle<'material'>) => number,
  readMaterialSwitches: (handle: AssetHandle<'material'>) => MaterialAsset['staticSwitches'],
  requiresFoamValidation: () => boolean,
  contactDecayPerSecond: number,
) {
  return {
    bodies: bodies.map((body) => {
      const snapshot = bodySnapshot(body);
      return {
        type: body.type,
        source: readBodySource(body.handle),
        runtimeAssetOutputStatus: {
          owner: 'Runtime.waterSceneSnapshot',
          sampledAfterCompletedReceipt: completedReceipt ?? null,
          snapshot: bodyEvidence(snapshot) ?? null,
        },
        waterSystemOutputStatus: {
          owner: 'WaterSystem.snapshot',
          sampledAfterCompletedReceipt: completedReceipt ?? null,
          snapshot: bodyEvidence(snapshot && water.snapshot(snapshot.guid)) ?? null,
        },
        query: snapshot
          ? water.queryBody(snapshot.guid, {
              positionM: regions[body.type] ?? [0, 0, 0],
              flags:
                WaterQueryFlags.ComputeLocation |
                WaterQueryFlags.ComputeDepth |
                WaterQueryFlags.IncludeWaves,
              timeSeconds: readTimeSeconds(),
              nativePhysics: {
                completedStep: readSolverClock().completedStep,
                timeSeconds: readSolverClock().simulationTimeSeconds,
              },
            })
          : null,
      };
    }),
    zones: water.zoneSnapshots(),
    views: latest?.waterGraph?.waterInfo?.map((publication) =>
      water.viewState(publication.viewIdentity),
    ),
    foamInputs: {
      contactHistory: { decayPerSecond: contactDecayPerSecond },
      enabled: requiresFoamValidation(),
      authoredMaterials: materials.map((handle) => ({
        handle,
        revision: readMaterialRevision(handle),
        staticSwitches: readMaterialSwitches(handle),
      })),
      submittedFrame: latest
        ? { frameId: latest.frame.frameId, deviceGeneration: latest.frame.deviceGeneration }
        : null,
      draws: latest?.meshMaterialBindings.filter((row) =>
        row.waterFoamInputs?.some((input) => input !== undefined),
      ),
    },
    rendererAcceptedMeshPublications: latest?.waterGraph?.waterInfo?.flatMap((publication) =>
      [...new Set(publication.rows.map((row) => row.zoneGuid))].map((zoneGuid) => {
        const mesh = water.zoneMeshView(zoneGuid, publication.viewIdentity);
        return {
          owner: 'WaterSystem.zoneMeshView',
          acceptedBy: 'Render completion feedback',
          sampledAfterCompletedReceipt: completedReceipt ?? null,
          waterInfoSubmittedFrame: {
            frameId: publication.frameGeneration,
            deviceGeneration: publication.deviceGeneration,
          },
          viewIdentity: publication.viewIdentity,
          zoneGuid,
          publication: mesh
            ? {
                generation: mesh.publicationGeneration,
                zoneGeneration: mesh.zoneGeneration,
                sourceGenerations: mesh.sourceGenerations,
                outputGenerations: mesh.waterMeshOutputGenerations,
                current: mesh.current,
                mesh: {
                  treeDepth: mesh.receipt.treeDepth,
                  selectedTileCount: mesh.receipt.selectedTileCount,
                  farInstanceCount: mesh.receipt.farInstanceCount,
                  tiles: mesh.receipt.instances,
                  draws: mesh.receipt.buckets.flatMap((bucket) =>
                    bucket.ownerDraws.map((draw) => ({
                      materialKey: bucket.materialKey,
                      ownerGuid: draw.ownerGuid,
                      indexCount: draw.indexCount,
                      instanceCount: draw.instances.length,
                    })),
                  ),
                },
              }
            : null,
        };
      }),
    ),
  };
}

export function waterComposition(
  activeMode: ConfigurationMode,
  selection: WaterCapabilitySelection,
  localEnabled: boolean,
  materials: readonly MaterialAsset[],
  legacyEnabled: boolean,
  legacyState: ReturnType<WaterSystem['fluid']['inspect']>[string] | null,
  contactEnabled: boolean,
) {
  return {
    optics: selection,
    identity: `${activeMode}-optics${
      localEnabled
        ? activeMode === 'R7-shallow'
          ? '+water-body-shallow/2'
          : '+mode-projected-gravity/1'
        : ''
    }`,
    strictUncomposedUeR0: false,
    crest: {
      owner: 'Water surface material',
      domain:
        activeMode === 'R6' ? 'legacy-r6-wave-foam-history' : 'gerstner-horizontal-compression',
      amounts: materials.map((material) => material.values?.surfaceCrestFoamAmount ?? 0),
      legacyR6Enabled: legacyEnabled,
      legacyState: legacyState ?? null,
    },
    contact: {
      owner: 'WaterContactProbeSet',
      enabled: contactEnabled,
      amounts: materials.map((material) => material.values?.contactFoamAmount ?? 1),
    },
    shore: {
      owner: 'SLW no-water scene depth',
      widthsCameraAxisM: materials.map((material) => material.values?.sceneDepthFoamWidthM ?? 0),
      amounts: materials.map((material) => material.values?.sceneDepthFoamAmount ?? 0),
    },
  };
}

// Runtime admission already resolves inheritance and the selected parameter
// defaults. Observe that authority rather than rebuilding a material lineage.
export const waterMaterialObservation = (source: MaterialAsset) => ({
  values: requireDemoValue(source.values, 'admitted material values'),
  switches: source.staticSwitches ?? {},
});
// Read fresh accepted assets only for a demanded observation or an explicit edit.
export function updateVisibleWater(
  assets: AssetRegistry,
  handles: readonly AssetHandle<'material'>[],
  pending: boolean,
  project: (
    values: Readonly<Record<string, MaterialValue | null>>,
    accepted: ReturnType<typeof waterMaterialObservation>,
  ) => Readonly<Record<string, MaterialValue | null>>,
) {
  if (pending) throw new Error('Wait for configuration completion');
  const rows = handles.map((handle) => ({
    handle,
    source: assets.read(handle).unwrap(),
  }));
  try {
    for (const { handle, source } of rows) {
      const accepted = requireDemoValue(source.values, 'admitted material values');
      const values = project(accepted, waterMaterialObservation(source));
      if (values !== accepted) assets.update(handle, { values }).unwrap();
    }
  } catch (error) {
    for (const { handle, source } of rows) assets.replace(handle, source).unwrap();
    throw error;
  }
}

export function configurationCapabilityReport(
  mode: ConfigurationMode,
  selection: WaterCapabilitySelection,
  parameterIdentity: string,
  settings: WaterZoneSnapshot['asset'],
  solverExecution: WaterBuoyancyState['async']['execution'],
  device: ReturnType<typeof inspectRhiDeviceFacts>,
  renderer: ReturnType<typeof configurationRendererFacts>,
  physics: ReturnType<typeof inspectPhysicsCapabilities>,
  localEnabled: boolean,
) {
  const report = createWaterCapabilityReport({
    ...selection,
    parameterIdentity,
    format: settings.waterInfo.format === 'rgba32f' ? 'rgba32float' : 'rgba16float',
    width: settings.waterInfo.resolution.widthPx,
    height: settings.waterInfo.resolution.heightPx,
    layers: 1,
    reflectionMode: mode === 'Q2' ? 'disabled' : 'ssr',
    solverExecution: solverExecution === 'worker-solver' ? 'worker-solver' : 'inline-solver',
    device: {
      version: 2,
      compute: waterObservationStatus(device.compute),
      storageBuffer: waterObservationStatus(device.storageBuffer),
      indirectDraw: waterObservationStatus(device.indirectDraw),
      formats: {
        rgba16float: waterFormatFacts(device.formats.rgba16float),
        rgba32float: waterFormatFacts(device.formats.rgba32float),
        depth32float: {
          renderSample: waterObservationStatus(device.formats.depth32float.renderSample),
        },
        rg16float: { renderSample: waterObservationStatus(device.formats.rg16float.renderSample) },
      },
      limits: device.limits,
    },
    renderer,
    physics: physics,
  });
  return {
    ...report,
    composition: {
      base: selection,
      local: localEnabled
        ? mode === 'R7-shallow'
          ? 'water-body-shallow/2'
          : 'mode-projected-gravity/1'
        : null,
    },
  };
}

function waterObservationStatus(
  status: ReturnType<typeof inspectRhiDeviceFacts>['compute'],
): WaterCapabilityStatus {
  return status === 'supported' || status === 'unsupported' ? status : 'unavailable';
}

function waterFormatFacts(format: ReturnType<typeof inspectRhiDeviceFacts>['formats']['rgba16float']) {
  return {
    renderSample: waterObservationStatus(format.renderSample),
    arrayRenderSample: waterObservationStatus(format.arrayRenderSample),
    storageSample: waterObservationStatus(format.storageSample),
  };
}

export function sceneEvidence(
  sourceKey: string,
  sceneGuid: string,
  seed: number,
  resolution: readonly number[],
  eye: readonly number[],
  target: readonly number[],
  weather: string,
  cloudsEnabled: boolean,
  skyGuid: string,
  exposure: number,
  meshProfile: string,
  meshSettings: Readonly<Record<string, unknown>>,
  effectiveTessellationFactor: number,
) {
  return {
    sourceKey,
    guid: sceneGuid,
    seed: seed,
    fixedDeltaSeconds: 1 / 60,
    resolution: resolution,
    camera: { eye, target },
    weather: weather,
    cloudsEnabled,
    skyVariant: cloudsEnabled ? 'cloudy' : 'cloudless',
    skySourceGuid: skyGuid,
    exposure: exposure,
    meshProfile: {
      name: meshProfile,
      ...meshSettings,
      effectiveTessellationFactor: effectiveTessellationFactor,
    },
  };
}

export async function loadQualityMaterialSources(
  assets: AssetRegistry,
  products: Record<'Q3' | 'Q4', ConfigurationProduct>,
) {
  const q3Materials = {
    oceanSurface: (await assets.load(products.Q3.bodies.ocean.surface, 'material')).unwrap(),
    oceanLod: (await assets.load(products.Q3.bodies.ocean.lod, 'material')).unwrap(),
    far: (await assets.load(products.Q3.far, 'material')).unwrap(),
  };
  const q4Materials = {
    ocean: (await assets.load(products.Q4.bodies.ocean.surface, 'material')).unwrap(),
    far: (await assets.load(products.Q4.far, 'material')).unwrap(),
  };
  const qualityMaterialHandles = {
    Q3: [q3Materials.oceanSurface, q3Materials.oceanLod, q3Materials.far],
    Q4: [q4Materials.ocean, q4Materials.far],
  } as const;
  const qualityMaterialRows = (mode: 'Q3' | 'Q4') =>
    mode === 'Q3'
      ? [
          {
            slot: 'ocean-surface',
            guid: products.Q3.bodies.ocean.surface,
            handle: q3Materials.oceanSurface,
          },
          {
            slot: 'ocean-lod',
            guid: products.Q3.bodies.ocean.lod,
            handle: q3Materials.oceanLod,
          },
          { slot: 'far', guid: products.Q3.far, handle: q3Materials.far },
        ]
      : [
          {
            slot: 'ocean',
            guid: products.Q4.bodies.ocean.surface,
            handle: q4Materials.ocean,
          },
          { slot: 'far', guid: products.Q4.far, handle: q4Materials.far },
        ];
  const qualitySourceClosureAccepted = (mode: 'Q3' | 'Q4') =>
    qualityMaterialRows(mode).every(({ handle, guid: assetGuid }) => {
      const content = assets.read(handle).unwrap(),
        accepted = assets.source(handle).unwrap()?.publication,
        published = assets.catalogEntry(assetGuid)?.publication;
      return (
        content.kind === 'material' &&
        accepted !== undefined &&
        published !== undefined &&
        accepted.generation === published.generation &&
        accepted.digest === published.digest &&
        accepted.outputSetDigest === published.outputSetDigest
      );
    });
  const qualitySourceVersion = (mode: 'Q3' | 'Q4') =>
    qualityMaterialRows(mode)
      .map(({ slot, handle }) => {
        const publication = assets.source(handle).unwrap()?.publication;
        return `${slot}:p${publication?.generation ?? 'missing'}:r${assets.revision(handle).unwrap()}`;
      })
      .join(',');
  return {
    handles: qualityMaterialHandles,
    accepted: qualitySourceClosureAccepted,
    version: qualitySourceVersion,
  };
}

export const finiteNumber = (value: unknown, minimum: number, maximum = Infinity) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum)
    throw new Error(`Expected a finite value in [${minimum}, ${maximum}]`);
  return number;
};
export const rgbValue = (value: MaterialValue | null | undefined) => {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value))
    throw new Error('The active material has no admitted RGB parameter');
  const rgb = Array.from(value as ArrayLike<number>).slice(0, 3);
  if (rgb.length !== 3 || !rgb.every(Number.isFinite))
    throw new Error('The active material requires three finite RGB channels');
  return rgb;
};
export const extinction = (values: Readonly<Record<string, MaterialValue | null>>) => {
  const absorption = rgbValue(values.absorptionPerM);
  const scattering = rgbValue(values.scatteringPerM);
  return absorption.reduce((sum, value, index) => sum + value + (scattering[index] ?? 0), 0) / 3;
};
export const materialControlNames = [
  'roughness',
  'specular',
  'fresnelRoughness',
  'refractionPixelNormalStrength',
  'normalStrength',
  'normalSpeed',
  'normalTilingM',
  'foamAmount',
  'foamContrast',
  'foamTilingM',
  'foamRoughness',
  'surfaceCrestFoamAmount',
  'surfaceCrestFoamCompressionMinimum',
  'surfaceCrestFoamCompressionRange',
  'sceneDepthFoamAmount',
  'sceneDepthFoamWidthM',
  'contactFoamAmount',
];

export function configurationZoneSettings(
  zone: WaterZoneSnapshot['asset'],
  mode: ConfigurationMode,
  tessellationFactor: number,
  farMaterialGuid: string | undefined,
  preset: { tessellationFactor: number; waterInfoResolution: number } | undefined,
): WaterZoneSnapshot['asset'] {
  return {
    ...zone,
    ...(farMaterialGuid === undefined ? {} : { farMaterialGuid: farMaterialGuid }),
    tessellationFactor: tessellationFactor,
    ...(mode === 'Q1'
      ? {
          tessellationFactor: 3,
          waterInfo: {
            ...zone.waterInfo,
            resolution: {
              widthPx: Math.max(1, Math.floor(zone.waterInfo.resolution.widthPx / 2)),
              heightPx: Math.max(1, Math.floor(zone.waterInfo.resolution.heightPx / 2)),
            },
          },
        }
      : {}),
    ...(mode === 'R1'
      ? {
          gpuMesh: {
            supersampling: 2 as const,
            msaaSamples: 4 as const,
            occlusion: 'disabled' as const,
          },
        }
      : {}),
    ...(preset
      ? {
          tessellationFactor: preset.tessellationFactor,
          waterInfo: {
            ...zone.waterInfo,
            resolution: {
              widthPx: preset.waterInfoResolution,
              heightPx: preset.waterInfoResolution,
            },
          },
        }
      : {}),
  };
}
