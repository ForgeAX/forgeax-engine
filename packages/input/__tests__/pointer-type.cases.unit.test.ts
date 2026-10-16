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

// Split source block: M4 pointer type narrowing tests.
{
  // M4 TDD red-phase: pointerType narrowing tests.
  // plan-strategy D-5: PointerType = 'mouse' | 'pen' | 'touch'
  // plan-strategy D-5: coercePointerType('pen'→'pen', 'touch'→'touch', ''/garbage→'mouse')
  // plan-strategy E-10: inactive pointer placeholder = 'mouse', semantics by active field
  describe('m4t1: PointerType coercion + placeholder (red phase)', () => {
    /** Minimal fake canvas with listener dispatch for browser-backend tests. */
    function fakeBB(): {
      canvas: HTMLCanvasElement;
      doc: Document;
      win: Window;
      fire(target: string, kind: string, ev: Record<string, unknown>): void;
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
      const canvas = { ...makeTarget('canvas'), width: 800, height: 600, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), style: {} as CSSStyleDeclaration } as unknown as HTMLCanvasElement;
      const doc = { ...makeTarget('document'), hasFocus: () => true } as unknown as Document;
      const win = makeTarget('window') as unknown as Window;
      return {
        canvas, doc, win,
        fire(target, kind, ev) {
          for (const h of listeners.get(target)?.get(kind) ?? []) h(ev as Event);
        },
      };
    }

    it('coercePointerType: known values pass through unchanged', () => {
      expect(coercePointerType('mouse')).toBe('mouse');
      expect(coercePointerType('pen')).toBe('pen');
      expect(coercePointerType('touch')).toBe('touch');
    });

    it('coercePointerType: empty string coerced to mouse (Pointer Events spec fallback)', () => {
      expect(coercePointerType('')).toBe('mouse');
    });

    it('coercePointerType: unknown/garbage strings coerced to mouse', () => {
      expect(coercePointerType('eraser')).toBe('mouse');
      expect(coercePointerType('stylus')).toBe('mouse');
      expect(coercePointerType('coarse')).toBe('mouse');
    });

    it('coercePointerType: return type is PointerType (structural check via tsc)', () => {
      const a: PointerType = coercePointerType('mouse');
      const b: PointerType = coercePointerType('pen');
      const c: PointerType = coercePointerType('touch');
      const d: PointerType = coercePointerType('');
      const e: PointerType = coercePointerType('garbage');
      expect([a, b, c, d, e].every((v) => typeof v === 'string')).toBe(true);
    });

    it('inactive pointer placeholder: snap.pointer(nonexistentId) returns pointerType mouse + active=false', () => {
      const snap = createInputSnapshot();
      const p = snap.pointer(999);
      expect(p.active).toBe(false);
      expect(p.pointerType).toBe('mouse');
      const t: PointerType = p.pointerType;
      expect(t).toBe('mouse');
    });

    it('active pointer: real pointer down carries pointerType from backend via coercion', () => {
      const { canvas, doc, win, fire: f } = fakeBB();
      const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
      const backend = handle.backend;

      f('canvas', 'pointerdown', { button: 0, pointerType: 'pen', pointerId: 3, clientX: 10, clientY: 20 });

      const sample = backend.sample();
      const pointers = sample.pointers;
      expect(pointers).toBeDefined();
      const p = pointers!.find((x: { pointerId: number }) => x.pointerId === 3);
      expect(p).toBeDefined();
      expect(p!.pointerType).toBe('pen');
      expect(p!.active).toBe(true);

      const events = sample.pointerEvents;
      expect(events).toBeDefined();
      const ev = events!.find((x: { pointerId: number }) => x.pointerId === 3);
      expect(ev).toBeDefined();
      expect(ev!.pointerType).toBe('pen');

      handle();
    });

    it('PointerType excludes empty string (verified at type level)', () => {
      const snap = createInputSnapshot();
      expect(snap.pointer(0).pointerType).not.toBe('');
      expect(snap.pointer(0).pointerType).toBe('mouse');
    });

    it('PointerPhaseEvent carries coerced pointerType through phase queue', () => {
      const { canvas, doc, win, fire: f } = fakeBB();
      const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
      const backend = handle.backend;

      f('canvas', 'pointerdown', { button: 0, pointerType: 'touch', pointerId: 5, clientX: 30, clientY: 40 });

      const sample = backend.sample();
      const events = sample.pointerEvents;
      expect(events).toBeDefined();
      const ev = events!.find((x: { pointerId: number; phase: string }) => x.pointerId === 5 && x.phase === 'down');
      expect(ev).toBeDefined();
      expect(ev!.pointerType).toBe('touch');

      handle();
    });

    it('phase events from onPointerCancel carry coerced pointerType', () => {
      const { canvas, doc, win, fire: f } = fakeBB();
      const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
      const backend = handle.backend;

      f('canvas', 'pointerdown', { button: 0, pointerType: 'pen', pointerId: 7, clientX: 50, clientY: 60 });
      f('canvas', 'pointercancel', { pointerType: 'pen', pointerId: 7 });

      const sample = backend.sample();
      const events = sample.pointerEvents;
      const cancelEv = events?.find((x: { pointerId: number; phase: string }) => x.pointerId === 7 && x.phase === 'cancel');
      expect(cancelEv).toBeDefined();
      expect(cancelEv!.pointerType).toBe('pen');

      handle();
    });

    it('phase events from onBlur carry pointerType from pointerMap (coerced on entry)', () => {
      const { canvas, doc, win, fire: f } = fakeBB();
      const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
      const backend = handle.backend;

      f('canvas', 'pointerdown', { button: 0, pointerType: 'touch', pointerId: 9, clientX: 70, clientY: 80 });
      f('window', 'blur', {});

      const sample = backend.sample();
      const events = sample.pointerEvents;
      const cancelBlurEv = events?.find((x: { pointerId: number; phase: string }) => x.pointerId === 9 && x.phase === 'cancel');
      expect(cancelBlurEv).toBeDefined();
      expect(cancelBlurEv!.pointerType).toBe('touch');

      handle();
    });
  });
}
