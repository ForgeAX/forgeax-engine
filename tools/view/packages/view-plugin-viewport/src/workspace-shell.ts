import type { EngineWorkspaceCameraResult, EngineWorkspacePresentation, EngineWorkspaceTarget } from '@forgeax/engine/app';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceTarget, WorkspaceState, WorkspaceAsset, WorkspaceInspection } from '@forgeax/view-workspace-core/contract';
import type { Dispose } from '@forgeax/view-workspace-core/frontend-contract';

type WorkspacePresentation = EngineWorkspacePresentation & { workspace?: EngineWorkspacePresentation; display?: EngineWorkspacePresentation };
type DisplayTarget = WorkspaceTarget & { surfaceId?: string; leaseId?: string };
type NavigationMode = 'look' | 'orbit' | 'pan' | 'dolly';
type CameraMotion = { type: NavigationMode | 'move'; mode?: string; yaw?: number; pitch?: number; x?: number; y?: number; amount?: number; distance?: number; pitchLimit?: number; velocity?: number[] };
type CameraSample = { type: 'key-down' | 'key-up'; mode?: never; code?: string; key: string } | { type: 'wheel'; mode: 'speed' | 'dolly'; deltaY: number } | { type: 'pointer-move'; mode: NavigationMode; movementX: number; movementY: number };
type CameraInteraction = EngineWorkspaceCameraResult & { interactionId: string; baseVersion: number };
export type WorkspaceInputBindings = 'scene' | 'orbit';
export type WorkspaceInputOptions = {
  api: ViewWorkspaceClient; targetId: string; targetGeneration?: number; tabId?: string;
  bindings?: WorkspaceInputBindings;
  interactionIdFactory?: () => string; shouldCapture?: (event: Event) => boolean;
  onError?: (error: unknown) => void; onFocusSelection?: () => unknown;
  selectOnClick?: boolean;
  window?: Window | typeof globalThis; document?: Document;
};
type RemoveInput = ((reason?: string) => void) & { handlesAbort?: boolean };
type ShellState = WorkspaceState & { assets: readonly WorkspaceAsset[]; inspectorError: string | null; error: string | null; projectOpening: boolean; projectReconnecting: boolean };
type SurfaceEntry = { targetId: string | null; target: WorkspaceTarget | null; exactSurface: boolean; surfacePlacement: 'owner' | 'shell'; reacquire: boolean; surface: HTMLElement };
type PresentationEntry = { target: WorkspaceTarget; targetId: string; surface: HTMLElement; presentation: WorkspacePresentation; surfacePlacement: 'owner' | 'shell'; generation: number; remove?: Dispose; restore?: Dispose; ready?: boolean };
export type WorkspaceShellOptions = {
  document?: Document; window?: Window | typeof globalThis; mountId?: string; element?: HTMLElement;
  api?: ViewWorkspaceClient; presentation?: WorkspacePresentation; resourceBrowser?: boolean; presentationOnly?: boolean; inspectorPanel?: boolean;
  inputControllerFactory?: (options: WorkspaceInputOptions) => ViewWorkspaceInputController;
};
import { createViewportInputApi } from '@forgeax/view-workspace-core/preview-camera';
import { reportWorkspaceCommandError, workspaceDiagnosticRecord } from '@forgeax/view-workspace-core/command-error';
import {
  VIEW_DISPLAY_TAB_ID,
  VIEW_WORKSPACE_TAB_ID,
  cloneWorkspaceValue,
  requireWorkspaceString,
  workspaceUiFingerprint,
} from '@forgeax/view-workspace-core/contract';
import { createWorkspaceId } from '@forgeax/view-workspace-core/id';
import { reopenWorkspaceProject } from '@forgeax/view-workspace-core/workspace-recovery';
import { PAGE_TYPE } from './identity.ts';
import { selectWorkspaceSceneSurfaceTarget } from '@forgeax/view-workspace-core/resource-open';
import { borrowSurface, keepSurfaceInContainer, readSceneShell } from '@forgeax/view-workspace-core/adopt-surface';
import {
  isViewTraceEnabled,
  traceInputAttach,
  traceInputCaptureAbort,
  traceInputPointerDown,
  traceInputPointerLockExit,
  traceInputPointerMove,
  traceInputPointerUp,
  tracePresentationAttach,
  traceShellRegisterDomRoot,
  traceShellRender,
  traceShellUpdate,
  traceSyncTargetSurfaces,
  traceView,
} from '@forgeax/view-workspace-core/view-trace';

function sameTargetIdentity(left: DisplayTarget | null | undefined, right: DisplayTarget | null | undefined) {
  return left?.targetId === right?.targetId && left?.generation === right?.generation &&
    left?.surfaceId === right?.surfaceId && left?.leaseId === right?.leaseId;
}

function text(document: Document, value: unknown) {
  const node = document.createElement('span');
  node.textContent = String(value);
  return node;
}

function button(document: Document, label: string, onClick: () => unknown, { disabled = false } = {}) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.disabled = disabled;
  node.addEventListener?.('click', () => void Promise.resolve(onClick()).catch(() => {}));
  return node;
}

function safeError(error: unknown) {
  const failure = error !== null && typeof error === 'object' ? error as { message?: string; hint?: unknown } : undefined;
  const message = failure?.message ?? String(error);
  const hint = typeof failure?.hint === 'string' ? failure.hint.trim() : '';
  return hint && !message.includes(hint) ? `${message} (${hint})` : message;
}

function groupAssetsBySource(assets: readonly WorkspaceAsset[] | null | undefined) {
  const groups: { key: string; assets: WorkspaceAsset[] }[] = [];
  const index = new Map<string, { key: string; assets: WorkspaceAsset[] }>();
  for (const asset of assets ?? []) {
    const key = asset.sourcePath || asset.path || asset.kind || 'assets';
    let group = index.get(key);
    if (!group) {
      group = { key, assets: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.assets.push(asset);
  }
  return groups;
}

function catalogDdcState(asset: WorkspaceAsset, inspection?: WorkspaceInspection | null) {
  if (inspection?.guid === asset?.guid && inspection.ddc?.state) return inspection.ddc.state;
  return asset?.ddc?.state;
}

function catalogReceipt(asset: WorkspaceAsset, inspection?: WorkspaceInspection | null) {
  if (inspection?.guid === asset?.guid && inspection.ddc?.receiptUrl) return inspection.ddc.receiptUrl;
  return asset?.cookReceiptUrl ?? asset?.ddc?.receiptUrl;
}

/** Viewport camera capture stays on the Scene page canvas, never a sibling tab preview. */
export function isViewportWorkspaceInputEvent(event: Event, { surface, host }: { surface?: HTMLElement; host?: HTMLElement | null } = {}) {
  const eventTarget = event?.target as Element | null;
  if (event?.defaultPrevented || !eventTarget || typeof eventTarget.closest !== 'function') return false;
  if (eventTarget.closest('button,input,a,select,textarea,[contenteditable="true"],.fx-engine-fatal-banner')) return false;
  const page = (host ?? eventTarget).closest?.('[data-forgeax-view-dock-page]');
  if (page?.getAttribute?.('aria-hidden') === 'true') return false;
  if (surface) {
    const activePage = host?.ownerDocument?.documentElement?.dataset?.forgeaxViewActivePage;
    if (activePage !== undefined && activePage !== PAGE_TYPE) return false;
    if (surface.style?.visibility === 'hidden' || surface.style?.pointerEvents === 'none') return false;
    return eventTarget === surface || surface.contains?.(eventTarget) === true;
  }
  if (!eventTarget.closest('[data-forgeax-view-mount-host="viewport"]')) return false;
  return Boolean(eventTarget.closest('[data-forgeax-view-workspace="preview"]'));
}

/**
 * Bind the CLI display tab to the iframe allocated by BrowserPagePlatform.
 * The platform owns that node and its browsing context; the workspace only
 * changes visibility and input affordances. In particular, this adapter never
 * appends, reorders, or removes the iframe because moving a live iframe can
 * detach the exact Engine Frame held by the carrier.
 */
export function createBrowserPagePresentation({ document = globalThis.document }: { document?: Document } = {}): WorkspacePresentation {
  return Object.freeze<EngineWorkspacePresentation>({
    surfacePlacement: 'owner',
    createSurface({ target, document: suppliedDocument = document }: Partial<Parameters<NonNullable<EngineWorkspacePresentation['createSurface']>>[0]> = {}) {
      const displayTarget = workspaceDiagnosticRecord(target);
      const surfaceId = displayTarget.surfaceId;
      if (typeof surfaceId !== 'string' || surfaceId.length === 0) {
        throw new TypeError('Engine display target must expose its exact surfaceId');
      }
      const ownerDocument = suppliedDocument as Document;
      if (ownerDocument?.querySelectorAll === undefined) return null;
      const matches = [...ownerDocument.querySelectorAll<HTMLIFrameElement>('iframe[data-forgeax-view-surface="engine-target"]')].filter(
        (element) =>
          element.dataset?.forgeaxViewSurface === 'engine-target' &&
          element.dataset?.forgeaxViewTargetId === String(displayTarget.targetId) &&
          element.dataset?.forgeaxViewLeaseId === String(displayTarget.leaseId) &&
          element.dataset?.forgeaxViewGeneration === String(displayTarget.generation) &&
          element.id === surfaceId,
      );
      if (matches.length > 1) {
        throw new Error(`multiple Engine display surfaces match ${surfaceId}`);
      }
      return matches[0] ?? null;
    },
    attach({ target, element: suppliedElement }: Partial<Parameters<NonNullable<EngineWorkspacePresentation['attach']>>[0]> = {}) {
      const element = workspaceDiagnosticRecord(suppliedElement);
      const dataset = workspaceDiagnosticRecord(element.dataset);
      const displayTarget = workspaceDiagnosticRecord(target);
      if (
        !suppliedElement ||
        typeof element.tagName !== 'string' || element.tagName.toLowerCase() !== 'iframe' ||
        element.id !== displayTarget.surfaceId ||
        dataset.forgeaxViewLeaseId !== String(displayTarget.leaseId) ||
        dataset.forgeaxViewGeneration !== String(displayTarget.generation)
      ) {
        throw new Error('Engine display surface identity does not match its target');
      }
      // Placement and lease cleanup stay with BrowserPagePlatform.
      return undefined;
    },
  });
}

/**
 * Browser-side continuous input boundary. Engine owns camera math and the
 * draft transaction; this object only samples DOM input and commits/aborts
 * through the workspace API. All event handlers consume rejected promises so
 * a blur, disconnect, or begin/finish race cannot become an unhandled error.
 */
export class ViewWorkspaceInputController {
  declare api: ViewWorkspaceClient;
  declare targetId: string;
  declare bindings: WorkspaceInputBindings;
  declare targetGeneration: number | undefined;
  declare tabId: string;
  declare interactionIdFactory: () => string;
  declare shouldCapture: (event: Event) => boolean;
  declare onError: (error: unknown) => void;
  declare onFocusSelection: () => unknown;
  declare selectOnClick: boolean;
  declare speed: number;
  declare held: Set<string>;
  declare shiftHeld: boolean;
  declare window: Window | typeof globalThis;
  declare document: Document;
  declare interaction: CameraInteraction | null;
  declare pending: Promise<void>;
  declare inputError: unknown;
  declare inputQueue: CameraMotion[];
  declare beginPromise: Promise<CameraInteraction | null> | null;
  declare finishPromise: Promise<void> | null;
  declare abortPromise?: Promise<void> | null;
  declare generation: number;
  declare cancelRequested: boolean;
  declare disposed: boolean;
  declare element: HTMLElement | null;
  declare bound: boolean;
  declare pointerLockEngaged: boolean;
  declare draining?: boolean;
  declare clipNearCeiling: number | undefined;
  declare clipFarCeiling: number | undefined;
  declare inputFrame?: number;

  constructor({
    api,
    targetId,
    bindings = 'scene',
    targetGeneration,
    tabId = VIEW_WORKSPACE_TAB_ID,
    interactionIdFactory = () => createWorkspaceId('interaction'),
    shouldCapture = () => true,
    onError = () => {},
    onFocusSelection = () => {},
    selectOnClick = true,
    window = globalThis,
    document = globalThis.document,
  }: Partial<WorkspaceInputOptions> = {}) {
    if (!api) throw new TypeError('workspace input controller requires an API client');
    this.api = api;
    this.targetId = requireWorkspaceString(targetId, 'targetId');
    this.bindings = bindings === 'orbit' ? 'orbit' : 'scene';
    this.targetGeneration = targetGeneration;
    this.tabId = tabId;
    this.interactionIdFactory = interactionIdFactory;
    if (typeof this.interactionIdFactory !== 'function') {
      throw new TypeError('workspace input controller requires an interactionIdFactory');
    }
    this.shouldCapture = shouldCapture;
    this.onError = onError;
    this.onFocusSelection = onFocusSelection;
    this.selectOnClick = selectOnClick;
    this.speed = 4;
    this.held = new Set();
    this.shiftHeld = false;
    this.window = window;
    this.document = document;
    this.interaction = null;
    this.pending = Promise.resolve();
    this.inputError = null;
    this.inputQueue = [];
    this.beginPromise = null;
    this.finishPromise = null;
    this.generation = 0;
    this.cancelRequested = false;
    this.disposed = false;
    this.element = null;
    this.bound = false;
    // Pointer lock is an optional browser affordance. Keep a local bit so a
    // rejected request (or a browser that never grants lock to an overlay)
    // cannot be mistaken for a lock-loss transition and abort a valid
    // pointer transaction.
    this.pointerLockEngaged = false;
    this.clipNearCeiling = undefined;
    this.clipFarCeiling = undefined;
  }

  report(error: unknown) {
    if (error === undefined || error === null) return;
    this.inputError ??= error;
    try {
      this.onError(error);
    } catch {
      // Error presentation cannot change the Engine transaction.
    }
  }

  async begin(): Promise<CameraInteraction | null> {
    if (this.beginPromise) return this.beginPromise;
    if (this.interaction && !this.finishPromise && !this.abortPromise) return this.interaction;
    const abort = this.abortPromise;
    const finish = this.finishPromise;
    const queue = this.inputQueue;
    const generation = this.generation;
    this.cancelRequested = false;
    const begunPromise = (async () => {
      if (abort) await abort;
      if (finish) await finish;
      if (this.disposed) throw new Error('workspace input controller is disposed');
      const current = await this.api.getCamera({ targetId: this.targetId, targetGeneration: this.targetGeneration, tabId: this.tabId });
      if (this.disposed || generation !== this.generation || this.cancelRequested) {
        throw new Error('workspace input begin was cancelled');
      }
      const expectedVersion = current.version;
      if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        throw new TypeError('workspace camera begin requires getCamera().version');
      }
      const interactionId = this.interactionIdFactory();
      const begun = await this.api.beginCamera({
        targetId: this.targetId, targetGeneration: this.targetGeneration,
        tabId: this.tabId,
        baseVersion: expectedVersion,
        interactionId,
      });
      // 0.1.33 begin returns { camera, version } only. Commit must use the
      // interactionId we sent and the version observed at begin.
      this.interaction = { ...begun, interactionId, baseVersion: expectedVersion };
      await this.flushInputQueue();
      if (this.cancelRequested || this.disposed || generation !== this.generation) {
        await this.api
          .abortCamera({
            targetId: this.targetId, targetGeneration: this.targetGeneration,
            tabId: this.tabId,
            interactionId,
            reason: 'input-begin-cancelled',
          })
          .catch((error) => this.report(error));
        this.clearTransaction();
        throw new Error('workspace input begin was cancelled');
      }
      return this.interaction;
    })();
    this.beginPromise = begunPromise;
    try {
      return await begunPromise;
    } catch (error) {
      if (generation === this.generation && this.inputQueue === queue) this.clearTransaction();
      throw error;
    } finally {
      if (this.beginPromise === begunPromise) this.beginPromise = null;
    }
  }

  async flushInputQueue() {
    this.cancelInputFrame();
    this.drainInputQueue();
    await this.pending;
  }

  enqueueUpdate(input: CameraMotion) {
    const previous = this.inputQueue.at(-1);
    if (previous?.type === input.type && previous.mode === input.mode &&
        ['look', 'orbit', 'pan', 'dolly'].includes(input.type)) {
      for (const key of ['yaw', 'pitch', 'x', 'y', 'amount'] as const) {
        if (input[key] !== undefined) previous[key] = (previous[key] ?? 0) + input[key];
      }
    } else if (this.inputQueue.length < 64) {
      this.inputQueue.push({ ...input });
    } else {
      this.report(new Error('Viewport input exceeded its bounded queue; gesture cancelled.'));
      void this.abort('input-overflow');
      return;
    }
    if (typeof this.window.requestAnimationFrame !== 'function') this.drainInputQueue();
    else if (this.inputFrame === undefined) this.inputFrame = this.window.requestAnimationFrame(() => {
      this.inputFrame = undefined;
      this.drainInputQueue();
    });
  }

  cancelInputFrame() {
    if (this.inputFrame === undefined) return;
    this.window.cancelAnimationFrame(this.inputFrame);
    this.inputFrame = undefined;
  }

  drainInputQueue(interaction = this.interaction, queue = this.inputQueue) {
    if (this.finishPromise && queue === this.inputQueue) return;
    if (!interaction || this.draining) return;
    const generation = this.generation;
    this.draining = true;
    this.pending = Promise.resolve().then(async () => {
      let tightenClip = false;
      let latestCamera: unknown;
      while (queue.length) {
        if (
          generation !== this.generation ||
          this.cancelRequested ||
          this.disposed ||
          this.interaction !== interaction
        )
          return;
        const input = queue.shift();
        const updated = await this.api.updateCamera({
          targetId: this.targetId, targetGeneration: this.targetGeneration,
          tabId: this.tabId,
          interactionId: interaction.interactionId,
          input,
        });
        if (input?.type !== 'move') {
          tightenClip = true;
          latestCamera = updated?.camera;
        }
        if (generation !== this.generation || this.interaction !== interaction) return;
      }
      if (tightenClip && this.interaction === interaction) await this.tightenNearPlane(interaction, latestCamera);
    })
      .catch((error) => {
        if (generation !== this.generation || this.interaction !== interaction) return;
        this.inputError ??= error;
        this.report(error);
      })
      .finally(() => {
        this.draining = false;
        if (generation === this.generation && this.inputQueue.length) this.drainInputQueue();
      });
  }

  /**
   * A framed preview keeps a near plane sized for the whole subject. Pull it in
   * with the distance to the orbit pivot so dolly and orbit can approach a
   * detail without clipping the surface. The first observed near stays the ceiling.
   */
  async tightenNearPlane(interaction: CameraInteraction, hintedCamera: unknown) {
    let camera = hintedCamera;
    const lensOf = (value: unknown) => {
      if (!value || typeof value !== 'object' || !('lens' in value)) return undefined;
      const lens = (value as { lens?: { projection?: string; near?: number; far?: number } }).lens;
      return lens && typeof lens === 'object' ? lens : undefined;
    };
    // A motion result that already names a camera without a lens is not a clip
    // adjustment. Querying again would add a camera read the gesture did not ask for.
    if (camera !== undefined && !lensOf(camera)) return;
    if (!lensOf(camera)) {
      const current = await this.api.getCamera({
        targetId: this.targetId,
        targetGeneration: this.targetGeneration,
        tabId: this.tabId,
      });
      if (this.interaction !== interaction) return;
      camera = current?.camera;
    }
    if (this.interaction !== interaction) return;
    if (!camera || typeof camera !== 'object') return;
    const record = camera as {
      lens?: { projection?: string; near?: number; far?: number };
      transform?: { pos?: unknown };
      pivot?: unknown;
    };
    const lens = lensOf(record) ?? record.lens;
    if (!lens || lens.projection === 'orthographic') return;
    const currentNear = Number(lens.near);
    const currentFar = Number(lens.far);
    if (this.clipNearCeiling === undefined && currentNear > 0) this.clipNearCeiling = currentNear;
    if (this.clipFarCeiling === undefined && currentFar > currentNear) this.clipFarCeiling = currentFar;
    const nearCeiling = this.clipNearCeiling ?? currentNear;
    const farCeiling = this.clipFarCeiling ?? currentFar;
    const vector = (value: unknown) => {
      if (!Array.isArray(value) || value.length < 3) return undefined;
      const next = [Number(value[0]), Number(value[1]), Number(value[2])];
      return next.every(Number.isFinite) ? next : undefined;
    };
    const pivot = vector(record.pivot);
    const position = vector(record.transform?.pos);
    const pivotX = pivot?.[0];
    const pivotY = pivot?.[1];
    const pivotZ = pivot?.[2];
    const positionX = position?.[0];
    const positionY = position?.[1];
    const positionZ = position?.[2];
    const distance = pivotX !== undefined && pivotY !== undefined && pivotZ !== undefined
      && positionX !== undefined && positionY !== undefined && positionZ !== undefined
      ? Math.max(0.01, Math.hypot(positionX - pivotX, positionY - pivotY, positionZ - pivotZ))
      : 5;
    const near = Math.max(0.001, Math.min(nearCeiling, distance * 0.002));
    const far = Math.max(farCeiling, distance * 8, near + 1);
    if (!(near > 0) || !(far > near)) return;
    if (Math.abs(near - currentNear) <= 1e-4 && Math.abs(far - currentFar) <= 1e-3) return;
    await this.api.updateCamera({
      targetId: this.targetId,
      targetGeneration: this.targetGeneration,
      tabId: this.tabId,
      interactionId: interaction.interactionId,
      camera: { lens: { near, far } },
    });
  }

  /** Current WASD/QE move sample; Shift multiplies speed like Unreal's fast-fly. */
  currentMoveInput(): CameraMotion {
    const axes = [Number(this.held.has('KeyD')) - Number(this.held.has('KeyA')),
      Number(this.held.has('KeyE')) - Number(this.held.has('KeyQ')),
      Number(this.held.has('KeyS')) - Number(this.held.has('KeyW'))];
    const length = Math.hypot(...axes) || 1;
    const boost = this.shiftHeld ? 3 : 1;
    return { type: 'move', velocity: axes.map(value => (value * this.speed * boost) / length) };
  }

  queueInput(input: CameraSample) {
    if (this.disposed || this.cancelRequested) return;
    const movement = () => this.currentMoveInput();
    let motion: CameraMotion;
    if (input.type === 'key-down' || input.type === 'key-up') {
      const code = input.code || 'Key' + String(input.key).toUpperCase();
      if (input.type === 'key-down') this.held.add(code);
      else this.held.delete(code);
      motion = movement();
    } else if (input.type === 'wheel' && input.mode === 'speed') {
      this.speed = Math.max(0.05, Math.min(1024, this.speed * Math.exp(-input.deltaY * 0.002)));
      motion = movement();
    } else if (input.type === 'wheel' || input.mode === 'dolly') {
      motion = { type: 'dolly', amount: Math.max(-4, Math.min(4,
        (input.type === 'wheel' ? input.deltaY : ('movementY' in input ? input.movementY : 0) * 4) * 0.001)), distance: 5 };
    } else if (input.mode === 'pan') {
      motion = { type: 'pan', x: -(('movementX' in input ? input.movementX : 0)) * 0.002,
        y: (('movementY' in input ? input.movementY : 0)) * 0.002, distance: 5 };
    } else {
      const orbitGesture = input.mode === 'orbit' && this.bindings === 'orbit';
      motion = { type: input.mode === 'orbit' ? 'orbit' : 'look',
        yaw: -(('movementX' in input ? input.movementX : 0)) * (orbitGesture ? 0.01 : 0.003),
        pitch: -(('movementY' in input ? input.movementY : 0)) * (orbitGesture ? 0.01 : 0.003),
        pitchLimit: orbitGesture ? 1.35 : Math.PI / 2 - 0.01, distance: 5 };
    }
    this.enqueueUpdate(motion);
  }

  clearTransaction() {
    this.cancelInputFrame();
    this.held.clear();
    this.interaction = null;
    this.pending = Promise.resolve();
    this.inputQueue = [];
    this.inputError = null;
  }

  async finish(): Promise<void> {
    if (this.finishPromise) {
      const finishing = this.finishPromise;
      return this.beginPromise ? finishing.then(() => this.finish()) : finishing;
    }
    const begin = this.beginPromise;
    this.beginPromise = null;
    this.cancelInputFrame();
    const queue = this.inputQueue;
    this.inputQueue = [];
    this.held.clear();
    const generation = this.generation;
    let interaction;
    this.finishPromise = (async () => {
      try {
        if (begin) await begin;
        interaction = this.interaction;
        if (!interaction) return;
        await this.pending;
        this.drainInputQueue(interaction, queue);
        await this.pending;
        if (this.cancelRequested || this.disposed || generation !== this.generation) {
          await this.api.abortCamera({ targetId: this.targetId, targetGeneration: this.targetGeneration,
            tabId: this.tabId, interactionId: interaction.interactionId, reason: 'input-finish-cancelled' });
          return;
        }
        if (this.inputError) {
          const error = this.inputError;
          await this.api.abortCamera({ targetId: this.targetId, targetGeneration: this.targetGeneration,
            tabId: this.tabId, interactionId: interaction.interactionId, reason: 'input-update-failed' });
          throw error;
        }
        try {
          await this.api.commitCamera({
            targetId: this.targetId, targetGeneration: this.targetGeneration,
            tabId: this.tabId,
            interactionId: interaction.interactionId,
            operationId: this.interactionIdFactory(),
            expectedVersion: interaction.baseVersion,
          });
        } catch (error) {
          await this.api
            .abortCamera({
              targetId: this.targetId, targetGeneration: this.targetGeneration,
              tabId: this.tabId,
              interactionId: interaction.interactionId,
              reason: 'commit-failed',
            })
            .catch(() => {});
          throw error;
        }
      } finally {
        if (this.interaction === interaction) this.interaction = null;
        this.inputError = null;
      }
    })();
    try {
      return await this.finishPromise;
    } finally {
      this.finishPromise = null;
    }
  }

  async abort(reason = 'input-abort') {
    this.cancelInputFrame();
    if (this.abortPromise) return this.abortPromise;
    ++this.generation;
    this.cancelRequested = true;
    const begin = this.beginPromise;
    this.abortPromise = (async () => {
      if (begin) await begin.catch(() => {});
      await this.pending;
      const interaction = this.interaction;
      try {
        if (interaction) {
          await this.api.abortCamera({
            targetId: this.targetId, targetGeneration: this.targetGeneration,
            tabId: this.tabId,
            interactionId: interaction.interactionId,
            reason,
          });
        }
      } catch (error) {
        this.report(error);
      } finally {
        this.clearTransaction();
      }
    })();
    try { await this.abortPromise; }
    finally { this.abortPromise = null; }
  }

  async requestPointerLock() {
    if (typeof this.element?.requestPointerLock !== 'function') return;
    try {
      await Promise.resolve(this.element.requestPointerLock());
    } catch {
      // Pointer lock is an optional browser affordance.  A browser can reject
      // it for an iframe, automation event, or missing user activation while
      // ordinary pointer/keyboard samples remain valid.  Do not turn that
      // presentation limitation into an Engine transaction failure.
    }
  }

  trySetPointerCapture(element: HTMLElement | null, pointerId?: number) {
    if (pointerId === undefined || typeof element?.setPointerCapture !== 'function') return;
    try {
      element.setPointerCapture(pointerId);
    } catch {
      // Pointer capture is best-effort.  The API interaction remains the
      // authority and can continue without this browser-local optimization.
    }
  }

  tryReleasePointerCapture(element: HTMLElement | null, pointerId?: number) {
    if (pointerId === undefined || typeof element?.releasePointerCapture !== 'function') return;
    try {
      element.releasePointerCapture(pointerId);
    } catch {
      // The pointer may already have been cancelled or released by the
      // browser; there is no Engine state to repair here.
    }
  }

  attach(element: HTMLElement): RemoveInput {
    if (!element || this.bound) return () => {};
    this.element = element;
    this.bound = true;
    const previousTabIndex = element.getAttribute?.('tabindex');
    if (previousTabIndex == null) element.setAttribute?.('tabindex', '0');
    traceInputAttach(element, { targetId: this.targetId, tabId: this.tabId });
    let gesture: { button: number; mode: NavigationMode; x: number; y: number } | null = null;
    let selectionRequest: AbortController | undefined;
    let clickStart: { x: number; y: number } | undefined;
    let consumedClick = false;
    const held = this.held;
    const orbitBindings = this.bindings === 'orbit';
    const stop = () => {
      selectionRequest?.abort();
      gesture = null;
      held.clear();
      this.shiftHeld = false;
      if (orbitBindings && element.dataset) delete element.dataset.dragging;
      if (this.document?.pointerLockElement === element) this.document.exitPointerLock?.();
      void this.finish().catch((error) => this.report(error));
    };
    const down = (event: PointerEvent) => {
      if (this.shouldCapture(event)) element.focus?.();
      const accepted = !gesture && this.shouldCapture(event) && (
        orbitBindings
          ? event.button === 0 || event.button === 1 || event.button === 2
          : event.button === 2 || event.button === 1 || (event.button === 0 && event.altKey)
      );
      consumedClick = event.defaultPrevented === true || accepted;
      clickStart = { x: event.clientX, y: event.clientY };
      traceInputPointerDown(event, { accepted, element });
      if (accepted) {
        selectionRequest?.abort();
        event.preventDefault?.();
        gesture = {
          button: event.button,
          mode: orbitBindings
            ? (event.button === 1 ? 'pan' : event.button === 2 ? 'dolly' : 'orbit')
            : (event.button === 1 ? 'pan' : event.altKey ? (event.button === 0 ? 'orbit' : 'dolly') : 'look'),
          x: event.clientX,
          y: event.clientY,
        };
        if (orbitBindings && element.dataset) element.dataset.dragging = 'true';
        element.focus?.();
        void this.begin().catch((error) => this.report(error));
        this.trySetPointerCapture(element, event?.pointerId);
        if (!orbitBindings) void this.requestPointerLock();
        traceView('input', 'capture-engaged', {
          pointerId: event?.pointerId,
          pointerLockElement: globalThis.document?.pointerLockElement?.tagName,
        });
      }
    };
    const menu = (event: MouseEvent) => {
      if (!this.shouldCapture(event)) return;
      event.preventDefault?.();
    };
    const move = (event: PointerEvent) => {
      if (clickStart && Math.hypot(event.clientX - clickStart.x, event.clientY - clickStart.y) > 4) consumedClick = true;
      if (!gesture || (!this.interaction && !this.beginPromise)) return;
      let movementX = Number(event.movementX ?? 0);
      let movementY = Number(event.movementY ?? 0);
      if (orbitBindings) {
        const dx = Number(event.clientX) - gesture.x;
        const dy = Number(event.clientY) - gesture.y;
        if (movementX === 0 && movementY === 0 && Number.isFinite(dx) && Number.isFinite(dy)) {
          movementX = dx;
          movementY = dy;
        }
        if (Number.isFinite(event.clientX)) gesture.x = event.clientX;
        if (Number.isFinite(event.clientY)) gesture.y = event.clientY;
      }
      traceInputPointerMove(event, {
        queued: true,
        queueDepth: this.inputQueue.length,
        inFlight: this.draining ? 1 : 0,
      });
      this.queueInput({
        type: 'pointer-move',
        mode: gesture.mode,
        movementX,
        movementY,
      });
    };
    const up = (event: PointerEvent) => {
      if (!gesture || event.button !== gesture.button) return;
      this.tryReleasePointerCapture(element, event?.pointerId);
      traceInputPointerUp(event, { element });
      stop();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture) { stop(); return; }
      if (!this.shouldCapture(event) || event.repeat) return;
      if (!gesture && String(event.key).toLowerCase() === 'f') {
        event.preventDefault?.();
        void Promise.resolve().then(this.onFocusSelection).catch(error => this.report(error));
        return;
      }
      if (orbitBindings) return;
      // Unreal-style: Shift only boosts speed while navigation keys are held.
      if (event.key === 'Shift') {
        this.shiftHeld = true;
        if (held.size) this.enqueueUpdate(this.currentMoveInput());
        return;
      }
      // WASD/QE move with or without the RMB look gesture.
      if (!['w', 'a', 's', 'd', 'q', 'e'].includes(String(event.key ?? '').toLowerCase())) return;
      event.preventDefault?.();
      held.add(event.code || event.key);
      if (!gesture) void this.begin().catch((error) => this.report(error));
      this.queueInput({ type: 'key-down', key: String(event.key ?? ''), code: String(event.code ?? '') });
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.key === 'Shift') {
        this.shiftHeld = false;
        if (held.size) this.enqueueUpdate(this.currentMoveInput());
        return;
      }
      if (!held.delete(event.code || event.key)) return;
      if (!this.interaction && !this.beginPromise) return;
      event.preventDefault?.();
      this.queueInput({ type: 'key-up', key: String(event.key ?? ''), code: String(event.code ?? '') });
      // Bare keys own no pointer gesture: commit the camera transaction once
      // every navigation key is released instead of leaking an open draft.
      if (!gesture && held.size === 0) void this.finish().catch((error) => this.report(error));
    };
    const wheel = (event: WheelEvent) => {
      if (!this.shouldCapture(event) || this.finishPromise) return;
      selectionRequest?.abort();
      event.preventDefault?.();
      void this.begin().catch((error) => this.report(error));
      this.queueInput({ type: 'wheel', mode: gesture?.mode === 'look' ? 'speed' : 'dolly',
        deltaY: Number(event.deltaY ?? 0) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1) });
      if (!gesture) void this.finish().catch((error) => this.report(error));
    };
    const abort = (reason = 'input-focus-lost') => {
      if (reason !== 'pointerlock-exit') traceInputCaptureAbort(reason);
      else traceView('input', 'abort', { reason });
      stop();
    };
    const pointerLockChange = () => {
      const locked = this.document?.pointerLockElement === element;
      traceView('input', 'pointerlockchange', {
        locked,
        pointerLockElement: this.document?.pointerLockElement?.tagName,
        engaged: this.pointerLockEngaged,
      });
      if (locked) this.pointerLockEngaged = true;
      if (this.pointerLockEngaged && !locked) {
        this.pointerLockEngaged = false;
        traceInputPointerLockExit({ locked, element });
        abort('pointerlock-exit');
      }
    };
    const click = (event: MouseEvent) => {
      if (!this.selectOnClick || orbitBindings) return;
      const consumed = consumedClick;
      consumedClick = false;
      const dragged = clickStart && Math.hypot(event.clientX - clickStart.x, event.clientY - clickStart.y) > 4;
      clickStart = undefined;
      if (consumed || dragged) return;
      if (gesture || event.button !== 0 || event.altKey || !this.shouldCapture(event)) return;
      const canvas = element.tagName === 'CANVAS' ? element as HTMLCanvasElement : element.querySelector?.('canvas');
      if (!canvas || event.target !== canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0 && canvas.width > 0 && canvas.height > 0)) return;
      selectionRequest?.abort();
      selectionRequest = new AbortController();
      // The shared client reports failures; a failed query never enters the camera transaction.
      void this.api.call('scene.pick', {
        targetId: this.targetId, targetGeneration: this.targetGeneration, tabId: this.tabId,
        x: (event.clientX - rect.left) * canvas.width / rect.width,
        y: (event.clientY - rect.top) * canvas.height / rect.height,
      }, { signal: selectionRequest.signal }).catch(() => {});
    };
    element.addEventListener?.('click', click);
    element.addEventListener?.('pointerdown', down);
    element.addEventListener?.('pointermove', move);
    element.addEventListener?.('pointerup', up);
    element.addEventListener?.('wheel', wheel, { passive: false });
    element.addEventListener?.('contextmenu', menu);
    const onPointerCancel = () => abort('pointercancel');
    const onWindowBlur = () => abort('window-blur');
    const onFocusOut = (event: FocusEvent) => { if (!element.contains?.(event.relatedTarget as Node | null)) abort('focusout'); };
    const onVisibilityChange = () => { if (this.document?.hidden) abort('visibilitychange'); };
    element.addEventListener?.('pointercancel', onPointerCancel);
    element.addEventListener?.('keydown', keydown);
    this.window?.addEventListener?.('keyup', keyup);
    this.window?.addEventListener?.('pointerup', up);
    this.window?.addEventListener?.('blur', onWindowBlur);
    this.window?.addEventListener?.('focusout', onFocusOut);
    this.document?.addEventListener?.('visibilitychange', onVisibilityChange);
    this.document?.addEventListener?.('pointerlockchange', pointerLockChange);
    const remove = (reason = 'input-detached') => {
      if (previousTabIndex == null) element.removeAttribute?.('tabindex');
      if (orbitBindings && element.dataset) delete element.dataset.dragging;
      selectionRequest?.abort();
      element.removeEventListener?.('click', click);
      element.removeEventListener?.('pointerdown', down);
      element.removeEventListener?.('pointermove', move);
      element.removeEventListener?.('pointerup', up);
      element.removeEventListener?.('wheel', wheel);
      element.removeEventListener?.('contextmenu', menu);
      element.removeEventListener?.('pointercancel', onPointerCancel);
      element.removeEventListener?.('keydown', keydown);
      this.window?.removeEventListener?.('keyup', keyup);
      this.window?.removeEventListener?.('pointerup', up);
      this.window?.removeEventListener?.('blur', onWindowBlur);
      this.window?.removeEventListener?.('focusout', onFocusOut);
      this.document?.removeEventListener?.('visibilitychange', onVisibilityChange);
      this.document?.removeEventListener?.('pointerlockchange', pointerLockChange);
      this.pointerLockEngaged = false;
      if (reason !== 'input-disposed') {
        traceInputCaptureAbort(reason);
        void this.abort(reason).catch((error) => this.report(error));
      }
      this.element = null;
      this.bound = false;
    };
    remove.handlesAbort = true;
    return remove;
  }

  dispose() {
    this.disposed = true;
    return this.abort('input-disposed');
  }
}

/** Stable exact Engine surfaces; all state and controls use the workspace API.
 * Without a presentation adapter, retain an inert surface. Play owns its
 * one iframe in a separate plugin; an arbitrary target URL never creates one.
 */
export class ViewWorkspaceShell {
  declare document: Document;
  declare window: Window | typeof globalThis;
  declare mountId: string;
  declare api: ViewWorkspaceClient | undefined;
  declare presentation: WorkspacePresentation | undefined;
  declare resourceBrowser: boolean;
  declare presentationOnly: boolean;
  declare inspectorPanel: boolean;
  declare inputControllerFactory: (options: WorkspaceInputOptions) => ViewWorkspaceInputController;
  declare state: ShellState;
  declare element: HTMLElement | null;
  declare rootElement: HTMLElement | null;
  declare tabsElement: HTMLElement | null;
  declare projectElement: HTMLElement | null;
  declare assetsElement: HTMLElement | null;
  declare workbenchElement: HTMLElement | null;
  declare inspectorElement: HTMLElement | null;
  declare inspectorInfoElement: HTMLElement | null;
  declare inspectorFieldsElement: HTMLElement | null;
  declare inspectorActionsElement: HTMLElement | null;
  declare previewElement: HTMLElement | null;
  declare previewInfoElement: HTMLElement | null;
  declare errorElement: HTMLElement | null;
  declare targetContainer: HTMLElement | null;
  declare surface: HTMLElement | null;
  declare removeSubscription?: Dispose;
  declare removeDisconnect?: Dispose;
  declare removeInput?: RemoveInput;
  declare inputController?: ViewWorkspaceInputController;
  declare inputTargetId: string | null;
  declare inputTargetGeneration?: number;
  declare inputSurface?: HTMLElement;
  declare surfaceByTab: Map<string, SurfaceEntry>;
  declare presentationByTab: Map<string, PresentationEntry>;
  declare presentationPending: Map<string, { target: WorkspaceTarget; generation: number; surface: HTMLElement; task: Promise<void> }>;
  declare presentationQueueByTab: Map<string, Promise<void>>;
  declare presentationGenerationByTab: Map<string, number>;
  declare surfaceTargetId: string | null;
  declare presentedTargetId: string | null;
  declare removeSurfacePresentation?: Dispose;
  declare renderFingerprint: string;
  declare disposed: boolean;
  declare stopSceneAdopt?: Dispose;
  declare disposal?: Promise<void>;

  constructor({
    document = globalThis.document,
    window = globalThis,
    mountId = 'forgeax-view-workspace',
    element,
    api,
    presentation,
    resourceBrowser = false,
    presentationOnly = false,
    inspectorPanel = true,
    inputControllerFactory = (options) => new ViewWorkspaceInputController(options),
  }: WorkspaceShellOptions = {}) {
    this.document = document;
    this.window = window;
    this.mountId = mountId;
    this.api = api;
    this.presentation = presentation;
    this.resourceBrowser = resourceBrowser === true;
    this.presentationOnly = presentationOnly;
    this.inspectorPanel = inspectorPanel !== false;
    this.inputControllerFactory = inputControllerFactory;
    this.state = {
      selectedTabId: VIEW_WORKSPACE_TAB_ID,
      tabs: [],
      project: null,
      projectTarget: null,
      preview: null,
      assets: [],
      inspection: null,
      inspectorError: null,
      error: null,
      projectOpening: false,
      projectReconnecting: false,
      workspaceTargetLost: false,
    };
    this.element = null;
    this.rootElement = null;
    this.tabsElement = null;
    this.projectElement = null;
    this.assetsElement = null;
    this.workbenchElement = null;
    this.inspectorElement = null;
    this.inspectorInfoElement = null;
    this.inspectorFieldsElement = null;
    this.inspectorActionsElement = null;
    this.previewElement = null;
    this.previewInfoElement = null;
    this.errorElement = null;
    this.targetContainer = null;
    this.removeSubscription = undefined;
    this.removeDisconnect = undefined;
    this.removeInput = undefined;
    this.inputController = undefined;
    this.inputTargetId = null;
    this.surfaceByTab = new Map();
    this.presentationByTab = new Map();
    this.presentationPending = new Map();
    this.presentationQueueByTab = new Map();
    this.presentationGenerationByTab = new Map();
    this.surface = null;
    this.surfaceTargetId = null;
    this.presentedTargetId = null;
    this.removeSurfacePresentation = undefined;
    this.renderFingerprint = '';
    this.disposed = false;
    this.stopSceneAdopt = undefined;
    if (document?.createElement) {
      // Prefer the caller-supplied node. Dockview/ShadowRoot mounts are not
      // visible to document.getElementById, and falling back to a new body
      // section would orphan the exact Engine surface outside the View shell.
      this.element = element
        ?? document.getElementById?.(mountId)
        ?? document.createElement('section');
      this.element.id ||= mountId;
      this.element.dataset.forgeaxView = 'workspace';
      if (!this.element.parentNode) document.body?.append?.(this.element);
      this.render();
    }
    if (api) this.connect(api);
  }

  connect(api: ViewWorkspaceClient) {
    this.removeSubscription?.();
    this.removeDisconnect?.();
    this.api = api;
    this.disposed = false;
    this.removeSubscription = api.subscribe?.((state) => this.update(state));
    this.removeDisconnect = api.onDisconnect?.((error) => {
      this.detachInput('resident-disconnect');
      this.fail(error);
    });
    void Promise.resolve()
      .then(() => api.getState?.())
      .then((state) => this.update(state))
      .then(() => (this.state.project ? this.refreshAssets() : undefined))
      .catch((error) => this.fail(error));
    return this;
  }

  update(snapshot: WorkspaceState = {}) {
    if (this.disposed) return this.snapshot();
    const next = cloneWorkspaceValue(snapshot);
    if (
      next.selectedTabId !== undefined &&
      next.selectedTabId !== this.state.selectedTabId
    ) {
      this.detachInput('tab-selection');
    }
    this.state = {
      ...this.state,
      ...next,
      assets: Array.isArray(next.assets) ? next.assets : next.assets === null ? [] : this.state.assets,
      inspectorError: next.inspection ? null : this.state.inspectorError,
      projectOpening: next.project ? false : this.state.projectOpening,
      projectReconnecting: next.workspaceTargetLost === false ? false : this.state.projectReconnecting,
      workspaceTargetLost: next.workspaceTargetLost === true,
      error: next.project && !next.workspaceTargetLost ? null : this.state.error,
    };
    traceShellUpdate({
      selectedTabId: this.state.selectedTabId,
      cameraVersion: this.state.preview?.cameraVersion,
      previewTargetId: this.state.preview?.target?.targetId,
    });
    const fingerprint = workspaceUiFingerprint(this.state);
    this.render({ chromeChanged: fingerprint !== this.renderFingerprint });
    this.renderFingerprint = fingerprint;
    return this.snapshot();
  }

  snapshot() {
    return cloneWorkspaceValue(this.state);
  }

  fail(error: unknown) {
    this.state = {
      ...this.state,
      error: safeError(error),
      projectOpening: false,
      projectReconnecting: false,
    };
    if (this.presentationOnly) {
      reportWorkspaceCommandError(error, { operation: 'workspace' });
    }
    this.render();
    this.renderFingerprint = workspaceUiFingerprint(this.state);
    return this.snapshot();
  }

  async refreshAssets() {
    if (!this.api || !this.state.project) return;
    try {
      const result = await this.api.listAssets(this.state.project.id, { tabId: VIEW_WORKSPACE_TAB_ID });
      this.state.assets = result.assets ?? [];
      this.state.error = null;
      const fingerprint = workspaceUiFingerprint(this.state);
      this.render({ chromeChanged: fingerprint !== this.renderFingerprint });
      this.renderFingerprint = fingerprint;
    } catch (error) {
      this.fail(error);
    }
  }

  async openProject(root: string) {
    if (this.disposed) return this.snapshot();
    if (!this.api) {
      return this.fail(new Error('View workspace API is not connected'));
    }
    if (this.state.projectOpening) return this.snapshot();
    const path = typeof root === 'string' ? root.trim() : '';
    if (!path) {
      return this.fail(new Error('Project root is required'));
    }
    this.state = { ...this.state, error: null, projectOpening: true };
    this.render();
    try {
      const opened = await this.api.openProject(path, { tabId: VIEW_WORKSPACE_TAB_ID });
      if (opened?.project) this.update(opened);
      await this.refreshAssets();
      return this.snapshot();
    } catch (error) {
      return this.fail(error);
    } finally {
      this.state = { ...this.state, projectOpening: false };
      this.render();
    }
  }

  async reconnectProject() {
    if (this.disposed) return this.snapshot();
    if (!this.api) {
      return this.fail(new Error('View workspace API is not connected'));
    }
    if (this.state.projectReconnecting) return this.snapshot();
    this.state = { ...this.state, error: null, projectReconnecting: true };
    this.render();
    try {
      const opened = await reopenWorkspaceProject(this.api, { window: this.window });
      if (opened?.project) this.update(opened);
      await this.refreshAssets();
      return this.snapshot();
    } catch (error) {
      return this.fail(error);
    } finally {
      this.state = { ...this.state, projectReconnecting: false };
      this.render();
    }
  }

  async openAsset(guid: string) {
    try {
      await this.api!.openAsset(guid, { projectId: this.state.project?.id, tabId: VIEW_WORKSPACE_TAB_ID });
    } catch (error) {
      this.fail(error);
    }
  }

  async selectAsset(guid: string) {
    if (!this.api || !this.state.project) return;
    try {
      const inspected = await this.api.inspectAsset(guid, {
        projectId: this.state.project.id,
        tabId: VIEW_WORKSPACE_TAB_ID,
      });
      this.state.inspection = inspected.inspection ?? this.state.inspection;
      this.state.inspectorError = null;
    } catch (error) {
      this.state.inspectorError = safeError(error);
      this.render();
    }
    const asset =
      this.state.assets.find((candidate) => candidate.guid === guid) ?? this.state.inspection?.asset;
    if (this.resourceBrowser) {
      this.render();
      return;
    }
    if (asset?.previewable === false || this.state.preview?.asset?.guid === guid) {
      this.render();
      return;
    }
    await this.openAsset(guid);
  }

  async cookSelected(mode = 'rebuild') {
    const guid = this.state.inspection?.guid ?? this.state.preview?.asset?.guid;
    if (!this.api || !this.state.project || !guid) return;
    try {
      const call =
        mode === 'cold-cook' ? this.api.coldCookAssetSource : this.api.rebuildAssetSource;
      if (typeof call !== 'function') {
        throw new Error(`Engine ${mode === 'cold-cook' ? 'asset.source.cold-cook' : 'asset.source.rebuild'} is unavailable`);
      }
      await call.call(this.api, guid, {
        projectId: this.state.project.id,
        tabId: VIEW_WORKSPACE_TAB_ID,
        expectedRevision: this.state.inspection?.revision,
      });
      this.state.inspectorError = null;
    } catch (error) {
      this.state.inspectorError = safeError(error);
      this.render();
      throw error;
    }
  }

  async closeProject() {
    try {
      await this.api!.closeProject(this.state.project?.id, { tabId: VIEW_WORKSPACE_TAB_ID });
    } catch (error) {
      this.fail(error);
    }
  }

  async selectTab(tabId: string) {
    this.detachInput('tab-selection');
    try {
      await this.api!.selectTab(tabId);
    } catch (error) {
      this.fail(error);
    }
  }

  async closePreview() {
    await this.inputController?.abort('preview-close');
    try {
      await this.api!.closePreview({ targetId: this.state.preview?.target?.targetId, targetGeneration: this.state.preview?.target?.generation, tabId: VIEW_WORKSPACE_TAB_ID });
    } catch (error) {
      this.fail(error);
    }
  }

  replaceSurface(target: WorkspaceTarget | null) {
    this.ensureSurface(VIEW_WORKSPACE_TAB_ID, target);
    this.setActiveSurface();
  }

  attachSurfacePresentation(target: WorkspaceTarget) {
    const entry = this.surfaceByTab.get(VIEW_WORKSPACE_TAB_ID);
    this.attachTargetPresentation(VIEW_WORKSPACE_TAB_ID, target, entry?.surface);
  }

  targetForTab(tabId: string) {
    if (tabId === VIEW_WORKSPACE_TAB_ID) return selectWorkspaceSceneSurfaceTarget(this.state);
    const tab = (this.state.tabs ?? []).find((candidate) => candidate.tabId === tabId);
    if (!tab) return null;
    if (tab.target) {
      return {
        ...tab.target,
        targetId: String(tab.target.targetId ?? tab.targetId ?? ''),
        headed: tab.target.headed !== false,
        width: tab.target.width ?? tab.width ?? 1280,
        height: tab.target.height ?? tab.height ?? 720,
      };
    }
    if (tab.targetId === undefined || tab.targetId === null) return null;
    return {
      targetId: String(tab.targetId),
      headed: true,
      width: tab.width ?? 1280,
      height: tab.height ?? 720,
    };
  }

  presentationForTab(tabId: string) {
    const candidate = tabId === VIEW_DISPLAY_TAB_ID ? this.presentation?.display : this.presentation?.workspace;
    if (
      candidate &&
      (typeof candidate.attach === 'function' || typeof candidate.createSurface === 'function')
    )
      return candidate;
    return this.presentation;
  }

  presentationOwnsPlacement(presentation: WorkspacePresentation | undefined) {
    return presentation?.surfacePlacement === 'owner';
  }

  createPresentedSurface(tabId: string, target: WorkspaceTarget, presentationOverride?: WorkspacePresentation) {
    const presentation = presentationOverride ?? this.presentationForTab(tabId);
    if (typeof presentation?.createSurface !== 'function') return null;
    const surface = presentation.createSurface({
      tabId,
      target: target as EngineWorkspaceTarget,
      document: this.document,
    });
    if (surface === null || surface === undefined) return null;
    if (typeof surface !== 'object') {
      throw new TypeError('View target presentation createSurface must return a DOM element');
    }
    return surface as HTMLElement;
  }

  ensureSurface(tabId: string, target: WorkspaceTarget | null) {
    const targetId = target?.targetId === undefined ? null : String(target.targetId);
    const current = this.surfaceByTab.get(tabId);
    const presentation = this.presentationForTab(tabId);
    const surfacePlacement = this.presentationOwnsPlacement(presentation) ? 'owner' : 'shell';
    const exactIdentityMatches = sameTargetIdentity(current?.target, target);
    if (!targetId) {
      if (current) {
        // Keep an exact Engine surface as a short-lived tombstone while its
        // serialized detach is draining. A fast stop -> start can otherwise
        // acquire the same host surface before the old cleanup has restored
        // its origin, causing the old cleanup to delete the new origin map.
        // The next exact target reuses this entry and marks it for a queued
        // reacquisition after the old cleanup; inert surfaces can
        // still be discarded immediately.
        if (current.exactSurface) {
          if (current.targetId !== null) {
            current.targetId = null;
            current.target = null;
            current.reacquire = true;
            void this.detachTargetPresentation(tabId).catch((error) => this.fail(error));
          }
        } else {
          void this.detachTargetPresentation(tabId).catch((error) => this.fail(error));
          this.surfaceByTab.delete(tabId);
        }
      }
      return null;
    }
    if (
      current &&
      current.targetId === targetId &&
      (!current.exactSurface || exactIdentityMatches)
    ) {
      current.target = target;
      if (!current.exactSurface) {
        const width = target?.width ?? (current.surface as HTMLCanvasElement).width ?? 1280;
        const height = target?.height ?? (current.surface as HTMLCanvasElement).height ?? 720;
        if ((current.surface as HTMLCanvasElement).width !== width) (current.surface as HTMLCanvasElement).width = width;
        if ((current.surface as HTMLCanvasElement).height !== height) (current.surface as HTMLCanvasElement).height = height;
      }
      return current.surface;
    }
    // A host-provided exact surface is the Engine-owned presentation for this
    // tab, not a per-target canvas allocation. Keep its DOM identity stable
    // when the target identity is refreshed; the serialized presentation
    // lifecycle below still releases the old target before attaching the new
    // one. This also avoids calling createSurface while an earlier attachment
    // may still own the host surface.
    if (
      current &&
      current.exactSurface
    ) {
      current.targetId = targetId;
      current.target = target;
      current.reacquire = true;
      current.surfacePlacement = surfacePlacement;
      return current.surface;
    }
    if (current) {
      void this.detachTargetPresentation(tabId).catch((error) => this.fail(error));
    }
    if (!this.document?.createElement) return null;
    const presentedSurface = this.createPresentedSurface(tabId, target!, presentation);
    if ((surfacePlacement === 'owner' || typeof presentation?.createSurface === 'function') && presentedSurface === null) {
      // The display Fiber owns the only valid surface. During bootstrap it
      // may not exist yet; keep this tab surface-less and retry on a later
      // state/render transition instead of fabricating a second runtime node.
      this.surfaceByTab.delete(tabId);
      return null;
    }
    const surface = presentedSurface ?? this.document.createElement('canvas');
    const exactSurface = presentedSurface !== null;
    const resolvedSurfacePlacement = exactSurface && surfacePlacement === 'owner' ? 'owner' : 'shell';
    if (!exactSurface) {
      this.markSurface(surface, tabId, targetId);
      (surface as HTMLCanvasElement).width = target?.width ?? 1280;
      (surface as HTMLCanvasElement).height = target?.height ?? 720;
    }
    this.surfaceByTab.set(tabId, {
      targetId,
      target,
      exactSurface,
      surfacePlacement: resolvedSurfacePlacement,
      reacquire: false,
      surface,
    });
    return surface;
  }

  setActiveSurface() {
    const selected = this.surfaceByTab.get(this.state.selectedTabId ?? VIEW_WORKSPACE_TAB_ID);
    const active = selected?.targetId ? selected : null;
    this.surface = active?.surface ?? null;
    this.surfaceTargetId = active?.targetId ?? null;
    this.presentedTargetId = active?.targetId ?? null;
  }

  attachTargetPresentation(tabId: string, target: WorkspaceTarget | null, surface?: HTMLElement) {
    const presentation = this.presentationForTab(tabId);
    if (!target || !surface || (!presentation?.attach && !presentation?.createSurface)) return;
    const current = this.presentationByTab.get(tabId);
    if (current && sameTargetIdentity(current.target, target) && current.surface === surface &&
      current.generation === this.presentationGenerationByTab.get(tabId)) return;
    tracePresentationAttach(tabId, String(target.targetId), surface);
    const pending = this.presentationPending.get(tabId);
    if (pending && sameTargetIdentity(pending.target, target) && pending.surface === surface &&
      pending.generation === this.presentationGenerationByTab.get(tabId)) return;
    const generation = (this.presentationGenerationByTab.get(tabId) ?? 0) + 1;
    this.presentationGenerationByTab.set(tabId, generation);
    const task = this.enqueuePresentation(tabId, async () => {
      if (this.disposed || generation !== this.presentationGenerationByTab.get(tabId)) {
        await this.releaseUnattachedPresentation({ presentation, target, surface, tabId });
        return;
      }

      const previous = this.presentationByTab.get(tabId);
      if (previous) await this.releasePresentationEntry(tabId, previous);
      if (this.disposed || generation !== this.presentationGenerationByTab.get(tabId)) {
        await this.releaseUnattachedPresentation({ presentation, target, surface, tabId });
        return;
      }

      let attachSurface = surface;
      const surfaceEntry = this.surfaceByTab.get(tabId);
      if (surfaceEntry?.surface === surface && surfaceEntry.exactSurface && surfaceEntry.reacquire) {
        const refreshed = this.createPresentedSurface(tabId, target, presentation);
        if (refreshed !== null) {
          attachSurface = refreshed;
          surfaceEntry.surface = refreshed;
          surfaceEntry.reacquire = false;
        } else {
          // Do not reuse a released node when Engine cannot resolve the new identity.
          this.surfaceByTab.delete(tabId);
          this.setActiveSurface();
          return;
        }
      }
      // A previous Engine cleanup may have restored an exact surface to its
      // original parent. Adopt it only after that cleanup has completed, so a
      // stale cleanup can never move the new attachment out from underneath
      // the current tab.
      const restore = surfaceEntry?.exactSurface && surfaceEntry.surfacePlacement !== 'owner'
        ? borrowSurface(attachSurface, this.targetContainer!) : undefined;
      this.markSurface(attachSurface, tabId, target.targetId);
      this.adoptPresentationSurface(attachSurface, {
        external: surfaceEntry?.surfacePlacement === 'owner',
      });

      const entry: PresentationEntry = {
        target,
        targetId: String(target.targetId),
        surface: attachSurface,
        presentation,
        surfacePlacement: surfaceEntry?.surfacePlacement ?? 'shell',
        generation,
        remove: undefined,
        restore,
      };
      this.presentationByTab.set(tabId, entry);
      try {
        const remove = await presentation.attach?.({ target: target as EngineWorkspaceTarget, element: attachSurface, tabId });
        if (typeof remove === 'function') entry.remove = remove;
        if (
          this.presentationByTab.get(tabId) !== entry ||
          entry.generation !== this.presentationGenerationByTab.get(tabId) ||
          this.disposed
        ) {
          await this.releasePresentationEntry(tabId, entry);
          return;
        }
        entry.ready = true;
        this.setActiveSurface();
        this.render({ chromeChanged: false });
      } catch (error) {
        await this.releasePresentationEntry(tabId, entry).catch(() => {});
        // Keep this identity failed until an explicit target transition. Error
        // rendering must not recursively retry and re-adopt the returned node.
        entry.remove = () => {};
        entry.ready = false;
        this.presentationByTab.set(tabId, entry);
        throw error;
      }
    });
    const pendingEntry = { target, generation, surface, task };
    this.presentationPending.set(tabId, pendingEntry);
    void task.then(
      () => {
        if (this.presentationPending.get(tabId) === pendingEntry) this.presentationPending.delete(tabId);
      },
      (error) => {
        if (this.presentationPending.get(tabId) === pendingEntry) this.presentationPending.delete(tabId);
        this.fail(error);
      },
    );
  }

  markSurface(surface: HTMLElement, tabId: string, targetId: string) {
    surface.dataset.forgeaxViewTargetId = String(targetId);
    surface.dataset.forgeaxViewTabId = tabId;
    surface.dataset.forgeaxViewSurface = tabId === VIEW_DISPLAY_TAB_ID ? 'engine-target' : 'engine-canvas';
    surface.setAttribute?.('aria-label', `Engine target ${targetId}`);
  }

  enqueuePresentation(tabId: string, operation: () => Promise<void>) {
    const previous = this.presentationQueueByTab.get(tabId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    this.presentationQueueByTab.set(tabId, task);
    void task.then(
      () => {
        if (this.presentationQueueByTab.get(tabId) === task) this.presentationQueueByTab.delete(tabId);
      },
      () => {
        if (this.presentationQueueByTab.get(tabId) === task) this.presentationQueueByTab.delete(tabId);
      },
    );
    return task;
  }

  async runPresentationCleanup(remove: void | Dispose) {
    if (typeof remove === 'function') await Promise.resolve(remove());
  }

  async releaseUnattachedPresentation({ presentation, target, surface, tabId }: { presentation: WorkspacePresentation; target: WorkspaceTarget; surface: HTMLElement; tabId: string }) {
    if (this.presentationByTab.get(tabId)?.surface === surface) return;
    if (typeof presentation?.detach === 'function') {
      await Promise.resolve(presentation.detach({ target: target as EngineWorkspaceTarget, element: surface, tabId })).catch(() => {});
      return;
    }
    if (typeof presentation?.attach === 'function') {
      const remove = await presentation.attach({ target: target as EngineWorkspaceTarget, element: surface, tabId });
      await this.runPresentationCleanup(remove);
    }
  }

  adoptPresentationSurface(surface: HTMLElement, { external = false } = {}) {
    if (external || !surface || !this.targetContainer) return;
    if (surface.parentNode !== this.targetContainer) this.targetContainer.append?.(surface);
  }

  async releasePresentationEntry(tabId: string, entry: PresentationEntry) {
    if (this.presentationByTab.get(tabId) === entry) this.presentationByTab.delete(tabId);
    entry.restore?.();
    let failure;
    if (entry.remove) {
      try {
        await this.runPresentationCleanup(entry.remove);
      } catch (error) {
        failure = error;
      }
    }
    if (!entry.remove || failure !== undefined) {
      try {
        await Promise.resolve(
          entry.presentation?.detach?.({ target: entry.target as EngineWorkspaceTarget, element: entry.surface, tabId }),
        );
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  async detachTargetPresentation(tabId: string, { invalidate = true } = {}) {
    if (invalidate) {
      this.presentationGenerationByTab.set(
        tabId,
        (this.presentationGenerationByTab.get(tabId) ?? 0) + 1,
      );
    }
    return this.enqueuePresentation(tabId, async () => {
      const entry = this.presentationByTab.get(tabId);
      if (entry) await this.releasePresentationEntry(tabId, entry);
    });
  }

  ensureDom() {
    if (!this.element || !this.document) return false;
    if (this.rootElement) return true;

    const root = this.document.createElement('div');
    root.dataset.forgeaxViewWorkspace = 'root';
    this.rootElement = root;

    this.tabsElement = this.document.createElement('nav');
    this.tabsElement.dataset.forgeaxViewWorkspace = 'tabs';
    this.projectElement = this.document.createElement('div');
    this.projectElement.dataset.forgeaxViewWorkspace = 'project';
    this.workbenchElement = this.document.createElement('div');
    this.workbenchElement.dataset.forgeaxViewWorkspace = 'workbench';
    const rail = this.document.createElement('div');
    rail.dataset.forgeaxViewWorkspace = 'rail';
    this.assetsElement = this.document.createElement('ul');
    this.assetsElement.dataset.forgeaxViewWorkspace = 'assets';
    rail.append?.(this.assetsElement);
    this.previewElement = this.document.createElement('div');
    this.previewElement.dataset.forgeaxViewWorkspace = 'preview';
    this.previewInfoElement = this.document.createElement('div');
    this.previewInfoElement.dataset.forgeaxViewWorkspace = 'preview-info';
    this.targetContainer = this.document.createElement('div');
    this.targetContainer.dataset.forgeaxViewWorkspace = 'targets';
    if (this.targetContainer.style) this.targetContainer.style.position = 'relative';
    this.previewElement.append?.(...(this.presentationOnly ? [] : [this.previewInfoElement]), this.targetContainer);
    this.inspectorElement = this.document.createElement('aside');
    this.inspectorElement.dataset.forgeaxViewWorkspace = 'inspector';
    this.inspectorInfoElement = this.document.createElement('div');
    this.inspectorInfoElement.dataset.forgeaxViewWorkspace = 'inspector-info';
    this.inspectorFieldsElement = this.document.createElement('div');
    this.inspectorFieldsElement.dataset.forgeaxViewWorkspace = 'inspector-fields';
    this.inspectorActionsElement = this.document.createElement('div');
    this.inspectorActionsElement.dataset.forgeaxViewWorkspace = 'inspector-actions';
    this.inspectorElement.append?.(
      this.inspectorInfoElement,
      this.inspectorFieldsElement,
      this.inspectorActionsElement,
    );
    this.workbenchElement.append?.(
      ...(this.presentationOnly ? [] : [rail]),
      this.previewElement,
      ...(this.inspectorPanel ? [this.inspectorElement] : []),
    );
    if (!this.presentationOnly) {
      this.errorElement = this.document.createElement('div');
      this.errorElement.dataset.forgeaxViewWorkspace = 'error';
      this.errorElement.setAttribute?.('role', 'alert');
    }
    root.append?.(
      ...(this.presentationOnly ? [] : [this.tabsElement, this.projectElement]),
      this.workbenchElement,
      ...(this.errorElement ? [this.errorElement] : []),
    );
    if (root.parentNode !== this.element) this.element.append?.(root);
    this.stopSceneAdopt = keepSurfaceInContainer({
      document: this.document,
      getContainer: () => (this.disposed ? null : this.targetContainer),
      getSurface: () => readSceneShell(this.document),
      onPlace: (surface) => {
        if (!surface?.style) return;
        Object.assign(surface.style, {
          width: '100%',
          height: '100%',
          maxWidth: '100%',
          maxHeight: '100%',
          position: 'relative',
          transform: 'none',
          overflow: 'hidden',
        });
      },
    });
    traceShellRegisterDomRoot(root);
    return true;
  }

  syncTargetSurfaces() {
    const surfaces = this.targetContainer;
    if (!surfaces) return;
    let removed = 0;
    let reordered = 0;
    const desired: Element[] = [];
    for (const tabId of [VIEW_DISPLAY_TAB_ID, VIEW_WORKSPACE_TAB_ID]) {
      const entry = this.surfaceByTab.get(tabId);
      // An exact surface with no target is a detach-draining tombstone. It
      // must not be presented or reattached until the next target adopts it.
      if (!entry || !entry.targetId || !entry.target) continue;
      this.attachTargetPresentation(tabId, entry.target, entry.surface);
      const attached = this.presentationByTab.get(tabId);
      // Render cannot move an exact node ahead of the serialized cleanup.
      if (entry.exactSurface && (!attached?.ready || !sameTargetIdentity(attached.target, entry.target))) continue;
      const selected = this.state.selectedTabId === tabId &&
        !(tabId === VIEW_WORKSPACE_TAB_ID &&
          (this.state.targetBinding === 'play' || this.state.play?.phase === 'starting'));
      // The borrowed CLI carrier stays active across tab changes. Workspace
      // previews can stop background rendering when their presentation is hidden.
      if (entry.exactSurface && tabId === VIEW_DISPLAY_TAB_ID) {
        if (entry.surface.hidden !== false) entry.surface.hidden = false;
        if (entry.surface.style) {
          const visibility = selected ? 'visible' : 'hidden';
          const pointerEvents = selected ? 'auto' : 'none';
          if (entry.surface.style.visibility !== visibility) entry.surface.style.visibility = visibility;
          if (entry.surface.style.pointerEvents !== pointerEvents) entry.surface.style.pointerEvents = pointerEvents;
        }
      } else {
        const hidden = !selected;
        if (entry.surface.hidden !== hidden) entry.surface.hidden = hidden;
        if (entry.surface.style) {
          const display = selected ? '' : 'none';
          if (entry.surface.style.display !== display) entry.surface.style.display = display;
        }
      }
      const selectedMark = selected ? 'true' : 'false';
      if (entry.surface.dataset.forgeaxViewSelected !== selectedMark) {
        entry.surface.dataset.forgeaxViewSelected = selectedMark;
      }
      if (entry.surfacePlacement !== 'owner') desired.push(entry.surface);
    }

    for (const child of [...(surfaces.children ?? [])]) {
      if (!desired.includes(child)) {
        if (child?.id === 'app-shell') continue;
        if ([...this.presentationByTab.values()].some(entry => entry.surface === child)) continue;
        child.remove?.();
        removed += 1;
      }
    }
    for (let index = 0; index < desired.length; index += 1) {
      const surface = desired[index];
      if (surfaces.children?.[index] === surface) continue;
      reordered += 1;
      const before = surfaces.children?.[index] ?? null;
      if (surfaces.insertBefore) surfaces.insertBefore(surface, before);
      else surfaces.append?.(surface);
    }
    traceSyncTargetSurfaces({ removed, reordered, desired: desired.length });
  }

  render({ chromeChanged = true } = {}) {
    if (this.disposed || !this.element || !this.document) return;
    const renderStarted = isViewTraceEnabled() ? performance.now() : 0;
    const workspaceTarget = this.targetForTab(VIEW_WORKSPACE_TAB_ID);
    const displayTarget = this.targetForTab(VIEW_DISPLAY_TAB_ID);
    this.ensureSurface(VIEW_WORKSPACE_TAB_ID, workspaceTarget);
    this.ensureSurface(VIEW_DISPLAY_TAB_ID, displayTarget);
    this.setActiveSurface();
    const nextTargetId = workspaceTarget?.targetId ?? null;
    const workspaceSurfaceEntry = this.surfaceByTab.get(VIEW_WORKSPACE_TAB_ID);
    if (nextTargetId !== this.inputTargetId || workspaceTarget?.generation !== this.inputTargetGeneration ||
      workspaceSurfaceEntry?.surface !== this.inputSurface) {
      this.detachInput('target-replaced');
      this.removeInput?.();
      this.removeInput = undefined;
      this.inputController = undefined;
      this.inputTargetId = nextTargetId;
      this.inputTargetGeneration = workspaceTarget?.generation;
      this.inputSurface = workspaceSurfaceEntry?.surface;
    }
    if (!this.ensureDom()) return;
    let domReplaceChildren = 0;
    const tabs = this.tabsElement;
    const project = this.projectElement;
    const assets = this.assetsElement;
    const previewInfo = this.previewInfoElement;
    const inspectorInfo = this.inspectorInfoElement;
    const inspectorFields = this.inspectorFieldsElement;
    const inspectorActions = this.inspectorActionsElement;
    const error = this.errorElement;
    if (chromeChanged) {
    if (tabs?.replaceChildren) {
      tabs.replaceChildren();
      domReplaceChildren += 1;
    }
    for (const tab of this.state.tabs ?? []) {
      tabs?.append?.(
        button(this.document, `${tab.kind}: ${tab.tabId}`, () => this.selectTab(tab.tabId), {
          disabled: tab.selected === true,
        }),
      );
    }
    if (project?.replaceChildren) {
      project.replaceChildren();
      domReplaceChildren += 1;
    }
    if (this.state.project) {
      project?.append?.(text(this.document, `Project: ${this.state.project.name ?? this.state.project.id}`));
      project?.append?.(button(this.document, 'Refresh assets', () => this.refreshAssets()));
      project?.append?.(button(this.document, 'Close project', () => this.closeProject()));
    } else {
      project?.append?.(
        text(this.document, 'Project opens from the View owner process.'),
      );
    }
    if (this.state.workspaceTargetLost && this.state.project?.root) {
      const reconnectLabel = this.state.projectReconnecting ? 'Reconnecting project…' : 'Reconnect project';
      project?.append?.(
        button(this.document, reconnectLabel, () => this.reconnectProject(), {
          disabled: this.state.projectReconnecting === true,
        }),
      );
    }
    if (assets?.replaceChildren) {
      assets.replaceChildren();
      domReplaceChildren += 1;
    }
    for (const group of groupAssetsBySource(this.state.assets)) {
      const item = this.document.createElement('li');
      item.dataset.forgeaxViewWorkspace = 'asset-group';
      item.dataset.sourcePath = group.key;
      item.append?.(text(this.document, group.key));
      const members = this.document.createElement('ul');
      for (const asset of group.assets) {
        const member = this.document.createElement('li');
        member.dataset.forgeaxViewWorkspace = 'asset';
        member.dataset.guid = asset.guid;
        member.dataset.kind = asset.kind;
        if (asset.sourceKind) member.dataset.sourceKind = asset.sourceKind;
        const ddcState = catalogDdcState(asset, this.state.inspection);
        const receipt = catalogReceipt(asset, this.state.inspection);
        if (ddcState) member.dataset.ddcState = ddcState;
        if (receipt) member.dataset.cookReceiptUrl = receipt;
        const selected = this.state.inspection?.guid === asset.guid;
        const label = `${asset.name ?? asset.guid} (${asset.kind}${ddcState ? ` · ${ddcState}` : ''})`;
        member.append?.(
          button(this.document, label, () => this.selectAsset(asset.guid), {
            disabled: selected,
          }),
        );
        members.append?.(member);
      }
      item.append?.(members);
      assets?.append?.(item);
    }
    if (previewInfo?.replaceChildren) {
      previewInfo.replaceChildren();
      domReplaceChildren += 1;
    }
    if (this.state.preview) {
      previewInfo?.append?.(
        text(this.document, `Target: ${this.state.preview.asset?.name ?? this.state.preview.asset?.guid ?? 'Game'}`),
        ...(this.state.preview.asset ? [button(this.document, 'Close preview', () => this.closePreview())] : []),
      );
    } else {
      previewInfo?.append?.(text(this.document, 'No asset preview open'));
    }
    if (inspectorInfo?.replaceChildren) {
      inspectorInfo.replaceChildren();
      domReplaceChildren += 1;
    }
    if (inspectorFields?.replaceChildren) {
      inspectorFields.replaceChildren();
      domReplaceChildren += 1;
    }
    if (inspectorActions?.replaceChildren) {
      inspectorActions.replaceChildren();
      domReplaceChildren += 1;
    }
    const inspection = this.state.inspection;
    if (this.state.inspectorError) {
      inspectorInfo?.append?.(text(this.document, `Inspector: ${this.state.inspectorError}`));
    } else if (inspection) {
      inspectorInfo?.append?.(
        text(
          this.document,
          `${inspection.asset?.name ?? inspection.guid} · ${inspection.source?.kind ?? inspection.asset?.sourceKind ?? inspection.asset?.kind} · ${inspection.source?.path ?? inspection.asset?.sourcePath ?? ''}${inspection.revision ? ` · rev ${inspection.revision.slice(0, 12)}` : ''}${inspection.ddc?.receiptUrl ? ` · ${inspection.ddc.receiptUrl}` : ''}`,
        ),
      );
      const meta = inspection.meta;
      if (meta) {
        const identity = this.document.createElement('div');
        identity.dataset.forgeaxViewWorkspace = 'pack-meta';
        identity.append?.(
          text(
            this.document,
            `${meta.packageId ?? ''} · ${meta.importer ?? ''} · ${meta.source ?? ''}`,
          ),
        );
        inspectorFields?.append?.(identity);
        for (const sub of (meta.subAssets as readonly { guid: string; kind: string; name?: string; sourceKey?: string }[] | undefined) ?? []) {
          const row = this.document.createElement('div');
          row.dataset.forgeaxViewWorkspace = 'sub-asset';
          row.dataset.guid = sub.guid;
          row.dataset.kind = sub.kind;
          row.append?.(text(this.document, `${sub.name ?? sub.sourceKey} (${sub.kind})`));
          inspectorFields?.append?.(row);
        }
      }
      inspectorActions?.append?.(
        button(this.document, 'Rebuild', () => this.cookSelected('rebuild')),
        button(this.document, 'Cold-cook', () => this.cookSelected('cold-cook')),
      );
    } else {
      inspectorInfo?.append?.(text(this.document, 'Select an asset to inspect Engine catalog and pack meta'));
    }
    }
    this.syncTargetSurfaces();
    const nextError = this.state.error ? `Error: ${this.state.error}` : '';
    const nextHidden = !this.state.error;
    if (error) {
      if (error.hidden !== nextHidden) error.hidden = nextHidden;
      if (error.textContent !== nextError) error.textContent = nextError;
    }
    const workspaceSurface = this.surfaceByTab.get(VIEW_WORKSPACE_TAB_ID)?.surface;
    if (
      nextTargetId &&
      workspaceSurface &&
      this.api &&
      this.removeInput === undefined &&
      (!workspaceSurfaceEntry?.exactSurface ||
        (this.presentationByTab.get(VIEW_WORKSPACE_TAB_ID)?.ready &&
          sameTargetIdentity(this.presentationByTab.get(VIEW_WORKSPACE_TAB_ID)?.target, workspaceTarget))) &&
      this.state.selectedTabId === VIEW_WORKSPACE_TAB_ID
    ) {
      this.inputController = this.inputControllerFactory({
        api: createViewportInputApi(this.api, this.presentationForTab(VIEW_WORKSPACE_TAB_ID), workspaceTarget as EngineWorkspaceTarget),
        targetId: nextTargetId,
        targetGeneration: workspaceTarget?.generation,
        tabId: VIEW_WORKSPACE_TAB_ID,
        window: this.window,
        document: this.document,
        onError: (error) => this.fail(error),
        onFocusSelection: () => {
          const selected = this.state.sceneSelection;
          if (selected?.primary?.entityId) return this.api?.call('entity.focus', {
            entityId: selected.primary.entityId, targetId: nextTargetId, targetGeneration: workspaceTarget?.generation,
          });
        },
        shouldCapture: (event) => isViewportWorkspaceInputEvent(event, { surface: workspaceSurface, host: this.element }),
      });
      this.removeInput = this.inputController.attach(workspaceSurface);
    }
    traceShellRender({
      durationMs: renderStarted ? Math.round((performance.now() - renderStarted) * 100) / 100 : undefined,
      workspaceSurface: workspaceSurface?.dataset?.forgeaxViewSurface,
      exactSurface: this.surfaceByTab.get(VIEW_WORKSPACE_TAB_ID)?.exactSurface,
      inputBound: this.removeInput !== undefined,
      presentationOnly: this.presentationOnly,
      domReplaceChildren,
      tabCount: (this.state.tabs ?? []).length,
      assetCount: (this.state.assets ?? []).length,
    });
  }

  /** Detach local DOM listeners before a tab/target/disconnect transition. */
  detachInput(reason: string = 'input-detached') {
    const controller = this.inputController;
    const remove = this.removeInput;
    this.removeInput = undefined;
    this.inputController = undefined;
    if (remove) {
      remove(reason);
    }
    if (!remove?.handlesAbort) {
      void Promise.resolve(controller?.abort?.(reason)).catch((error) => this.fail(error));
    }
  }

  dispose() {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.stopSceneAdopt?.();
    this.stopSceneAdopt = undefined;
    // Parent panels may disappear before asynchronous input/adapter cleanup.
    // Pending tasks see disposed and cannot adopt another borrowed node.
    for (const entry of this.presentationByTab.values()) entry.restore?.();
    this.disposal = this.finishDisposal();
    return this.disposal;
  }

  async finishDisposal() {
    const removeInput = this.removeInput;
    const inputController = this.inputController;
    this.removeInput = undefined;
    removeInput?.('input-disposed');
    const inputDisposal = inputController?.dispose?.().catch(() => {});
    this.inputController = undefined;
    this.removeSubscription?.();
    this.removeSubscription = undefined;
    this.removeDisconnect?.();
    this.removeDisconnect = undefined;
    const presentationTabs = new Set([
      ...this.surfaceByTab.keys(),
      ...this.presentationByTab.keys(),
      ...this.presentationPending.keys(),
      ...this.presentationQueueByTab.keys(),
    ]);
    for (const tabId of presentationTabs) {
      this.presentationGenerationByTab.set(
        tabId,
        (this.presentationGenerationByTab.get(tabId) ?? 0) + 1,
      );
    }
    await Promise.all([
      inputDisposal,
      ...[...presentationTabs].map((tabId) => this.detachTargetPresentation(tabId, { invalidate: false }).catch(() => {})),
    ]);
    this.presentationPending.clear();
    this.presentationQueueByTab.clear();
    this.presentationGenerationByTab.clear();
    this.surfaceByTab.clear();
    this.rootElement = null;
    this.targetContainer = null;
    this.removeSurfacePresentation = undefined;
    this.inputTargetId = null;
    this.surfaceTargetId = null;
    this.presentedTargetId = null;
    this.surface = null;
    this.element?.remove?.();
    this.element = null;
  }
}

export { VIEW_DISPLAY_TAB_ID, VIEW_WORKSPACE_TAB_ID };
