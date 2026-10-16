import { Update } from '@forgeax/engine-ecs';
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=5):
//   - packages/input/src/__tests__/browser-backend-wheel-normalization.test.ts
//   - packages/input/src/__tests__/browser-backend.test.ts
//   - packages/input/src/__tests__/frame-start-scan-system.test.ts
//   - packages/input/src/__tests__/input-snapshot.test.ts
//   - packages/input/src/__tests__/wheel-delta.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
//
// Note: merged from src/__tests__/ into __tests__/; import paths adjusted (../ → ../src/).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { attachBrowserInputBackend, coercePointerType } from '../src/browser-backend';
import {
  buildGuidFromVidPid,
  extractGuidFromGamepadId,
  type MappingTokens,
  parseControllerDb,
  platformFromUserAgent,
  selectBestMappingEntry,
} from '../src/controller-db';
import type {
  Capabilities,
  GamepadSlotSample,
  PointerPhaseEvent,
  VirtualJoystickConfig,
} from '../src/input-snapshot';
import {
  createInputSnapshot,
  INPUT_BACKEND_KEY,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputBackend,
  InputFrameStartScan,
  type InputSnapshot,
  type PointerType,
  snapshotFromSample,
} from '../src/index';
import { diffGamepadFrame, type RawGamepadStub } from '../src/gamepad-frame';
import {
  deriveVirtualAxes,
  handleVirtualJoystickUnbind,
  type BindState,
} from '../src/virtual-joystick';
import {
  deriveActionStates,
  getAxis,
  getVector,
  type ActionConfig,
  type ActionState,
  type GetVectorOptions,
} from '../src/action-state';
import {
  createRecognizerState,
  DOUBLE_TAP_DISTANCE,
  DOUBLE_TAP_INTERVAL_MS,
  type GestureEvent,
  type GestureState,
  LONG_PRESS_DURATION_MS,
  LONG_PRESS_SLOP,
  processGestureFrame,
  type RecognizerPointer,
  type RecognizerState,
  SWIPE_VELOCITY_THRESHOLD,
  SWIPE_WINDOW_MS,
} from '../src/gesture-recognizer';

/**
 * Build a standard-layout GamepadSlotSample for test injection.
 * Standard mapping has 17 buttons (0-16) and 4 axes (0-3).
 */
function buildGamepadSlot(index: number, overrides?: {
  pressed?: number[];
  justPressed?: number[];
  justReleased?: number[];
  buttonValues?: Map<number, number>;
  axes?: [number, number, number, number];
  standardMapping?: boolean;
}): GamepadSlotSample {
  return {
    index,
    standardMapping: overrides?.standardMapping ?? true,
    pressed: new Set(overrides?.pressed ?? []),
    justPressed: new Set(overrides?.justPressed ?? []),
    justReleased: new Set(overrides?.justReleased ?? []),
    buttonValues: overrides?.buttonValues ?? new Map(),
    axes: overrides?.axes ?? [0, 0, 0, 0],
  };
}

interface FakeListenerStore {
  fire(target: string, kind: string, ev: Partial<WheelEvent | KeyboardEvent | MouseEvent>): void;
}

/**
 * Extended fixtureBackend with optional gamepad/capability fields for M1+ testing.
 * Defined at top level so all test blocks can access it.
 */
function fixtureBackend(initial: {
  downKeys?: ReadonlySet<string>;
  upKeys?: ReadonlySet<string>;
  buttons?: readonly [boolean, boolean, boolean];
  movementX?: number;
  movementY?: number;
  wheelDelta?: number;
  focused?: boolean;
  pointerLocked?: boolean;
  gamepads?: readonly GamepadSlotSample[];
  capabilities?: Capabilities;
  pointers?: readonly import('../src/input-snapshot').PointerSample[];
  pointerEvents?: readonly import('../src/input-snapshot').PointerPhaseEvent[];
}): InputBackend & { sampleCalls: number } {
  let calls = 0;
  return {
    sample(): {
      downKeys: ReadonlySet<string>;
      upKeys: ReadonlySet<string>;
      buttons: readonly [boolean, boolean, boolean];
      movementX: number;
      movementY: number;
      wheelDelta: number;
      focused: boolean;
      pointerLocked: boolean;
      gamepads?: readonly GamepadSlotSample[];
      capabilities?: Capabilities;
      pointers?: readonly import('../src/input-snapshot').PointerSample[];
      pointerEvents?: readonly import('../src/input-snapshot').PointerPhaseEvent[];
    } {
      calls += 1;
      return {
        downKeys: initial.downKeys ?? new Set<string>(),
        upKeys: initial.upKeys ?? new Set<string>(),
        buttons: initial.buttons ?? [false, false, false],
        movementX: initial.movementX ?? 0,
        movementY: initial.movementY ?? 0,
        wheelDelta: initial.wheelDelta ?? 0,
        focused: initial.focused ?? true,
        pointerLocked: initial.pointerLocked ?? false,
        gamepads: initial.gamepads,
        capabilities: initial.capabilities,
        pointers: initial.pointers,
        pointerEvents: initial.pointerEvents,
      };
    },
    detach() {},
    get sampleCalls() {
      return calls;
    },
  } as InputBackend & { sampleCalls: number };
}

void [DOUBLE_TAP_DISTANCE, DOUBLE_TAP_INTERVAL_MS, INPUT_BACKEND_KEY, INPUT_SNAPSHOT_RESOURCE_KEY, InputFrameStartScan, LONG_PRESS_DURATION_MS, LONG_PRESS_SLOP, SWIPE_VELOCITY_THRESHOLD, SWIPE_WINDOW_MS, Update, World, attachBrowserInputBackend, buildGamepadSlot, buildGuidFromVidPid, coercePointerType, createInputSnapshot, createRecognizerState, deriveActionStates, deriveVirtualAxes, describe, diffGamepadFrame, expect, extractGuidFromGamepadId, fileURLToPath, fixtureBackend, getAxis, getVector, handleVirtualJoystickUnbind, it, parseControllerDb, platformFromUserAgent, processGestureFrame, readFileSync, selectBestMappingEntry, snapshotFromSample];
type __MergedKeep = ActionConfig | ActionState | BindState | Capabilities | FakeListenerStore | GamepadSlotSample | GestureEvent | GestureState | GetVectorOptions | InputBackend | InputSnapshot | MappingTokens | PointerPhaseEvent | PointerType | RawGamepadStub | RecognizerPointer | RecognizerState | VirtualJoystickConfig;

// Split source block: F3 virtual joystick origin selection via real backend.
{
  interface VJBB {
    canvas: HTMLCanvasElement;
    store: {
      fire(target: string, kind: string, ev: Partial<PointerEvent> & { clientX?: number; clientY?: number }): void;
    };
  }

  function buildVJFakes(): VJBB & {
    doc: Document;
    win: Window;
  } {
    const listeners = new Map<string, Map<string, Set<EventListener>>>();

    const makeTarget = (label: string) => ({
      addEventListener(kind: string, handler: EventListener): void {
        let perTarget = listeners.get(label);
        if (!perTarget) { perTarget = new Map(); listeners.set(label, perTarget); }
        let set = perTarget.get(kind);
        if (!set) { set = new Set(); perTarget.set(kind, set); }
        set.add(handler);
      },
      removeEventListener(kind: string, handler: EventListener): void {
        listeners.get(label)?.get(kind)?.delete(handler);
      },
    });

    const canvas = {
      ...makeTarget('canvas'),
      requestPointerLock(): void {},
      setPointerCapture(): void {},
      getBoundingClientRect(): DOMRect {
        return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 } as DOMRect;
      },
      width: 800,
      height: 600,
      style: {} as CSSStyleDeclaration,
    } as unknown as HTMLCanvasElement;

    const doc = {
      hasFocus(): boolean { return true; },
      pointerLockElement: null,
      exitPointerLock(): void {},
    } as unknown as Document;

    const win = makeTarget('window') as unknown as Window;

    const store = {
      fire(target: string, kind: string, ev: Partial<PointerEvent> & { clientX?: number; clientY?: number }): void {
        const handlers = listeners.get(target)?.get(kind);
        if (!handlers) return;
        const full = {
          pointerType: 'touch',
          pointerId: 1,
          button: 0,
          pressure: 1,
          clientX: 0,
          clientY: 0,
          ...ev,
          movementX: ev.movementX ?? 0,
          movementY: ev.movementY ?? 0,
        };
        for (const h of handlers) {
          h(full as unknown as Event);
        }
      },
    };
    return { canvas, doc, win, store };
  }

  describe('VJ origin selection via real backend (F-3b / AC-11)', () => {
    const fixedConfig: VirtualJoystickConfig = {
      name: 'move',
      mode: 'fixed',
      region: { x: 0, y: 0, width: 200, height: 200 },
      anchor: { x: 100, y: 100 },
      radius: 50,
      deadzone: 0.1,
    };

    const floatingConfig: VirtualJoystickConfig = {
      name: 'look',
      mode: 'floating',
      region: { x: 300, y: 0, width: 200, height: 200 },
      radius: 60,
      deadzone: 0.05,
    };

    it('fixed mode: pointerdown at (50,50) uses anchor (100,100) as origin', () => {
      const { canvas, store } = buildVJFakes();
      const handle = attachBrowserInputBackend(canvas, { virtualJoysticks: [fixedConfig] });

      // Pointerdown at (50,50) inside region — fixed mode should use anchor (100,100).
      store.fire('canvas', 'pointerdown', { pointerId: 1, clientX: 50, clientY: 50, pointerType: 'touch' });
      // No move — pointer stays at (50,50). vec = (50-100)/50 = (-50/50) = -1.0 clamped.
      const sample = handle.backend.sample();
      expect(sample.virtualAxes).toBeDefined();
      expect(sample.virtualAxes![0].name).toBe('move');
      // dx=-50, dy=-50, raw = (-1, -1), mag = sqrt(2) > 1 → clamped to unit.
      // Normalized: (-1/sqrt(2), -1/sqrt(2)) ≈ (-0.707, -0.707)
      expect(Math.abs(sample.virtualAxes![0].x)).toBeCloseTo(0.707, 1);
      expect(Math.abs(sample.virtualAxes![0].y)).toBeCloseTo(0.707, 1);
    });

    it('fixed mode: pointerdown at (0,0) with no anchor uses region center', () => {
      const noAnchorConfig: VirtualJoystickConfig = {
        name: 'move',
        mode: 'fixed',
        region: { x: 50, y: 50, width: 100, height: 100 },
        radius: 50,
        deadzone: 0.1,
        // anchor omitted → region center = (100, 100)
      };
      const { canvas, store } = buildVJFakes();
      const handle = attachBrowserInputBackend(canvas, { virtualJoysticks: [noAnchorConfig] });

      // Pointerdown at (125, 100). Region center = (50+100/2, 50+100/2) = (100, 100).
      // Raw: (125-100)/50 = 0.5, (100-100)/50 = 0.
      store.fire('canvas', 'pointerdown', { pointerId: 1, clientX: 125, clientY: 100, pointerType: 'touch' });
      const sample = handle.backend.sample();
      expect(sample.virtualAxes).toBeDefined();
      expect(sample.virtualAxes![0].x).toBeCloseTo(0.5);
      expect(sample.virtualAxes![0].y).toBeCloseTo(0);
    });

    it('floating mode: pointerdown position becomes origin', () => {
      const { canvas, store } = buildVJFakes();
      const handle = attachBrowserInputBackend(canvas, { virtualJoysticks: [floatingConfig] });

      // Pointerdown at (350, 50) inside floating region. Origin set to pointerdown position.
      // No move: pointer still at origin → (0, 0) vector in first frame.
      store.fire('canvas', 'pointerdown', { pointerId: 1, clientX: 350, clientY: 50, pointerType: 'touch' });
      const s1 = handle.backend.sample();
      expect(s1.virtualAxes![0].x).toBeCloseTo(0);
      expect(s1.virtualAxes![0].y).toBeCloseTo(0);

      // Move to (410, 50). vec = (410-350)/60 = 1.0, y = 0.
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 410, clientY: 50, pointerType: 'touch' });
      const s2 = handle.backend.sample();
      expect(s2.virtualAxes![0].x).toBeCloseTo(1.0);
      expect(s2.virtualAxes![0].y).toBeCloseTo(0);
    });

    it('floating mode: pointerup then re-down creates new origin (re-origin)', () => {
      const { canvas, store } = buildVJFakes();
      const handle = attachBrowserInputBackend(canvas, { virtualJoysticks: [floatingConfig] });

      // First touch at (350, 50), move right, release.
      store.fire('canvas', 'pointerdown', { pointerId: 1, clientX: 350, clientY: 50, pointerType: 'touch' });
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 410, clientY: 50, pointerType: 'touch' });
      handle.backend.sample(); // consume frame 1
      store.fire('canvas', 'pointerup', { pointerId: 1, clientX: 410, clientY: 50, pointerType: 'touch' });
      handle.backend.sample(); // consume frame 2 with up

      // Second touch at (450, 100) — new origin.
      store.fire('canvas', 'pointerdown', { pointerId: 2, clientX: 450, clientY: 100, pointerType: 'touch' });
      // No move → zero vector at new origin.
      const s3 = handle.backend.sample();
      expect(s3.virtualAxes![0].x).toBeCloseTo(0);
      expect(s3.virtualAxes![0].y).toBeCloseTo(0);

      // Move right from new origin: (480, 100). vec = (480-450)/60 = 0.5.
      store.fire('canvas', 'pointermove', { pointerId: 2, clientX: 480, clientY: 100, pointerType: 'touch' });
      const s4 = handle.backend.sample();
      expect(s4.virtualAxes![0].x).toBeCloseTo(0.5);
      expect(s4.virtualAxes![0].y).toBeCloseTo(0);
    });

    it('fixed and floating origin are independent: both joysticks testable simultaneously', () => {
      const { canvas, store } = buildVJFakes();
      const handle = attachBrowserInputBackend(canvas, {
        virtualJoysticks: [fixedConfig, floatingConfig],
      });

      // Fixed: touch at (50, 50) in left region. Origin = anchor (100, 100).
      // Floating: touch at (400, 100) in right region. Origin = (400, 100).
      store.fire('canvas', 'pointerdown', {
        pointerId: 1, clientX: 50, clientY: 50, pointerType: 'touch',
      });
      store.fire('canvas', 'pointerdown', {
        pointerId: 2, clientX: 400, clientY: 100, pointerType: 'touch',
      });

      // Move finger 2 to (460, 100): vec right = (460-400)/60 = 1.0.
      store.fire('canvas', 'pointermove', {
        pointerId: 2, clientX: 460, clientY: 100, pointerType: 'touch',
      });

      const sample = handle.backend.sample();
      expect(sample.virtualAxes).toBeDefined();
      expect(sample.virtualAxes!.length).toBe(2);

      // Fixed: finger at (50,50), origin (100,100). Raw: (-50,-50)/50 = (-1,-1).
      // |raw| = sqrt(2) > 1 → clamped to unit. Normalized: (-0.707, -0.707).
      expect(sample.virtualAxes![0].name).toBe('move');
      expect(Math.abs(sample.virtualAxes![0].x)).toBeCloseTo(0.707, 1);

      // Floating: finger at (460,100), origin (400,100). vec = (60,0)/60 = (1,0).
      expect(sample.virtualAxes![1].name).toBe('look');
      expect(sample.virtualAxes![1].x).toBeCloseTo(1.0);
      expect(sample.virtualAxes![1].y).toBeCloseTo(0);
    });
  });
}
