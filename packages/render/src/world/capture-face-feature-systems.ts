import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { PlanarCaptureState } from '../capture/planar-state';
import { PlanarTargetLease } from '../capture/planar-target';
import type { RenderFeatureFrameInput, RenderFeaturePlanExecution } from '../features/host';
import { getRenderFeaturePlanExecutionProjection } from '../features/host';
import { createRenderFeatureTarget, type RenderFeatureTargetHandle } from '../features/targets';
import type { CaptureFaceFeatureWork } from '../record/target-capture-graph';
import type { CameraSnapshot } from '../render-contract';
import { projectAuxiliaryCamerasForView } from '../render-system-extract';
import { featureCameraSelection } from '../render-system-projections';
import {
  featureFrameOutcome,
  RENDER_CAPTURE_FACE_INPUTS_SYSTEM,
  RENDER_FEATURE_VIEWS_SYSTEM,
  stageCaptureFaceInputs,
  viewFeatureFrameResult,
  viewFeatureInputOf,
} from './feature-systems';
import { ViewRecorder } from './render-views';
import { RenderPrepare, renderSubmission } from './render-world';
import { requireViewField } from './view-field';
import { stagedViewInputs, ViewFrame, type ViewFrameState } from './view-frame-systems';
import { recordContext } from './view-record-context';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';

/** The Feature view identity of a display camera's planar mirror face. */
export function planarFaceIdentity(display: Pick<CameraSnapshot, 'entityKey'> | undefined): string {
  return `renderer:capture:planar:${display?.entityKey ?? 0}`;
}

const faceTargetCache = new Map<string, readonly RenderFeatureTargetHandle[]>();

/** The logical color and depth targets a planar face exposes to Features. */
function faceTargets(format: string): readonly RenderFeatureTargetHandle[] {
  let targets = faceTargetCache.get(format);
  if (targets === undefined) {
    targets = Object.freeze([
      createRenderFeatureTarget({
        name: 'color',
        kind: 'scene-color',
        format: format as RenderFeatureTargetHandle['format'],
        sampleCount: 1,
      }),
      createRenderFeatureTarget({
        name: 'depth',
        kind: 'scene-depth',
        format: 'depth32float-stencil8',
        sampleCount: 1,
      }),
    ]);
    faceTargetCache.set(format, targets);
  }
  return targets;
}

/**
 * The display view's planar face as a Feature view, or undefined when the
 * view has no mirror this frame. `render` follows the mirror cadence so a
 * skipped frame plans no Feature work for the face.
 */
function planarFaceInput(
  world: World,
  entity: EntityHandle,
  staged: ViewFrameState,
  owner: ViewSettlementOwner,
): RenderFeatureFrameInput | undefined {
  const base = viewFeatureInputOf(world, entity);
  if (base?.kind !== 'prepared' || base.value.input === undefined) return undefined;
  if (staged.result?.ok !== true || staged.mode !== true) return undefined;
  const view = stagedViewInputs(world, staged);
  const { internals, captures, frameState } = owner;
  const display = view.cameras[0];
  if (display === undefined || view.frame.auxiliaryCameras.length === 0) return undefined;
  captures.planarTarget ??= new PlanarTargetLease();
  const camera = projectAuxiliaryCamerasForView(
    display,
    captures.planarTarget.resolve(
      internals.ownedRenderTargets,
      display,
      view.frame.auxiliaryCameras,
      recordContext(internals).canvas,
    ),
  ).find((candidate) => candidate.planarReflection !== undefined);
  const physical =
    camera?.target === undefined ? undefined : internals.getRenderTargetPhysical?.(camera.target);
  if (camera?.target === undefined || camera.planarReflection === undefined) return undefined;
  if (physical === undefined || physical.descriptor.shape !== '2d') return undefined;
  captures.planar ??= new PlanarCaptureState();
  const due = captures.planar.isDue(camera, physical, frameState.frameNumber);
  return {
    ...base.value.input,
    identity: planarFaceIdentity(display),
    captureKind: 'planar',
    render: due,
    targets: faceTargets(physical.descriptor.format),
    frameSize: { width: physical.descriptor.width, height: physical.descriptor.height },
    ...featureCameraSelection(camera),
  };
}

/** The sealed Feature plans of the planar face `identity`, as the face graph projects them. */
export function planarFaceFeatureWork(
  world: World,
  display: Pick<CameraSnapshot, 'entityKey'> | undefined,
): CaptureFaceFeatureWork | undefined {
  const outcome = featureFrameOutcome(world);
  if (outcome?.kind !== 'sealed') return undefined;
  const plans = viewFeatureFrameResult(outcome, planarFaceIdentity(display))?.plans ?? [];
  const executions = plans
    .map(getRenderFeaturePlanExecutionProjection)
    .filter((execution): execution is RenderFeaturePlanExecution => execution !== undefined);
  return executions.length === 0 ? undefined : { executions, plans };
}

/**
 * Register `render-capture-face-inputs` (RenderPrepare): each display view's
 * planar mirror becomes a Feature view of the frame about to open, so
 * Features whose capture policy admits `planar` plan work for it.
 * `render-feature-open` merges these inputs after the display views'.
 */
export function registerCaptureFaceFeatureSystem(world: World): void {
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_CAPTURE_FACE_INPUTS_SYSTEM,
      after: [RENDER_FEATURE_VIEWS_SYSTEM],
      queries: [{ read: [ViewRecorder, ViewFrame] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;
        const inputs: RenderFeatureFrameInput[] = [];
        rows.forEach((row) => {
          const entity = row.entity;
          const staged = world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap();
          if (staged.frame !== frame) return;
          try {
            const input = planarFaceInput(
              world,
              entity,
              staged,
              ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
            );
            if (input !== undefined) inputs.push(input);
          } catch {
            // The face is optional Feature work; the capture schedule reports mirror failures.
          }
        });
        stageCaptureFaceInputs(world, inputs);
      },
    })
    .unwrap();
}
