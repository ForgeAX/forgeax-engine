import type { World } from '@forgeax/engine-ecs';
import { displayToScenePixel } from '@forgeax/engine-picking';
import {
  type EditorAssistanceOptions,
  editorAssistance,
  pickSubmittedEditorAssistance,
  readEditorAssistance,
} from '@forgeax/engine-render';
import {
  type BrowserFrameRetentionRequest,
  type BrowserFrameSubmitted,
  FORGEAX_FRAME_RETAIN_EVENT,
  FORGEAX_FRAME_SUBMITTED_EVENT,
  readBrowserFrameSubmitted,
} from './browser-frame-signal';
import { EngineWorkspaceError } from './workspace';

/** View controls derived presentation only; authored World values remain read-only. */
export type EngineWorkspaceAssistanceIntent =
  | { readonly kind: 'get' }
  | {
      readonly kind: 'configure';
      readonly options: Partial<Omit<EditorAssistanceOptions, 'camera'>>;
    };
export interface EngineWorkspaceAssistanceRequest {
  readonly intent: EngineWorkspaceAssistanceIntent;
  readonly connectionId?: string;
}
export interface EngineWorkspaceAssistanceSnapshot {
  readonly options: Partial<EditorAssistanceOptions> & { readonly enabled: boolean };
}
export interface WorkspaceDisplayPick {
  readonly x: number;
  readonly y: number;
  readonly frameId?: number;
  readonly deviceGeneration?: number;
  readonly viewIdentity?: string;
}

/** Bounded submitted presentation history, installed only while assistance is enabled. */
export function createWorkspaceEditorAssistance(
  world: World,
  targetId: string,
  canvas: HTMLCanvasElement,
) {
  let writer: string | undefined;
  let listening = false;
  let ownsEditor = false;
  const frames = new Map<number, BrowserFrameSubmitted>();
  let retained: { readonly frame: BrowserFrameSubmitted } | undefined;
  const retainFrame = (event: Event) => {
    const request = (event as CustomEvent<BrowserFrameRetentionRequest>).detail;
    const frame = readBrowserFrameSubmitted(canvas);
    if (
      retained !== undefined ||
      frame === undefined ||
      frame.worldIdentity !== world.identity ||
      frame.frameId !== request?.frameId ||
      typeof request.accept !== 'function'
    )
      return;
    const holding = { frame };
    retained = holding;
    request.accept(() => {
      if (retained === holding) retained = undefined;
    });
  };
  canvas.addEventListener?.(FORGEAX_FRAME_RETAIN_EVENT, retainFrame);
  const acceptFrame = () => {
    const frame = readBrowserFrameSubmitted(canvas);
    if (frame === undefined || frame.worldIdentity !== world.identity) return;
    const previous = [...frames.values()].at(-1);
    if (previous?.deviceGeneration !== frame.deviceGeneration) frames.clear();
    frames.set(frame.frameId, frame);
    while (frames.size > 2) frames.delete(frames.keys().next().value as number);
  };
  const listen = () => {
    if (!listening) {
      canvas.addEventListener?.(FORGEAX_FRAME_SUBMITTED_EVENT, acceptFrame);
      listening = true;
      acceptFrame();
    }
  };
  const stopListening = () => {
    canvas.removeEventListener?.(FORGEAX_FRAME_SUBMITTED_EVENT, acceptFrame);
    listening = false;
    frames.clear();
  };
  const unavailable = (reason: string): never => {
    throw new EngineWorkspaceError(
      'engine-workspace-frame-unavailable',
      'A matching submitted editor frame',
      'Wait for the current target to submit its editor presentation.',
      { reason, targetId },
    );
  };
  const snapshot = (): EngineWorkspaceAssistanceSnapshot => ({
    options: readEditorAssistance(world)?.options ?? { enabled: false },
  });
  const observe = () => {
    if (readEditorAssistance(world)?.options.enabled) listen();
    else stopListening();
  };
  const mapping = (input: WorkspaceDisplayPick) => {
    const current = readBrowserFrameSubmitted(canvas);
    const frame =
      input.frameId === undefined || current?.frameId === input.frameId
        ? current
        : retained?.frame.frameId === input.frameId
          ? retained.frame
          : frames.get(input.frameId);
    if (
      frame === undefined ||
      frame.worldIdentity !== world.identity ||
      current?.deviceGeneration !== frame.deviceGeneration ||
      (input.frameId !== undefined && input.frameId !== frame.frameId) ||
      (input.deviceGeneration !== undefined && input.deviceGeneration !== frame.deviceGeneration)
    )
      return unavailable('stale-frame');
    if (
      frame.barrelDistortion === undefined ||
      frame.barrelDistortion.width !== canvas.width ||
      frame.barrelDistortion.height !== canvas.height
    )
      return unavailable('extent-or-mapping');
    const point = { x: 0, y: 0 };
    if (!displayToScenePixel(point, frame.barrelDistortion, input.x, input.y))
      return unavailable('invalid-position');
    return { frame, point };
  };
  const pick = (input: WorkspaceDisplayPick) => {
    const { frame, point } = mapping(input);
    const data = frame.editorAssistance;
    if (data === undefined) return { frame, point };
    const view =
      input.viewIdentity ?? (data.views.length === 1 ? data.views[0]?.identity : undefined);
    if (view === undefined) return unavailable('ambiguous-view');
    const hit = pickSubmittedEditorAssistance(data, {
      frameId: frame.frameId,
      deviceGeneration: frame.deviceGeneration,
      sourceIdentity: world.identity,
      sourceMutationEpoch: data.sourceMutationEpoch,
      viewIdentity: view,
      ...point,
    });
    if (hit.status === 'unavailable') return unavailable(hit.reason);
    if (hit.status === 'miss') return { frame, point };
    if (!world.componentsOf(hit.action.entity).ok) return unavailable('retired-entity');
    return { action: hit.action, frame, point };
  };
  return {
    pick,
    observe,
    invoke({
      intent,
      connectionId,
    }: EngineWorkspaceAssistanceRequest): EngineWorkspaceAssistanceSnapshot {
      if (intent.kind === 'get') return snapshot();
      if (intent.kind !== 'configure') throw new TypeError('A read-only editor assistance intent');
      if (ownsEditor && writer !== connectionId)
        throw new EngineWorkspaceError(
          'engine-workspace-target-busy',
          'The editor presentation owner',
        );
      retained = undefined;
      editorAssistance(world).configure(intent.options).unwrap();
      ownsEditor = readEditorAssistance(world)?.options.enabled === true;
      writer = ownsEditor ? connectionId : undefined;
      observe();
      return snapshot();
    },
    revoke(connectionId: string) {
      if (ownsEditor && writer === connectionId) {
        retained = undefined;
        readEditorAssistance(world)?.configure({ enabled: false }).unwrap();
        writer = undefined;
        ownsEditor = false;
        stopListening();
      }
    },
    dispose() {
      canvas.removeEventListener?.(FORGEAX_FRAME_RETAIN_EVENT, retainFrame);
      retained = undefined;
      stopListening();
      if (ownsEditor) readEditorAssistance(world)?.configure({ enabled: false }).unwrap();
    },
  };
}
