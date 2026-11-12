import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { Handle } from '@forgeax/engine-types';
import { DynamicGeometryReceipt } from '../record/dynamic-geometry-receipt';
import { worldEntityKey } from '../record/frame-snapshot';
import type { createPresentationDraws } from '../render-system-presentation';
import { projectDisplayRenderables } from '../render-system-presentation';
import { captureSubmittedTerrain, type SubmittedTerrainSection } from '../terrain/submitted.js';
import { ViewRecorder, ViewSubmission, viewAccepted } from './render-views';
import { RenderCleanup, RenderCommit, RenderPrepare, renderSubmission } from './render-world';
import { RENDER_RECORD_COMMIT_SYSTEM } from './submission-systems';
import { requireViewField } from './view-field';
import {
  RENDER_VIEW_FRAME_SYSTEM,
  stagedViewInputs,
  ViewFrame,
  type ViewFrameState,
} from './view-frame-systems';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';

/** The terrain sections a view's frame could draw, with the world keys their draws are named by. */
export interface TerrainCandidate {
  readonly sections: readonly SubmittedTerrainSection[];
  readonly worldKeys: readonly number[];
}

/** Capture the staged view's terrain sections; never throws, undefined on failure. */
function captureTerrain(
  world: World,
  staged: ViewFrameState,
  owner: ViewSettlementOwner,
): TerrainCandidate | undefined {
  try {
    const { frame, cameras, scopes } = stagedViewInputs(world, staged);
    // A GPU-owned frame derives its display rows from the submitted selection and a
    // cameraless frame draws nothing: neither carries terrain.
    const drawn = cameras.length === 0 || frame.gpuOwned !== undefined;
    return {
      // `commit` keeps only the sections the accepted attempt presented, culled or not.
      sections: drawn
        ? []
        : captureSubmittedTerrain(
            projectDisplayRenderables(frame.renderables, frame.dispatch),
            scopes,
          ),
      worldKeys: owner.scene.visibilityWorldKeysFor(scopes),
    };
  } catch {
    return undefined;
  }
}

/** What one view's submitted frame published: dynamic-geometry draws and terrain sections. */
export class ViewDrawReceipt {
  readonly dynamicGeometry = new DynamicGeometryReceipt();
  /** The terrain sections the last accepted attempt actually drew. */
  terrain: readonly SubmittedTerrainSection[] = [];
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
    const { sections, worldKeys } = stage.candidate;
    this.terrain = sections.filter((section) =>
      presented.hasTerrain(
        worldEntityKey(worldKeys[section.worldId] ?? section.worldId, section.entity),
        section.section,
      ),
    );
  }

  /** A rejected attempt publishes nothing; the previous receipt is kept. */
  discardTerrain(): void {
    this.terrainStage = undefined;
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
  if (entity === undefined || !world.hasComponent(entity, ViewDraws)) return undefined;
  return world
    .resolveUniqueRef<ViewDrawReceipt>(requireViewField(world, entity, ViewDraws, 'state'))
    .unwrap();
}

/**
 * A view's own attempt of this frame decides its receipt: accepted promotes the
 * draws it recorded, rejected clears them. A held view (no attempt this frame)
 * keeps the receipt of its last attempt.
 */
export function registerViewDrawSystems(world: World): void {
  world
    .addSystem(RenderCommit, {
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
          draws(
            world,
            requireViewField(world, entity, ViewDraws, 'state'),
          ).dynamicGeometry.commit();
        });
      },
    })
    .unwrap();
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: VIEW_TERRAIN_CANDIDATE_SYSTEM,
      after: [RENDER_VIEW_FRAME_SYSTEM],
      queries: [{ read: [ViewRecorder, ViewFrame, ViewDraws] }],
      fn: (world, [views]) => {
        const frame = renderSubmission(world).frame;

        views.forEach((row) => {
          const entity = row.entity;

          const staged = world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap();
          // A held view records nothing; a failed frame is its recording's recovery.
          if (staged.frame !== frame || staged.result?.ok !== true || staged.mode === false) return;
          draws(world, requireViewField(world, entity, ViewDraws, 'state')).stageTerrainCandidate(
            frame,
            captureTerrain(
              world,
              staged,
              ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
            ),
          );
        });
      },
    })
    .unwrap();
  world
    .addSystem(RenderCommit, {
      commands: 'none',
      name: TERRAIN_COMMIT_SYSTEM,
      queries: [{ read: [ViewSubmission, ViewDraws] }],
      after: [RENDER_RECORD_COMMIT_SYSTEM],
      fn: (world, [views]) => {
        const frame = renderSubmission(world).frame;

        views.forEach((row) => {
          const entity = row.entity;

          if (!viewAccepted(world, entity)) return;
          draws(world, requireViewField(world, entity, ViewDraws, 'state')).commitTerrain(frame);
        });
      },
    })
    .unwrap();
  world
    .addSystem(RenderCleanup, {
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
    })
    .unwrap();
  world
    .addSystem(RenderCleanup, {
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
          draws(world, requireViewField(world, entity, ViewDraws, 'state')).dynamicGeometry.clear();
        });
      },
    })
    .unwrap();
}

function draws(world: World, state: Handle<string, 'unique'>): ViewDrawReceipt {
  return world.resolveUniqueRef<ViewDrawReceipt>(state).unwrap();
}
