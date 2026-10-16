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

// Split source block: M3 backend lazy-load and fallback tests.
{
  /** Fake nav.getGamepads() returning the supplied raw stubs each call. */
  function fakeNavigator(stubs: readonly RawGamepadStub[]): {
    getGamepads(): (RawGamepadStub | null)[];
  } {
    return { getGamepads: () => [...stubs] };
  }

  /** Minimal fake canvas/doc/win that ignore all wiring (no listeners needed). */
  function inertDom(): { canvas: HTMLCanvasElement; doc: Document; win: Window } {
    const canvas = {} as HTMLCanvasElement;
    const doc = { hasFocus: () => true } as unknown as Document;
    const win = {} as Window;
    return { canvas, doc, win };
  }

  // Synthetic DB text: the permuted non-standard pad's GUID maps 'a' -> raw
  // button 3. The pad id embeds Chrome-format VID/PID so the GUID derives.
  const NONSTD_ID = 'usb gamepad (Vendor: 0810 Product: e501)';
  const NONSTD_GUID = buildGuidFromVidPid(0x0810, 0xe501);
  const SYNTH_DB_TEXT = `# Windows\n${NONSTD_GUID},Test Pad,a:b3,b:b5,leftx:a4,platform:Windows,\n`;

  function nsStub(overrides?: { id?: string; raw?: [number, number][] }): RawGamepadStub {
    const values = new Map<number, number>(overrides?.raw ?? [[3, 1]]);
    const buttons = Array.from({ length: 20 }, (_, b) => {
      const v = values.get(b) ?? 0;
      return { value: v, pressed: v > 0 };
    });
    return {
      index: 0,
      id: overrides?.id ?? NONSTD_ID,
      connected: true,
      mapping: 'no-standard-here',
      buttons,
      axes: [0, 0, 0, 0, 0, 0],
    };
  }

  // Drain a bounded number of macrotask cycles. Used only by the negative
  // tests (Safari / XInput / standard) where no remap is ever expected --
  // draining then re-sampling proves the empty signal is stable.
  const drain = async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  // Sample until the slot flips standardMapping=true, or throw after a
  // bounded number of macrotask cycles. The backend's first non-standard
  // gamepad triggers a cold dynamic import() of the controller-db module,
  // whose resolution latency varies under concurrent-worker CPU load; a
  // fixed tick count is racy. Polling on the deterministic post-condition
  // removes the flake (each sample() re-checks the loaded-DB state).
  const sampleUntilStandard = async (
    backend: InputBackend,
    maxTicks = 200,
  ): Promise<import('../src/input-snapshot').InputBackendSample> => {
    for (let i = 0; i < maxTicks; i++) {
      const s = backend.sample();
      if (s.gamepads?.[0]?.standardMapping === true) return s;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error('DB never loaded: slot did not flip standardMapping=true within budget');
  };

  describe('backend lazy-load remap (m3t3, D-2 / D-13)', () => {
    it('first non-standard gamepad triggers loadControllerDb; later frames remap via loaded DB', async () => {
      const { canvas, doc, win } = inertDom();
      let loadCalls = 0;
      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        navigator: fakeNavigator([nsStub()]),
        loadControllerDb: async () => {
          loadCalls += 1;
          return SYNTH_DB_TEXT;
        },
      });
      const backend = handle.backend;

      // Frame 1: DB not yet loaded -> Feat1 empty signal, but load kicked off.
      const s1 = backend.sample();
      expect(s1.gamepads?.[0]?.standardMapping).toBe(false);
      expect(s1.gamepads?.[0]?.pressed.size).toBe(0);
      expect(loadCalls).toBe(1);

      // Later frame(s): DB loaded -> remap active, standard 'a' (idx 0)
      // reflects raw button 3.
      const s2 = await sampleUntilStandard(backend);
      expect(s2.gamepads?.[0]?.pressed.has(0)).toBe(true);
      // loadControllerDb is invoked once total (not per frame).
      expect(loadCalls).toBe(1);
      handle();
    });

    it('frames before load completes maintain Feat1 empty signal without crashing', async () => {
      const { canvas, doc, win } = inertDom();
      let resolveLoad: (txt: string) => void = () => {};
      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        navigator: fakeNavigator([nsStub()]),
        loadControllerDb: () => new Promise<string>((res) => (resolveLoad = res)),
      });
      const backend = handle.backend;
      // Several frames while the load promise is still pending.
      for (let i = 0; i < 3; i++) {
        const s = backend.sample();
        expect(s.gamepads?.[0]?.standardMapping).toBe(false);
        expect(s.gamepads?.[0]?.pressed.size).toBe(0);
      }
      // Complete the load; a later frame should remap.
      resolveLoad(SYNTH_DB_TEXT);
      const sAfter = await sampleUntilStandard(backend);
      expect(sAfter.gamepads?.[0]?.standardMapping).toBe(true);
      handle();
    });

    it('injected loadControllerDb override is used for remap (D-13 test injection)', async () => {
      const { canvas, doc, win } = inertDom();
      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        navigator: fakeNavigator([nsStub({ raw: [[5, 1]] })]),
        loadControllerDb: async () => SYNTH_DB_TEXT,
      });
      const backend = handle.backend;
      const s2 = await sampleUntilStandard(backend);
      // raw button 5 -> standard 'b' (index 1).
      expect(s2.gamepads?.[0]?.pressed.has(1)).toBe(true);
      handle();
    });

    it('Safari / name-only gamepad id: GUID unextractable, no DB lookup, stays empty', async () => {
      const { canvas, doc, win } = inertDom();
      let loadCalls = 0;
      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        navigator: fakeNavigator([nsStub({ id: 'Wireless Controller' })]),
        loadControllerDb: async () => {
          loadCalls += 1;
          return SYNTH_DB_TEXT;
        },
      });
      const backend = handle.backend;
      backend.sample();
      await drain();
      const s2 = backend.sample();
      expect(s2.gamepads?.[0]?.standardMapping).toBe(false);
      // A name-only id may still trigger a load attempt, but the GUID never
      // resolves so remap never surfaces; the key guarantee is empty signal.
      expect(s2.gamepads?.[0]?.pressed.size).toBe(0);
      expect(loadCalls).toBeLessThanOrEqual(1);
      handle();
    });

    it('XInput gamepad id: GUID unextractable, stays empty (R-3 fallback)', async () => {
      const { canvas, doc, win } = inertDom();
      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        navigator: fakeNavigator([nsStub({ id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)' })]),
        loadControllerDb: async () => SYNTH_DB_TEXT,
      });
      const backend = handle.backend;
      backend.sample();
      await drain();
      const s2 = backend.sample();
      expect(s2.gamepads?.[0]?.standardMapping).toBe(false);
      expect(s2.gamepads?.[0]?.pressed.size).toBe(0);
      handle();
    });

    it('standard-mapping gamepad never triggers a DB load (C-5 lazy trigger)', async () => {
      const { canvas, doc, win } = inertDom();
      let loadCalls = 0;
      const stdPad: RawGamepadStub = {
        index: 0,
        id: 'standard pad',
        connected: true,
        mapping: 'standard',
        buttons: Array.from({ length: 17 }, (_, b) => ({ value: b === 0 ? 1 : 0, pressed: b === 0 })),
        axes: [0, 0, 0, 0],
      };
      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        navigator: fakeNavigator([stdPad]),
        loadControllerDb: async () => {
          loadCalls += 1;
          return SYNTH_DB_TEXT;
        },
      });
      const backend = handle.backend;
      backend.sample();
      await drain();
      backend.sample();
      expect(loadCalls).toBe(0);
      handle();
    });
  });
  describe('backend gamepad disconnect', () => {
    it('an idle standard pad that disconnects reads connected=false', () => {
      const { canvas, doc, win } = inertDom();
      const pads: RawGamepadStub[] = [
        {
          index: 0,
          id: 'standard pad',
          connected: true,
          mapping: 'standard',
          buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
          axes: [0, 0, 0, 0],
        },
      ];
      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        navigator: { getGamepads: () => [...pads] },
      });
      const backend = handle.backend;
      expect(snapshotFromSample(backend.sample()).gamepad(0).connected).toBe(true);
      const [pad] = pads;
      if (!pad) throw new Error('pad fixture missing');
      pads[0] = { ...pad, connected: false };
      expect(snapshotFromSample(backend.sample()).gamepad(0).connected).toBe(false);
      pads.length = 0;
      expect(snapshotFromSample(backend.sample()).gamepad(0).connected).toBe(false);
      handle();
    });
  });
}
