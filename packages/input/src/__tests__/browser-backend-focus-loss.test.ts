import { describe, expect, it } from 'vitest';
import { deriveActionStates } from '../action-state';
import { attachBrowserInputBackend } from '../browser-backend';
import { snapshotFromSample } from '../input-snapshot';

type Listener = (event: Event) => void;

interface FocusLossEnv {
  readonly backend: ReturnType<typeof attachBrowserInputBackend>['backend'];
  readonly canvas: HTMLCanvasElement;
  readonly pad: {
    readonly index: number;
    readonly id: string;
    readonly connected: boolean;
    readonly mapping: string;
    readonly buttons: { value: number; pressed: boolean }[];
    readonly axes: number[];
  };
  readonly exitPointerLockCalls: { count: number };
  setFocused(value: boolean): void;
  setVisibility(value: 'visible' | 'hidden'): void;
  fire(target: 'canvas' | 'document' | 'window', kind: string, event: Event): void;
  lockCanvas(): void;
  unlockCanvas(): void;
}

function buildFocusLossEnv(): FocusLossEnv {
  const listeners = new Map<string, Map<string, Set<Listener>>>();
  const makeTarget = (label: string) => ({
    addEventListener(kind: string, listener: Listener): void {
      let targetListeners = listeners.get(label);
      if (!targetListeners) {
        targetListeners = new Map();
        listeners.set(label, targetListeners);
      }
      let kindListeners = targetListeners.get(kind);
      if (!kindListeners) {
        kindListeners = new Set();
        targetListeners.set(kind, kindListeners);
      }
      kindListeners.add(listener);
    },
    removeEventListener(kind: string, listener: Listener): void {
      listeners.get(label)?.get(kind)?.delete(listener);
    },
  });

  let focused = true;
  let visibility: 'visible' | 'hidden' = 'visible';
  let pointerLockElement: Element | null = null;
  const exitPointerLockCalls = { count: 0 };
  const pad = {
    index: 0,
    id: 'm19-test-pad',
    connected: true,
    mapping: 'standard',
    buttons: Array.from({ length: 17 }, (_, index) => ({
      value: index === 0 ? 1 : 0,
      pressed: index === 0,
    })),
    axes: [0, 0, 0, 0],
  };

  const canvas = {
    ...makeTarget('canvas'),
    requestPointerLock() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
    width: 800,
    height: 600,
    style: { touchAction: '' },
    setPointerCapture() {},
  } as unknown as HTMLCanvasElement;

  const doc = {
    ...makeTarget('document'),
    hasFocus() {
      return focused;
    },
    get visibilityState() {
      return visibility;
    },
    get pointerLockElement() {
      return pointerLockElement;
    },
    exitPointerLock() {
      exitPointerLockCalls.count += 1;
      // Deliberately do not emit pointerlockchange: blur must publish the
      // unlocked state immediately instead of waiting for the browser event.
      pointerLockElement = null;
    },
  } as unknown as Document;

  const win = makeTarget('window') as unknown as Window;
  const handle = attachBrowserInputBackend(canvas, {
    document: doc,
    window: win,
    navigator: { getGamepads: () => [pad] as unknown as Gamepad[] },
  });

  return {
    backend: handle.backend,
    canvas,
    pad,
    exitPointerLockCalls,
    setFocused(value) {
      focused = value;
    },
    setVisibility(value) {
      visibility = value;
    },
    fire(target, kind, event) {
      for (const listener of listeners.get(target)?.get(kind) ?? []) listener(event);
    },
    lockCanvas() {
      pointerLockElement = canvas;
      for (const listener of listeners.get('document')?.get('pointerlockchange') ?? []) {
        listener({} as Event);
      }
    },
    unlockCanvas() {
      pointerLockElement = null;
      for (const listener of listeners.get('document')?.get('pointerlockchange') ?? []) {
        listener({} as Event);
      }
    },
  };
}

function pointerEvent(
  phase: 'down' | 'move',
  pointerId: number,
  pointerType: 'mouse' | 'touch',
  x: number,
  y: number,
): Event {
  return {
    pointerId,
    pointerType,
    button: pointerType === 'mouse' ? 0 : -1,
    clientX: x,
    clientY: y,
    pressure: pointerType === 'touch' ? 1 : 0.5,
    movementX: phase === 'move' ? 1 : 0,
    movementY: phase === 'move' ? 1 : 0,
  } as unknown as Event;
}

describe('browser-backend focus loss', () => {
  it('cancels live input, releases W3C lock, and baselines a held gamepad', () => {
    const env = buildFocusLossEnv();

    // Establish the initial gamepad baseline before any held input is acquired.
    env.backend.sample();
    env.backend.sample();
    env.lockCanvas();
    env.fire('window', 'keydown', { key: 'w', code: 'KeyW' } as unknown as Event);
    env.fire('canvas', 'pointerdown', pointerEvent('down', 10, 'touch', 100, 200));
    env.fire('canvas', 'pointerdown', pointerEvent('down', 11, 'touch', 200, 200));
    env.fire('canvas', 'pointerdown', pointerEvent('down', 1, 'mouse', 400, 300));
    const gestureStarted = env.backend.sample();
    expect(gestureStarted.gestureEvents?.map((event) => event.kind)).toContain('pinch-begin');
    env.fire('canvas', 'pointermove', pointerEvent('move', 10, 'touch', 80, 200));
    env.fire('canvas', 'pointermove', pointerEvent('move', 11, 'touch', 240, 200));

    const acquired = env.backend.sample();
    expect(acquired.downCodes?.has('KeyW')).toBe(true);
    expect(acquired.pointers).toHaveLength(3);
    expect(acquired.gestures?.pinchScale).toBeGreaterThan(1);
    expect(acquired.pointerLocked).toBe(true);
    expect(acquired.buttons).toEqual([true, false, false]);
    expect(acquired.gamepads?.[0]?.pressed.has(0)).toBe(true);
    expect(acquired.gamepads?.[0]?.justPressed.has(0)).toBe(false);

    env.setFocused(false);
    env.setVisibility('hidden');
    env.fire('document', 'visibilitychange', {} as Event);
    expect(env.exitPointerLockCalls.count).toBe(1);

    const cancelled = env.backend.sample();
    expect(cancelled.downKeys.size).toBe(0);
    expect(cancelled.downCodes?.size).toBe(0);
    expect(cancelled.pressedKeys?.size).toBe(0);
    expect(cancelled.pressedCodes?.size).toBe(0);
    expect(cancelled.buttons).toEqual([false, false, false]);
    expect(cancelled.pressedButtons).toEqual([false, false, false]);
    expect(cancelled.releasedButtons).toEqual([false, false, false]);
    expect(cancelled.focusReset).toBe(true);
    expect(cancelled.pointerLocked).toBe(false);
    expect(cancelled.pointers).toBeUndefined();
    expect(cancelled.pointerEvents?.map((event) => event.phase)).toEqual([
      'cancel',
      'cancel',
      'cancel',
    ]);
    expect(cancelled.gestures).toBeUndefined();
    expect(cancelled.gestureEvents?.map((event) => event.kind)).toContain('pinch-cancel');
    expect(cancelled.gamepads?.[0]?.pressed.has(0)).toBe(true);
    expect(cancelled.gamepads?.[0]?.justPressed.has(0)).toBe(false);
    expect(cancelled.gamepads?.[0]?.justReleased.has(0)).toBe(false);
    const previousSnapshot = snapshotFromSample(acquired);
    expect(snapshotFromSample(cancelled, undefined, previousSnapshot).mouse.justReleased(0)).toBe(
      false,
    );
    const inputMap = [
      { action: 'keyboard', bindings: [{ type: 'key' as const, key: 'w' }] },
      { action: 'mouse', bindings: [{ type: 'mouseButton' as const, button: 0 as const }] },
    ];
    const previousActions = deriveActionStates(acquired, inputMap);
    const resetActions = deriveActionStates(cancelled, inputMap, previousActions);
    expect(resetActions.every((action) => action.justReleased === false)).toBe(true);

    const stableAfterLoss = env.backend.sample();
    expect(stableAfterLoss.gamepads?.[0]?.justPressed.has(0)).toBe(false);
    expect(stableAfterLoss.gamepads?.[0]?.justReleased.has(0)).toBe(false);

    // A physical transition after the loss is a new edge; the old held state
    // is not replayed merely because the tab became visible again.
    env.pad.buttons[0] = { value: 0, pressed: false };
    const released = env.backend.sample();
    expect(released.gamepads?.[0]?.justReleased.has(0)).toBe(true);
    env.pad.buttons[0] = { value: 1, pressed: true };
    const reacquired = env.backend.sample();
    expect(reacquired.gamepads?.[0]?.justPressed.has(0)).toBe(true);
  });

  it('treats a native pointer-lock exit as an input lifecycle boundary', () => {
    const env = buildFocusLossEnv();
    env.backend.sample();
    env.lockCanvas();
    env.fire('window', 'keydown', { key: 'w', code: 'KeyW' } as unknown as Event);
    env.fire('canvas', 'pointerdown', pointerEvent('down', 1, 'mouse', 400, 300));
    const acquired = env.backend.sample();
    expect(acquired.downCodes?.has('KeyW')).toBe(true);
    expect(acquired.pointerLocked).toBe(true);

    env.unlockCanvas();
    const reset = env.backend.sample();
    expect(reset.downCodes?.size).toBe(0);
    expect(reset.pointerLocked).toBe(false);
    expect(reset.focusReset).toBe(true);
    expect(reset.pointerEvents?.map((event) => event.phase)).toEqual(['cancel']);
  });
});
