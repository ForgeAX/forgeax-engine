import {
  type ActionConfig,
  type ActionState,
  attachBrowserInputBackend,
  type BrowserInputBackendOptions,
  deriveActionStates,
  type InputBackend,
  type InputSnapshot,
  snapshotFromSample,
} from '@forgeax/engine/input';

export interface PrivateBackend {
  readonly win: EventTarget;
  readonly canvas: HTMLCanvasElement;
  readonly clock: { now: number };
  readonly backend: InputBackend;
  focused: boolean;
  step(inputMap?: readonly ActionConfig[]): InputSnapshot;
  key(type: 'keydown' | 'keyup', key: string, code: string): void;
  pointer(type: string, init: PointerEventInit & { x?: number; y?: number }): void;
  dispose(): void;
}

/**
 * A backend attached to a private window/document/canvas so synthetic events never
 * reach the live App; `step()` samples exactly one frame through snapshotFromSample.
 */
export function privateBackend(
  options: Omit<BrowserInputBackendOptions, 'window' | 'document' | 'now'> = {},
): PrivateBackend {
  const win = new EventTarget();
  const state = { focused: true };
  const doc = Object.assign(new EventTarget(), {
    hasFocus: () => state.focused,
    pointerLockElement: null,
  });
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 100;
  canvas.style.cssText =
    'position:fixed;left:0;top:0;width:200px;height:100px;opacity:0;pointer-events:none';
  document.body.appendChild(canvas);
  const clock = { now: 1000 };
  const detach = attachBrowserInputBackend(canvas, {
    ...options,
    window: win as unknown as Window,
    document: doc as unknown as Document,
    now: () => clock.now,
  });
  let previous: InputSnapshot | undefined;
  let actions: ActionState[] | undefined;
  const handle: PrivateBackend = {
    win,
    canvas,
    clock,
    backend: detach.backend,
    get focused() {
      return state.focused;
    },
    set focused(value: boolean) {
      state.focused = value;
    },
    step(inputMap) {
      const sample = detach.backend.sample();
      actions = inputMap === undefined ? undefined : deriveActionStates(sample, inputMap, actions);
      previous = snapshotFromSample(sample, actions, previous);
      return previous;
    },
    key(type, key, code) {
      win.dispatchEvent(new KeyboardEvent(type, { key, code }));
    },
    pointer(type, init) {
      const rect = canvas.getBoundingClientRect();
      const event = new PointerEvent(type, {
        bubbles: true,
        pointerType: 'mouse',
        pointerId: 1,
        pressure: 0.5,
        ...init,
        clientX: rect.left + (init.x ?? 0),
        clientY: rect.top + (init.y ?? 0),
      });
      canvas.dispatchEvent(event);
    },
    dispose() {
      detach();
      canvas.remove();
    },
  };
  return handle;
}
