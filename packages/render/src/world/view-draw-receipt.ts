import { defineComponent, defineSystem, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { materialProgramContextKey } from '@forgeax/engine-pack';
import type { Handle } from '@forgeax/engine-types';
import {
  snapshotWaterBakedQueryLineage,
  WATER_BAKED_DESCRIPTOR_STRIDE_BYTES,
} from '@forgeax/engine-water';
import {
  appendedObservationBytes,
  MAX_INSPECTION_SAMPLES,
  MAX_RECEIPT_OBSERVATION_BYTES,
} from '../observation-budget';
import { DynamicGeometryReceipt } from '../record/dynamic-geometry-receipt';
import {
  type createPresentationDraws,
  projectDisplayRenderables,
} from '../render-system-presentation';
import { EMPTY_FRAME_ROWS, sparseRowsOf } from '../scene/frame-list';
import {
  DynamicGeometryCommitOrder,
  DynamicGeometryResetOrder,
  RenderRecordCommitOrder,
  RenderViewFrameOrder,
  TerrainReceiptCommitOrder,
  TerrainReceiptDiscardOrder,
  ViewTerrainCandidateOrder,
} from '../system-order';
import { captureSubmittedTerrain, type SubmittedTerrainSection } from '../terrain/submitted.js';
import { MaterialDrawReceipt } from './material-draw-receipt';
import { ViewRecorder, ViewSubmission, viewAccepted } from './render-views';
import { RenderCleanup, RenderCommit, RenderPrepare, renderSubmission } from './render-world';

import { readViewState, requireViewField } from './view-field';
import { stagedViewInputs, ViewFrame, type ViewFrameState } from './view-frame-systems';

/** The terrain sections a view's frame could draw, with the world keys their draws are named by. */
export interface TerrainCandidate {
  readonly sections: readonly SubmittedTerrainSection[];
}

/** Immutable Baked source rows used by one submitted Water material draw. */
export interface WaterBakedSourceDrawReceipt {
  readonly worldIdentity: string;
  readonly bodyIndex: number;
  readonly bodyGuid: string;
  readonly bodyGeneration: number;
  readonly zoneGeneration: number;
  readonly descriptorRange: readonly [number, number];
  readonly sampleRange: readonly [number, number];
  readonly binding: Readonly<{
    readonly drawDataRowOffset: number;
    readonly descriptorBufferIdentity: number;
    readonly descriptorBufferByteLength: number;
    readonly sampleBufferIdentity: number;
    readonly sampleBufferByteLength: number;
    readonly complete: boolean;
    readonly viewIdentity: string;
    readonly frameGeneration: number;
    readonly deviceGeneration: number;
  }>;
  readonly lineage?: import('@forgeax/engine-water').WaterBakedQueryLineage;
}

export interface WaterBakedDrawBindingReceipt {
  readonly viewIdentity: string;
  readonly frameGeneration: number;
  readonly deviceGeneration: number;
  readonly drawDataBufferIdentity: number;
  readonly drawDataDynamicOffset: number;
  readonly waterInfoDynamicOffset?: number;
  readonly waterMeshInstanceDynamicOffset: number;
  readonly waterMeshInstanceBufferIdentity: number;
  readonly waterMeshInstanceBufferByteLength: number;
  readonly waterMeshInstanceRange: readonly [number, number];
  readonly bakedDescriptorBufferIdentity: number;
  readonly bakedSamplesBufferIdentity: number;
}

/** Actual Water draw identity captured after its draw command was submitted. */
export interface WaterBakedDrawReceiptFact {
  readonly entityKey: number;
  readonly submeshIndex: number;
  readonly materialSlot: number;
  readonly viewIdentity: string;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
  readonly drawKey: string;
  readonly ownerWorldIdentity: string;
  readonly materialWorldIdentity?: string;
  readonly drawBinding?: WaterBakedDrawBindingReceipt;
  readonly materialIdentity: Readonly<{
    readonly materialGuid: string;
    readonly publicationGeneration: number;
    readonly specializationKey?: string;
    readonly artifactHash?: string;
    readonly programKey?: string;
  }>;
  readonly programIdentity?: Readonly<{
    readonly pass: string;
    readonly context: import('@forgeax/engine-pack').MaterialCookProgramContext;
    readonly address: 'direct';
    readonly specializationKey: string;
    readonly artifactHash: string;
  }>;
  readonly sourceBodyIndices: readonly number[];
  readonly sources?: readonly WaterBakedSourceDrawReceipt[];
  readonly availability?:
    | Readonly<{ status: 'complete' }>
    | Readonly<{
        status: 'unavailable';
        reason: WaterBakedDrawUnavailableReason;
      }>;
}

const WATER_BAKED_DRAW_UNAVAILABLE_REASONS = [
  'view-identity-missing',
  'view-mismatch',
  'frame-mismatch',
  'device-generation-mismatch',
  'graph-generation-mismatch',
  'draw-identity-missing',
  'material-identity-missing',
  'source-identity-incomplete',
  'source-lineage-unavailable',
] as const;
type WaterBakedDrawUnavailableReason = (typeof WATER_BAKED_DRAW_UNAVAILABLE_REASONS)[number];

type WaterBakedDrawExpected = Readonly<{
  readonly viewIdentity?: string;
  readonly deviceGeneration?: number;
  readonly graphGeneration?: number;
}>;

function waterBakedDrawUnavailableReason(
  frame: number,
  draw: WaterBakedDrawReceiptFact,
  expected: WaterBakedDrawExpected,
): WaterBakedDrawUnavailableReason | undefined {
  if (expected.viewIdentity === undefined) return 'view-identity-missing';
  if (draw.viewIdentity !== expected.viewIdentity) return 'view-mismatch';
  if (draw.frameId !== frame) return 'frame-mismatch';
  if (
    expected.deviceGeneration === undefined ||
    draw.deviceGeneration !== expected.deviceGeneration
  )
    return 'device-generation-mismatch';
  if (expected.graphGeneration === undefined || draw.graphGeneration !== expected.graphGeneration)
    return 'graph-generation-mismatch';
  if (draw.drawKey.length === 0) return 'draw-identity-missing';
  const binding = draw.drawBinding;
  const invalidBakedMeshInstanceRange = (binding: WaterBakedDrawBindingReceipt) =>
    binding.waterMeshInstanceDynamicOffset !== binding.waterMeshInstanceRange[0] ||
    !Number.isSafeInteger(binding.waterMeshInstanceBufferByteLength) ||
    binding.waterMeshInstanceBufferByteLength <= 0 ||
    (binding.waterInfoDynamicOffset !== undefined &&
      (!Number.isSafeInteger(binding.waterInfoDynamicOffset) ||
        binding.waterInfoDynamicOffset < 0)) ||
    binding.waterMeshInstanceRange[0] < 0 ||
    binding.waterMeshInstanceRange[1] <= binding.waterMeshInstanceRange[0] ||
    binding.waterMeshInstanceRange[1] > binding.waterMeshInstanceBufferByteLength;
  const invalidBakedBufferIdentities = (binding: WaterBakedDrawBindingReceipt) =>
    !Number.isSafeInteger(binding.drawDataBufferIdentity) ||
    binding.drawDataBufferIdentity <= 0 ||
    !Number.isSafeInteger(binding.waterMeshInstanceBufferIdentity) ||
    binding.waterMeshInstanceBufferIdentity <= 0 ||
    !Number.isSafeInteger(binding.bakedDescriptorBufferIdentity) ||
    binding.bakedDescriptorBufferIdentity <= 0 ||
    !Number.isSafeInteger(binding.bakedSamplesBufferIdentity) ||
    binding.bakedSamplesBufferIdentity <= 0;
  if (
    binding === undefined ||
    binding.viewIdentity !== draw.viewIdentity ||
    binding.frameGeneration !== draw.frameId ||
    binding.deviceGeneration !== draw.deviceGeneration ||
    !Number.isSafeInteger(binding.drawDataDynamicOffset) ||
    binding.drawDataDynamicOffset < 0 ||
    invalidBakedMeshInstanceRange(binding) ||
    invalidBakedBufferIdentities(binding)
  )
    return 'source-identity-incomplete';
  const invalidBakedMaterialIdentity = () =>
    draw.materialIdentity.materialGuid.length === 0 ||
    !Number.isSafeInteger(draw.materialIdentity.publicationGeneration) ||
    draw.materialIdentity.publicationGeneration < 0 ||
    draw.materialIdentity.specializationKey === undefined ||
    draw.materialIdentity.artifactHash === undefined ||
    draw.materialIdentity.programKey === undefined ||
    draw.programIdentity === undefined ||
    draw.programIdentity.pass.length === 0 ||
    draw.programIdentity.address !== 'direct' ||
    draw.programIdentity.specializationKey !== draw.materialIdentity.programKey ||
    draw.programIdentity.artifactHash.length === 0;
  if (invalidBakedMaterialIdentity()) return 'material-identity-missing';
  const validateBakedDrawSources = (binding: WaterBakedDrawBindingReceipt) => {
    const sources = draw.sources;
    const invalidBakedSourceRanges = (source: WaterBakedSourceDrawReceipt) =>
      source.sampleRange[0] < 0 ||
      source.sampleRange[1] <= source.sampleRange[0] ||
      source.sampleRange[0] % 16 !== 0 ||
      source.sampleRange[1] % 16 !== 0 ||
      source.sampleRange[1] > source.binding.sampleBufferByteLength ||
      source.descriptorRange[1] > source.binding.descriptorBufferByteLength;
    const invalidBakedSourceBufferIdentities = (
      source: WaterBakedSourceDrawReceipt,
      binding: WaterBakedDrawBindingReceipt,
    ) =>
      !Number.isSafeInteger(source.binding.drawDataRowOffset) ||
      source.binding.drawDataRowOffset < 0 ||
      source.binding.complete !== true ||
      source.binding.descriptorBufferIdentity !== binding.bakedDescriptorBufferIdentity ||
      source.binding.sampleBufferIdentity !== binding.bakedSamplesBufferIdentity ||
      !Number.isSafeInteger(source.binding.descriptorBufferIdentity) ||
      source.binding.descriptorBufferIdentity <= 0 ||
      !Number.isSafeInteger(source.binding.sampleBufferIdentity) ||
      source.binding.sampleBufferIdentity <= 0;
    if (
      draw.sourceBodyIndices.length === 0 ||
      draw.ownerWorldIdentity.length === 0 ||
      draw.materialWorldIdentity === undefined ||
      draw.materialWorldIdentity.length === 0 ||
      !draw.sourceBodyIndices.every((index) => Number.isSafeInteger(index) && index >= 0) ||
      new Set(draw.sourceBodyIndices).size !== draw.sourceBodyIndices.length ||
      sources === undefined ||
      sources.length !== draw.sourceBodyIndices.length ||
      sources.some(
        (source, index) =>
          source === undefined ||
          source.bodyIndex !== draw.sourceBodyIndices[index] ||
          source.worldIdentity.length === 0 ||
          source.worldIdentity !== draw.ownerWorldIdentity ||
          source.bodyGuid.length === 0 ||
          !Number.isSafeInteger(source.bodyGeneration) ||
          source.bodyGeneration < 0 ||
          !Number.isSafeInteger(source.zoneGeneration) ||
          source.zoneGeneration < 0 ||
          source.descriptorRange[0] < 0 ||
          source.descriptorRange[1] <= source.descriptorRange[0] ||
          source.descriptorRange[1] - source.descriptorRange[0] !==
            WATER_BAKED_DESCRIPTOR_STRIDE_BYTES ||
          invalidBakedSourceRanges(source) ||
          invalidBakedSourceBufferIdentities(source, binding) ||
          source.binding.viewIdentity !== draw.viewIdentity ||
          source.binding.frameGeneration !== draw.frameId ||
          source.binding.deviceGeneration !== draw.deviceGeneration,
      )
    )
      return 'source-identity-incomplete';
    if (sources[0]?.binding.drawDataRowOffset !== binding.drawDataDynamicOffset)
      return 'source-identity-incomplete';
    if (
      sources.some((source) => {
        const lineage = snapshotWaterBakedQueryLineage(source.lineage);
        return lineage === undefined || lineage.textureRevision === undefined;
      })
    )
      return 'source-lineage-unavailable';
    return undefined;
  };
  return validateBakedDrawSources(binding);
}

function freezeWaterBakedDraw(draw: WaterBakedDrawReceiptFact): WaterBakedDrawReceiptFact {
  return Object.freeze({
    ...draw,
    materialIdentity: Object.freeze({ ...draw.materialIdentity }),
    sourceBodyIndices: Object.freeze([...draw.sourceBodyIndices]),
    ...(draw.programIdentity === undefined
      ? {}
      : {
          programIdentity: Object.freeze({
            ...draw.programIdentity,
            context: Object.freeze({ ...draw.programIdentity.context }),
          }),
        }),
    ...(draw.drawBinding === undefined
      ? {}
      : {
          drawBinding: Object.freeze({
            ...draw.drawBinding,
            waterMeshInstanceRange: Object.freeze([
              ...draw.drawBinding.waterMeshInstanceRange,
            ]) as readonly [number, number],
          }),
        }),
    ...(draw.availability === undefined
      ? {}
      : { availability: Object.freeze({ ...draw.availability }) }),
    ...(draw.sources === undefined
      ? {}
      : {
          sources: Object.freeze(
            draw.sources.map((source) => {
              const lineage = snapshotWaterBakedQueryLineage(source.lineage);
              return Object.freeze({
                worldIdentity: source.worldIdentity,
                bodyIndex: source.bodyIndex,
                bodyGuid: source.bodyGuid,
                bodyGeneration: source.bodyGeneration,
                zoneGeneration: source.zoneGeneration,
                descriptorRange: Object.freeze([...source.descriptorRange]) as readonly [
                  number,
                  number,
                ],
                sampleRange: Object.freeze([...source.sampleRange]) as readonly [number, number],
                binding: Object.freeze({ ...source.binding }),
                ...(lineage === undefined ? {} : { lineage }),
              });
            }),
          ),
        }),
  });
}

/** Same per-slot draw closure across submeshes can share one receipt. */
export function waterBakedDrawClosureKey(draw: WaterBakedDrawReceiptFact): string {
  const { submeshIndex, programIdentity, ...closure } = draw;
  void submeshIndex;
  return JSON.stringify({
    ...closure,
    ...(programIdentity === undefined
      ? {}
      : {
          programIdentity: {
            pass: programIdentity.pass,
            contextKey: materialProgramContextKey(programIdentity.context),
            address: programIdentity.address,
            specializationKey: programIdentity.specializationKey,
            artifactHash: programIdentity.artifactHash,
          },
        }),
  });
}

/** Capture the staged view's terrain sections; never throws, undefined on failure. */
function captureTerrain(world: World, staged: ViewFrameState): TerrainCandidate | undefined {
  try {
    const { frame, cameras, source: resourceWorld } = stagedViewInputs(world, staged);
    // A GPU-owned frame derives its display rows from the submitted selection and a
    // cameraless frame draws nothing: neither carries terrain.
    const noTerrain =
      cameras.length === 0 ||
      frame.gpuOwned !== undefined ||
      sparseRowsOf(frame.renderables, 'terrain') === EMPTY_FRAME_ROWS;
    return {
      // `commit` keeps only the sections the accepted attempt presented, culled or not.
      sections: noTerrain
        ? []
        : captureSubmittedTerrain(
            projectDisplayRenderables(frame.renderables, frame.dispatch, undefined, 'terrain'),
            resourceWorld,
          ),
    };
  } catch {
    return undefined;
  }
}

/** What one view's submitted frame published: dynamic-geometry draws and terrain sections. */
export class ViewDrawReceipt {
  readonly dynamicGeometry = new DynamicGeometryReceipt();
  /** Material closures consumed by the last accepted attempt's actual draws. */
  readonly materials = new MaterialDrawReceipt();
  /** The terrain sections the last accepted attempt actually drew. */
  terrain: readonly SubmittedTerrainSection[] = [];
  /** The Water Baked sources used by the last accepted attempt's actual draws. */
  waterBakedDraws: readonly WaterBakedDrawReceiptFact[] = [];
  waterBakedUnavailableReason: 'snapshot-too-large' | undefined;
  private waterBakedStage:
    | {
        readonly frame: number;
        readonly draws: WaterBakedDrawReceiptFact[];
        readonly keys: Set<string>;
        bytes: number;
        overflow: boolean;
      }
    | undefined;
  private terrainStage:
    | {
        readonly frame: number;
        /** Undefined when the capture failed: nothing is published for this frame. */
        readonly candidate: TerrainCandidate | undefined;
        presented?: ReturnType<typeof createPresentationDraws>;
      }
    | undefined;

  /** RenderPrepare: the sections the view's frame could draw, or undefined when capture failed. */
  stageTerrainCandidate(frame: number, candidate: TerrainCandidate | undefined): void {
    this.terrainStage = { frame, candidate };
  }

  /** Record time: the attempt's presentation is ready; these are its actual draws. */
  stageTerrainPresented(presented: ReturnType<typeof createPresentationDraws>): void {
    if (this.terrainStage !== undefined) this.terrainStage.presented = presented;
  }

  /** The accepted attempt's presented sections become the submitted receipt. */
  commitTerrain(frame: number): void {
    const stage = this.terrainStage;
    this.terrainStage = undefined;
    const presented = stage?.presented;
    if (stage?.frame !== frame || stage.candidate === undefined || presented === undefined) return;
    const { sections } = stage.candidate;
    this.terrain = sections.filter((section) =>
      presented.hasTerrain(section.entity, section.section),
    );
  }

  /** A rejected attempt publishes nothing; the previous receipt is kept. */
  discardTerrain(): void {
    this.terrainStage = undefined;
  }

  /** Capture immutable source facts from one actual Water draw callback. */
  stageWaterBakedDraw(
    frame: number,
    draw: WaterBakedDrawReceiptFact,
    expected?: WaterBakedDrawExpected,
  ): void {
    if (this.waterBakedStage?.frame !== frame)
      this.waterBakedStage = { frame, draws: [], keys: new Set(), bytes: 2, overflow: false };
    const stage = this.waterBakedStage;
    if (stage.overflow) return;
    const reason =
      expected === undefined ? undefined : waterBakedDrawUnavailableReason(frame, draw, expected);
    const frozen = freezeWaterBakedDraw(
      reason === undefined
        ? expected === undefined
          ? draw
          : { ...draw, availability: { status: 'complete' } }
        : { ...draw, availability: { status: 'unavailable', reason } },
    );
    const signature = waterBakedDrawClosureKey(frozen);
    if (stage.keys.has(signature)) return;
    if (stage.draws.length < MAX_INSPECTION_SAMPLES)
      stage.bytes = appendedObservationBytes(stage.bytes, frozen);
    if (
      stage.draws.length >= MAX_INSPECTION_SAMPLES ||
      stage.bytes > MAX_RECEIPT_OBSERVATION_BYTES
    ) {
      stage.draws.length = 0;
      stage.keys.clear();
      stage.overflow = true;
      return;
    }
    stage.keys.add(signature);
    stage.draws.push(frozen);
  }

  /** Promote only this accepted attempt's draws; an accepted empty frame clears the old receipt. */
  commitWaterBakedDraws(frame: number): void {
    const stage = this.waterBakedStage;
    this.waterBakedStage = undefined;
    const acceptedStage = stage?.frame === frame ? stage : undefined;
    this.waterBakedDraws = Object.freeze(acceptedStage?.draws ?? []);
    this.waterBakedUnavailableReason = acceptedStage?.overflow ? 'snapshot-too-large' : undefined;
  }

  /** Rejected attempts publish nothing and clear the previous attempt's draw receipt. */
  discardWaterBakedDraws(): void {
    this.waterBakedStage = undefined;
    this.waterBakedDraws = Object.freeze([]);
    this.waterBakedUnavailableReason = undefined;
  }
}

/** The view's submitted-draw receipt; it lives and dies with the view entity. */
export const ViewDraws = defineComponent('ViewDraws', { state: 'unique<ViewDrawReceipt>' });

export const DYNAMIC_GEOMETRY_COMMIT_SYSTEM = 'dynamic-geometry-commit';
export const DYNAMIC_GEOMETRY_RESET_SYSTEM = 'dynamic-geometry-reset';
export const VIEW_TERRAIN_CANDIDATE_SYSTEM = 'view-terrain-candidate';
export const TERRAIN_COMMIT_SYSTEM = 'terrain-receipt-commit';
export const TERRAIN_DISCARD_SYSTEM = 'terrain-receipt-discard';

/** Give a view entity its receipt; idempotent. */
export function adoptViewDraws(world: World, entity: EntityHandle): void {
  if (world.hasComponent(entity, ViewDraws)) return;
  const state = world.allocUniqueRef('ViewDrawReceipt', new ViewDrawReceipt());
  world.addComponent(entity, { component: ViewDraws, data: { state } }).unwrap();
}

/** The receipt of a view entity, or undefined when it has none (no view, or retired). */
export function viewDrawReceipt(
  world: World,
  entity: EntityHandle | undefined,
): ViewDrawReceipt | undefined {
  return readViewState<ViewDrawReceipt>(world, entity, ViewDraws);
}

/**
 * A view's own attempt of this frame decides its receipt: accepted promotes the
 * draws it recorded, rejected clears them. A held view (no attempt this frame)
 * keeps the receipt of its last attempt.
 */
export function registerViewDrawSystems(world: World): void {
  world
    .addSystem(
      RenderCommit,
      defineSystem({
        sets: [DynamicGeometryCommitOrder],
        commands: 'none',
        name: DYNAMIC_GEOMETRY_COMMIT_SYSTEM,
        queries: [{ read: [ViewSubmission, ViewDraws] }],
        fn: (world, [views]) => {
          const frame = renderSubmission(world).frame;

          views.forEach((row) => {
            const entity = row.entity;

            if (
              !requireViewField(world, entity, ViewSubmission, 'accepted') ||
              requireViewField(world, entity, ViewSubmission, 'attempt') !== frame
            )
              return;
            const receipt = draws(world, requireViewField(world, entity, ViewDraws, 'state'));
            receipt.dynamicGeometry.commit();
            receipt.commitWaterBakedDraws(frame);
            receipt.materials.commit(frame);
          });
        },
      }),
    )
    .unwrap();
  world
    .addSystem(
      RenderPrepare,
      defineSystem({
        sets: [ViewTerrainCandidateOrder],
        commands: 'none',
        name: VIEW_TERRAIN_CANDIDATE_SYSTEM,
        after: [RenderViewFrameOrder],
        queries: [{ read: [ViewRecorder, ViewFrame, ViewDraws] }],
        fn: (world, [views]) => {
          const frame = renderSubmission(world).frame;

          views.forEach((row) => {
            const entity = row.entity;

            const staged = world
              .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
              .unwrap();
            // A held view records nothing; a failed frame is its recording's recovery.
            if (staged.frame !== frame || staged.result?.ok !== true || staged.mode === false)
              return;
            draws(world, requireViewField(world, entity, ViewDraws, 'state')).stageTerrainCandidate(
              frame,
              captureTerrain(world, staged),
            );
          });
        },
      }),
    )
    .unwrap();
  world
    .addSystem(
      RenderCommit,
      defineSystem({
        sets: [TerrainReceiptCommitOrder],
        commands: 'none',
        name: TERRAIN_COMMIT_SYSTEM,
        queries: [{ read: [ViewSubmission, ViewDraws] }],
        after: [RenderRecordCommitOrder],
        fn: (world, [views]) => {
          const frame = renderSubmission(world).frame;

          views.forEach((row) => {
            const entity = row.entity;

            if (!viewAccepted(world, entity)) return;
            draws(world, requireViewField(world, entity, ViewDraws, 'state')).commitTerrain(frame);
          });
        },
      }),
    )
    .unwrap();
  world
    .addSystem(
      RenderCleanup,
      defineSystem({
        sets: [TerrainReceiptDiscardOrder],
        commands: 'none',
        name: TERRAIN_DISCARD_SYSTEM,
        queries: [{ read: [ViewSubmission, ViewDraws] }],
        fn: (world, [views]) => {
          const frame = renderSubmission(world).frame;

          views.forEach((row) => {
            const entity = row.entity;

            if (
              requireViewField(world, entity, ViewSubmission, 'accepted') ||
              requireViewField(world, entity, ViewSubmission, 'attempt') !== frame
            )
              return;
            draws(world, requireViewField(world, entity, ViewDraws, 'state')).discardTerrain();
          });
        },
      }),
    )
    .unwrap();
  world
    .addSystem(
      RenderCleanup,
      defineSystem({
        sets: [DynamicGeometryResetOrder],
        commands: 'none',
        name: DYNAMIC_GEOMETRY_RESET_SYSTEM,
        queries: [{ read: [ViewSubmission, ViewDraws] }],
        fn: (world, [views]) => {
          const frame = renderSubmission(world).frame;

          views.forEach((row) => {
            const entity = row.entity;

            if (
              requireViewField(world, entity, ViewSubmission, 'accepted') ||
              requireViewField(world, entity, ViewSubmission, 'attempt') !== frame
            )
              return;
            const receipt = draws(world, requireViewField(world, entity, ViewDraws, 'state'));
            receipt.dynamicGeometry.clear();
            receipt.discardWaterBakedDraws();
            receipt.materials.discard();
          });
        },
      }),
    )
    .unwrap();
}

function draws(world: World, state: Handle<string, 'unique'>): ViewDrawReceipt {
  return world.resolveUniqueRef<ViewDrawReceipt>(state).unwrap();
}
