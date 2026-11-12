import type { World } from '@forgeax/engine-ecs';
import type { Texture } from '@forgeax/engine-rhi';
import { createViewCompositor } from '../assembly/view-compositor';
import type { StereoEye } from '../components/stereo-camera';
import type { RenderSystemInternals } from '../record/render-context';
import type { CubeCaptureGraphState } from '../record/target-capture-graph';
import { createRenderViewOwner } from '../render-system';
import { seedViewConfiguration } from '../view-configuration';
import { adoptViewRecordHistory } from './record-history';
import { ViewRecorder } from './render-views';
import { adoptViewDraws } from './view-draw-receipt';
import {
  type ViewRecorderFactory,
  type ViewRecorderState,
  viewChannels,
} from './view-output-systems';
import { adoptViewPointsLines } from './view-points-lines';
import { ViewRecordContext, ViewRecordContextState } from './view-record-context';
import type { ViewSettlementOwner } from './view-settlement';

/** Allocate component-owned view bindings and owner state, never a frame facade. */
export function createViewRecorder(
  renderWorld: World,
  internals: RenderSystemInternals,
  primaryOwner: ViewSettlementOwner,
  retire: (view: ViewRecorderState) => void,
  ...[entity, facts, target, viewport, base]: Parameters<ViewRecorderFactory>
): ViewRecorderState {
  const camera = facts.camera;
  const eye = [undefined, 'left', 'right'][facts.eye] as StereoEye | undefined;
  const key = facts.capture
    ? `capture:${camera}`
    : eye === undefined
      ? String(camera)
      : `${camera}:${eye}`;
  const scope = internals.deviceScope.createChild(`camera:${key}`);
  const capture: CubeCaptureGraphState | undefined = facts.capture ? { work: [] } : undefined;
  try {
    const context = new ViewRecordContextState(
      internals,
      entity,
      scope,
      camera,
      viewport,
      base,
      capture,
      target,
    );
    if (renderWorld.hasComponent(entity, ViewRecordContext))
      renderWorld.removeComponent(entity, ViewRecordContext).unwrap();
    const state = renderWorld.allocUniqueRef('ViewRecordContext', context);
    renderWorld.addComponent(entity, { component: ViewRecordContext, data: { state } }).unwrap();
    // Shared renderer services are inherited live. Only view identity and local owners are private.
    const recordInternals: RenderSystemInternals = Object.assign(Object.create(internals), {
      viewEntity: entity,
      viewContext: context,
      observationGraphGeneration: undefined,
    });
    const viewOwner = createRenderViewOwner(recordInternals);
    seedViewConfiguration(primaryOwner, viewOwner);
    const view: ViewRecorderState = {
      entity,
      capture,
      captureSize: { width: 1, height: 1 },
      key,
      camera,
      eye,
      device: internals.device,
      scope,
      owner: viewOwner,
      composite: createViewCompositor(internals),
      viewport,
      target,
      output: undefined,
      picture: {
        texture: undefined as unknown as Texture,
        viewport,
        channels: viewChannels(facts.channels),
      },
      renderedFrames: 0,
      lastFrame: -Infinity,
      rendered: false,
      retired: false,
    };
    const recorderState = renderWorld.allocUniqueRef('ViewRecorder', view, retire);
    renderWorld
      .addComponent(entity, { component: ViewRecorder, data: { state: recorderState } })
      .unwrap();
    adoptViewDraws(renderWorld, entity);
    adoptViewRecordHistory(renderWorld, entity);
    adoptViewPointsLines(renderWorld, entity, recordInternals);
    return view;
  } catch (cause) {
    if (renderWorld.hasComponent(entity, ViewRecordContext))
      renderWorld.removeComponent(entity, ViewRecordContext).unwrap();
    scope.dispose();
    throw cause;
  }
}
