// gamepad-frame.ts -- pure functions for per-frame gamepad diff from raw
// navigator.getGamepads() output. No DOM dependency; only called by
// browser-backend.ts @internal.
//
// D-1: edge diff (justPressed / justReleased) derived via set-delta from
// prev vs cur pressed sets — same pattern as Bevy button_input.rs.
// D-1: slot diff (connect / disconnect) derived via set difference from
// prev vs cur slot index sets.
// OOS-4: no deadzone applied — axes pass through raw.
//
// M3 D-1 (option A): non-standard-layout gamepads are normalized at the
// acquisition layer. When a caller-supplied remapLookup returns SDL
// gamecontrollerdb.txt mapping tokens for the gamepad's id, raw HID
// button/axis indices are re-projected onto the standard layout and the
// slot is reported with standardMapping=true. No lookup / no match keeps
// the Feat1 empty-signal behaviour (graceful degradation).

import type { MappingTokens } from './controller-db';
import type { GamepadSlotSample } from './input-snapshot';

/**
 * Minimal raw Gamepad shape from browser API (no DOM types here).
 *
 * M3 F-2 seam fix: `id` mirrors the browser `Gamepad.id` string so the
 * remap lookup can derive the SDL GUID keyed by device identity (not by
 * slot index, which is unstable across reconnects).
 */
export interface RawGamepadStub {
  readonly index: number;
  readonly id: string;
  readonly connected: boolean;
  readonly mapping: string;
  readonly buttons: readonly { readonly value: number; readonly pressed: boolean }[];
  readonly axes: readonly number[];
}

/**
 * Standard layout button count (17: 0-16) and axis count (4: 0-3).
 * Non-standard gamepads without a DB match report standardMapping=false
 * and empty readpoints.
 */
const STANDARD_BUTTON_COUNT = 17;

/**
 * SDL logical name -> standard-layout button index (W3C Gamepad standard
 * mapping, KB source section 4.3). `guide` occupies the optional 17th slot.
 */
const STANDARD_BUTTON_INDEX: Readonly<Record<string, number>> = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  leftshoulder: 4,
  rightshoulder: 5,
  lefttrigger: 6,
  righttrigger: 7,
  back: 8,
  start: 9,
  leftstick: 10,
  rightstick: 11,
  dpup: 12,
  dpdown: 13,
  dpleft: 14,
  dpright: 15,
  guide: 16,
};

/** SDL logical name -> standard-layout axis index (KB source section 4.3). */
const STANDARD_AXIS_INDEX: Readonly<Record<string, number>> = {
  leftx: 0,
  lefty: 1,
  rightx: 2,
  righty: 3,
};

/** Analog trigger threshold: a trigger mapped to an axis counts as pressed above this. */
const TRIGGER_PRESS_THRESHOLD = 0.5;

interface RemappedReadpoints {
  readonly pressed: Set<number>;
  readonly buttonValues: Map<number, number>;
  readonly axes: [number, number, number, number];
}

/**
 * Re-project a non-standard raw gamepad onto the standard layout using SDL
 * mapping tokens. Browser getGamepads() exposes only buttons[] and axes[]
 * (no hats), so hat tokens (dpad-as-hat) cannot be resolved from raw data
 * and are skipped — a documented graceful degradation for the rare hat-only
 * dpad devices under the web Gamepad API.
 */
function remapToStandardLayout(gp: RawGamepadStub, tokens: MappingTokens): RemappedReadpoints {
  const pressed = new Set<number>();
  const buttonValues = new Map<number, number>();
  const axes: [number, number, number, number] = [0, 0, 0, 0];

  for (const [name, token] of Object.entries(tokens)) {
    const stdButton = STANDARD_BUTTON_INDEX[name];
    const stdAxis = STANDARD_AXIS_INDEX[name];

    if (stdButton !== undefined) {
      if (token.kind === 'button') {
        const raw = gp.buttons[token.index];
        if (raw) {
          buttonValues.set(stdButton, raw.value);
          if (raw.pressed) pressed.add(stdButton);
        }
      } else if (token.kind === 'axis') {
        // Trigger (or button) mapped to a raw axis: value = raw axis reading.
        const value = gp.axes[token.index] ?? 0;
        buttonValues.set(stdButton, value);
        if (value > TRIGGER_PRESS_THRESHOLD) pressed.add(stdButton);
      }
      // hat -> button (dpad): no hat source in the browser API; skip.
      continue;
    }

    if (stdAxis !== undefined && token.kind === 'axis') {
      const raw = gp.axes[token.index] ?? 0;
      axes[stdAxis] = token.half === '-' ? -raw : raw;
    }
  }

  return { pressed, buttonValues, axes };
}

/** Build an empty-signal slot sample for a connected non-standard pad with no mapping. */
function emptySlot(index: number): GamepadSlotSample {
  return {
    index,
    standardMapping: false,
    pressed: new Set(),
    justPressed: new Set(),
    justReleased: new Set(),
    buttonValues: new Map(),
    axes: [0, 0, 0, 0],
  };
}

/** Derive justPressed / justReleased edge sets from prev vs cur pressed sets. */
function edges(
  prevPressed: ReadonlySet<number>,
  curPressed: ReadonlySet<number>,
): { justPressed: Set<number>; justReleased: Set<number> } {
  const justPressed = new Set<number>();
  const justReleased = new Set<number>();
  for (const b of curPressed) {
    if (!prevPressed.has(b)) justPressed.add(b);
  }
  for (const b of prevPressed) {
    if (!curPressed.has(b)) justReleased.add(b);
  }
  return { justPressed, justReleased };
}

/**
 * Diff prev vs cur frames for all gamepad slots. Returns a flat
 * GamepadSlotSample[] array keyed by gamepad.index.
 *
 * - Standard-mapping slots produce GamepadSlotSample with edge sets filled
 *   from prev vs cur pressed-set delta.
 * - Non-standard slots: when `remapLookup` returns mapping tokens for the
 *   gamepad id, raw HID indices are re-projected onto the standard layout
 *   and the slot reports standardMapping=true (D-1 semantic redefinition).
 *   With no lookup or no match, the slot reports standardMapping=false with
 *   empty readpoints and connected=true (Feat1 behaviour, AC-04).
 * - Disconnected slots (in prev but not in cur) produce no entry: a slot
 *   absent from the sample reads as connected=false.
 * - Null entries in the browser getGamepads() array are skipped by the
 *   caller before calling this function.
 *
 * @param remapLookup - Optional acquisition-layer normalizer. Given a
 *   browser Gamepad.id, returns SDL mapping tokens or null. Only consulted
 *   for non-standard-mapping gamepads (D-1 option A).
 */
export function diffGamepadFrame(
  prev: ReadonlyMap<number, GamepadSlotSample>,
  curGamepads: readonly RawGamepadStub[],
  remapLookup?: (gamepadId: string) => MappingTokens | null,
): GamepadSlotSample[] {
  const results: GamepadSlotSample[] = [];

  for (const gp of curGamepads) {
    const tokens = gp.mapping === 'standard' ? undefined : remapLookup?.(gp.id);
    if (gp.mapping !== 'standard' && !tokens) {
      results.push(emptySlot(gp.index));
      continue;
    }
    const readpoints = tokens ? remapToStandardLayout(gp, tokens) : standardReadpoints(gp);
    const prevPressed = prev.get(gp.index)?.pressed ?? new Set<number>();
    results.push({
      index: gp.index,
      standardMapping: true,
      ...readpoints,
      ...edges(prevPressed, readpoints.pressed),
    });
  }

  return results;
}

/** Read standard-mapping indices without remapping or applying deadzones. */
function standardReadpoints(gp: RawGamepadStub): RemappedReadpoints {
  const curPressed = new Set<number>();
  const buttonValues = new Map<number, number>();
  const btnCount = Math.min(gp.buttons.length, STANDARD_BUTTON_COUNT);
  for (let b = 0; b < btnCount; b++) {
    const btn = gp.buttons[b];
    if (!btn) continue;
    buttonValues.set(b, btn.value);
    if (btn.pressed) curPressed.add(b);
  }
  // Axes: raw values, no deadzone (OOS-4).
  const axes: [number, number, number, number] = [
    gp.axes[0] ?? 0,
    gp.axes[1] ?? 0,
    gp.axes[2] ?? 0,
    gp.axes[3] ?? 0,
  ];
  return { pressed: curPressed, buttonValues, axes };
}
