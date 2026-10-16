// gesture-recognizer.ts -- pure-function gesture state machines for
// forgeax-engine input (M5). Zero DOM / ECS dependencies: node-testable.
//
// charter awareness:
//   C-3 (single legal cross-frame state holder) -- the recognizer owns the
//     only sanctioned cross-frame gesture state. The browser backend stores
//     a `RecognizerState` in its closure (alongside prevGamepadFrame /
//     pointerMap / vjBindState) and threads it through `processGestureFrame`
//     every `sample()`. This module never mutates its inputs; it returns a
//     fresh `newState` the producer must store for the next frame.
//   D-3 clock decoupling -- all timers advance off the injected `now`
//     value, NOT off pointer-event arrival. An idle frame (empty phase
//     queue) still advances long-press timing, so recognition is decoupled
//     from event frequency (AC-16). The F-1 falsification test proves an
//     event-frequency-coupled impl fails.
//   D-4 dual channel -- returns continuous values (`gestureState`:
//     pinchScale / rotationAngle) plus a one-frame lifecycle event list
//     (`gestureEvents`). The backend forwards these as the optional
//     `gestures?` / `gestureEvents?` sample fields (D-4 / F1 precedent).
//   D-10 thresholds -- long-press 500ms + slop 10px, double-tap 350ms +
//     10px, swipe 0.5 px/ms over a 100ms window; exported as constants.
//   D-11 pinch/rotate -- lock the earliest two pointers, ignore a third;
//     2->1 emits end + freezes continuous values; a fresh pair emits begin
//     and resets to identity (1.0 / 0).

import type { PointerPhaseEvent, PointerType } from './input-snapshot';

// D-10 threshold defaults (LayaAir + Godot prior-art, plan-strategy section 2).
export const LONG_PRESS_DURATION_MS = 500;
export const LONG_PRESS_SLOP = 10;
export const DOUBLE_TAP_INTERVAL_MS = 350;
export const DOUBLE_TAP_DISTANCE = 10;
export const SWIPE_VELOCITY_THRESHOLD = 0.5;
export const SWIPE_WINDOW_MS = 100;

/** Swipe direction taken from the dominant displacement axis (D-10). */
const SWIPE_DIRECTIONS = ['left', 'right', 'up', 'down'] as const;
export type SwipeDirection = (typeof SWIPE_DIRECTIONS)[number];

/**
 * Continuous gesture values read each frame via `snap.gesture` (D-4).
 * Identity when no gesture is active or after a cancel/reset (AC-12):
 * pinchScale = 1.0, rotationAngle = 0.
 */
export interface GestureState {
  readonly pinchScale: number;
  readonly rotationAngle: number;
}

/**
 * Closed discriminant union of gesture lifecycle + instantaneous events
 * (AC-13). One-frame lifecycle: an event appears in exactly one frame's
 * `gestureEvents`. Every member carries `pointerType` (narrowed union,
 * AC-19) so consumers can exhaustively switch on gesture kind AND device
 * type without a default branch.
 */
export type GestureEvent =
  | {
      readonly kind: 'pinch-begin';
      readonly pointerIds: readonly [number, number];
      readonly pointerType: PointerType;
      readonly timestamp: number;
    }
  | {
      readonly kind: 'pinch-end';
      readonly pointerIds: readonly [number, number];
      readonly pointerType: PointerType;
      readonly timestamp: number;
    }
  | {
      readonly kind: 'pinch-cancel';
      readonly pointerIds: readonly [number, number];
      readonly pointerType: PointerType;
      readonly timestamp: number;
    }
  | {
      readonly kind: 'rotate-begin';
      readonly pointerIds: readonly [number, number];
      readonly pointerType: PointerType;
      readonly timestamp: number;
    }
  | {
      readonly kind: 'rotate-end';
      readonly pointerIds: readonly [number, number];
      readonly pointerType: PointerType;
      readonly timestamp: number;
    }
  | {
      readonly kind: 'rotate-cancel';
      readonly pointerIds: readonly [number, number];
      readonly pointerType: PointerType;
      readonly timestamp: number;
    }
  | {
      readonly kind: 'swipe';
      readonly pointerId: number;
      readonly direction: SwipeDirection;
      readonly pointerType: PointerType;
      readonly timestamp: number;
    }
  | {
      readonly kind: 'long-press';
      readonly pointerId: number;
      readonly x: number;
      readonly y: number;
      readonly pointerType: PointerType;
      readonly timestamp: number;
    }
  | {
      readonly kind: 'double-tap';
      readonly pointerId: number;
      readonly x: number;
      readonly y: number;
      readonly pointerType: PointerType;
      readonly timestamp: number;
    };

/** Live position + device type for a pointer (subset of the backend pointerMap entry). */
export interface RecognizerPointer {
  readonly x: number;
  readonly y: number;
  readonly pointerType: PointerType;
}

/** Locked dual-finger tracker for pinch + rotate (D-11). */
export interface PinchRotateTracker {
  readonly pointerA: number;
  readonly pointerB: number;
  readonly initialDistance: number;
  /** Previous frame's raw atan2 angle; rotation accumulates frame deltas (D-11). */
  readonly lastAngle: number;
  readonly pointerType: PointerType;
}

/** Per-pointer long-press arming state (D-10). */
export interface LongPressTracker {
  readonly downTime: number;
  readonly x: number;
  readonly y: number;
  readonly pointerType: PointerType;
  readonly armed: boolean;
  readonly fired: boolean;
}

/** Timestamped position sample for swipe velocity (D-10, 100ms window). */
export interface SwipeSample {
  readonly t: number;
  readonly x: number;
  readonly y: number;
}

/** Last recorded tap for double-tap window matching (D-10). */
export interface TapRecord {
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

/**
 * The single legal cross-frame gesture state (C-3). Immutable: each
 * `processGestureFrame` returns a fresh copy; the producer stores it for
 * the next frame. `gesture` is the current continuous value read by
 * `snap.gesture` -- live during pinch, frozen after a 2->1 end, identity
 * after cancel/reset or when no gesture ever activated.
 */
export interface RecognizerState {
  readonly pinch: PinchRotateTracker | null;
  readonly gesture: GestureState;
  readonly longPresses: ReadonlyMap<number, LongPressTracker>;
  readonly lastTap: TapRecord | null;
  readonly swipeHistory: ReadonlyMap<number, readonly SwipeSample[]>;
}

/** Result of processing one frame of phase events (D-4 dual channel). */
export interface GestureFrameResult {
  readonly newState: RecognizerState;
  readonly gestureState: GestureState;
  readonly gestureEvents: readonly GestureEvent[];
}

/** Identity continuous value (AC-12): no scale, no rotation. */
export const IDENTITY_GESTURE: GestureState = Object.freeze({ pinchScale: 1, rotationAngle: 0 });

/** Fresh recognizer state with no active gestures. */
export function createRecognizerState(): RecognizerState {
  return {
    pinch: null,
    gesture: IDENTITY_GESTURE,
    longPresses: new Map(),
    lastTap: null,
    swipeHistory: new Map(),
  };
}

// ─── pure math helpers ───────────────────────────────────────────────

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

function angleOf(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax);
}

/** Wrap an angle to (-PI, PI] so accumulated rotation never jumps a full turn. */
function normalizeAngle(a: number): number {
  let r = a;
  while (r > Math.PI) r -= 2 * Math.PI;
  while (r <= -Math.PI) r += 2 * Math.PI;
  return r;
}

function dominantDirection(dx: number, dy: number): SwipeDirection {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? SWIPE_DIRECTIONS[1] : SWIPE_DIRECTIONS[0];
  // Screen space: +y points down.
  return dy >= 0 ? SWIPE_DIRECTIONS[3] : SWIPE_DIRECTIONS[2];
}

/**
 * AC-19 real consumption path: exhaustive switch on `PointerType` with no
 * default branch. Every gesture event's `pointerType` flows through here at
 * construction, so adding a 4th `PointerType` member fails to compile
 * (the function would then be able to return `undefined`, violating its
 * `PointerType` return type). This is the sanctioned AC-19 consumption
 * proof required by plan-strategy section 7 (M5 boundary).
 */
function narrowGesturePointerType(pt: PointerType): PointerType {
  switch (pt) {
    case 'mouse':
      return 'mouse';
    case 'pen':
      return 'pen';
    case 'touch':
      return 'touch';
  }
}

// ─── mutable per-frame working context ───────────────────────────────

interface WorkContext {
  pinch: PinchRotateTracker | null;
  gesture: { pinchScale: number; rotationAngle: number };
  longPresses: Map<number, LongPressTracker>;
  lastTap: TapRecord | null;
  swipeHistory: Map<number, SwipeSample[]>;
  events: GestureEvent[];
}

function emitPinchLifecycle(
  ctx: WorkContext,
  phase: 'begin' | 'end' | 'cancel',
  tracker: PinchRotateTracker,
  now: number,
): void {
  const pointerIds: readonly [number, number] = [tracker.pointerA, tracker.pointerB];
  const pointerType = narrowGesturePointerType(tracker.pointerType);
  ctx.events.push({ kind: `pinch-${phase}`, pointerIds, pointerType, timestamp: now });
  ctx.events.push({ kind: `rotate-${phase}`, pointerIds, pointerType, timestamp: now });
}

function handleDown(ctx: WorkContext, ev: PointerPhaseEvent, now: number): void {
  // Arm a long-press timer + start a swipe velocity window + tap start.
  ctx.longPresses.set(ev.pointerId, {
    downTime: now,
    x: ev.x,
    y: ev.y,
    pointerType: ev.pointerType,
    armed: true,
    fired: false,
  });
  ctx.swipeHistory.set(ev.pointerId, [{ t: now, x: ev.x, y: ev.y }]);
}

function handleMove(ctx: WorkContext, ev: PointerPhaseEvent, now: number): void {
  // Disarm the long-press if the finger strays beyond slop (D-10).
  const lp = ctx.longPresses.get(ev.pointerId);
  if (lp?.armed && distance(lp.x, lp.y, ev.x, ev.y) > LONG_PRESS_SLOP) {
    ctx.longPresses.set(ev.pointerId, { ...lp, armed: false });
  }
  // Append to the swipe velocity window, pruning samples outside it.
  const hist = ctx.swipeHistory.get(ev.pointerId);
  if (hist) {
    hist.push({ t: now, x: ev.x, y: ev.y });
    pruneSwipeWindow(hist, now);
  }
}

function pruneSwipeWindow(hist: SwipeSample[], now: number): void {
  const cutoff = now - SWIPE_WINDOW_MS;
  // Keep at least the last sample so an up always has a reference point.
  while (hist.length > 1 && hist[0] !== undefined && hist[0].t < cutoff) {
    hist.shift();
  }
}

function detectSwipe(ctx: WorkContext, ev: PointerPhaseEvent, now: number): void {
  const hist = ctx.swipeHistory.get(ev.pointerId);
  if (!hist || hist.length === 0) return;
  const cutoff = now - SWIPE_WINDOW_MS;
  const oldest = hist.find((s) => s.t >= cutoff) ?? hist[0];
  if (!oldest) return;
  const dt = now - oldest.t;
  if (dt <= 0) return;
  const dist = distance(oldest.x, oldest.y, ev.x, ev.y);
  if (dist / dt < SWIPE_VELOCITY_THRESHOLD) return;
  ctx.events.push({
    kind: 'swipe',
    pointerId: ev.pointerId,
    direction: dominantDirection(ev.x - oldest.x, ev.y - oldest.y),
    pointerType: narrowGesturePointerType(ev.pointerType),
    timestamp: now,
  });
}

function detectDoubleTap(ctx: WorkContext, ev: PointerPhaseEvent, now: number): void {
  const prev = ctx.lastTap;
  const withinTime = prev !== null && now - prev.time <= DOUBLE_TAP_INTERVAL_MS;
  const withinDist = prev !== null && distance(prev.x, prev.y, ev.x, ev.y) <= DOUBLE_TAP_DISTANCE;
  if (prev !== null && withinTime && withinDist) {
    ctx.events.push({
      kind: 'double-tap',
      pointerId: ev.pointerId,
      x: ev.x,
      y: ev.y,
      pointerType: narrowGesturePointerType(ev.pointerType),
      timestamp: now,
    });
    ctx.lastTap = null; // consumed; a 3rd tap starts a fresh pair
    return;
  }
  ctx.lastTap = { time: now, x: ev.x, y: ev.y };
}

function endPinchIfMember(
  ctx: WorkContext,
  pointerId: number,
  phase: 'end' | 'cancel',
  now: number,
): void {
  const pinch = ctx.pinch;
  if (!pinch || (pinch.pointerA !== pointerId && pinch.pointerB !== pointerId)) return;
  emitPinchLifecycle(ctx, phase, pinch, now);
  ctx.pinch = null;
  if (phase === 'cancel') {
    // Cancel resets to identity (AC-18); end (2->1) freezes the last value (D-11).
    ctx.gesture = { pinchScale: 1, rotationAngle: 0 };
  }
}

function handleUp(ctx: WorkContext, ev: PointerPhaseEvent, now: number): void {
  detectSwipe(ctx, ev, now);
  detectDoubleTap(ctx, ev, now);
  ctx.longPresses.delete(ev.pointerId);
  ctx.swipeHistory.delete(ev.pointerId);
  endPinchIfMember(ctx, ev.pointerId, 'end', now);
}

function handleCancel(ctx: WorkContext, ev: PointerPhaseEvent, now: number): void {
  ctx.longPresses.delete(ev.pointerId);
  ctx.swipeHistory.delete(ev.pointerId);
  endPinchIfMember(ctx, ev.pointerId, 'cancel', now);
}

function tryLockPair(
  ctx: WorkContext,
  pointerMap: ReadonlyMap<number, RecognizerPointer>,
  now: number,
): void {
  if (ctx.pinch !== null || pointerMap.size < 2) return;
  // D-11: lock the earliest two pointers by ascending pointerId; a later
  // (third+) finger is ignored while the pair holds.
  const ids = [...pointerMap.keys()].sort((a, b) => a - b);
  const idA = ids[0];
  const idB = ids[1];
  if (idA === undefined || idB === undefined) return;
  const a = pointerMap.get(idA);
  const b = pointerMap.get(idB);
  if (!a || !b) return;
  ctx.pinch = {
    pointerA: idA,
    pointerB: idB,
    initialDistance: distance(a.x, a.y, b.x, b.y) || 1,
    lastAngle: angleOf(a.x, a.y, b.x, b.y),
    pointerType: a.pointerType,
  };
  ctx.gesture = { pinchScale: 1, rotationAngle: 0 };
  emitPinchLifecycle(ctx, 'begin', ctx.pinch, now);
}

function updatePinchContinuous(
  ctx: WorkContext,
  pointerMap: ReadonlyMap<number, RecognizerPointer>,
): void {
  const pinch = ctx.pinch;
  if (!pinch) return;
  const a = pointerMap.get(pinch.pointerA);
  const b = pointerMap.get(pinch.pointerB);
  if (!a || !b) return; // a member briefly absent: keep the last value
  const curDist = distance(a.x, a.y, b.x, b.y);
  const curAngle = angleOf(a.x, a.y, b.x, b.y);
  const delta = normalizeAngle(curAngle - pinch.lastAngle);
  ctx.gesture = {
    pinchScale: curDist / pinch.initialDistance,
    rotationAngle: ctx.gesture.rotationAngle + delta,
  };
  ctx.pinch = { ...pinch, lastAngle: curAngle };
}

function fireLongPresses(
  ctx: WorkContext,
  pointerMap: ReadonlyMap<number, RecognizerPointer>,
  now: number,
): void {
  const pinch = ctx.pinch;
  for (const [id, lp] of ctx.longPresses) {
    if (!lp.armed || lp.fired) continue;
    if (now - lp.downTime < LONG_PRESS_DURATION_MS) continue;
    if (!pointerMap.has(id)) continue; // finger must still be down
    // A finger locked into an active pinch pair is committed to the dual
    // gesture and must not also fire a long-press (D-11 dual-finger lock).
    if (pinch && (pinch.pointerA === id || pinch.pointerB === id)) continue;
    ctx.events.push({
      kind: 'long-press',
      pointerId: id,
      x: lp.x,
      y: lp.y,
      pointerType: narrowGesturePointerType(lp.pointerType),
      timestamp: now,
    });
    ctx.longPresses.set(id, { ...lp, fired: true });
  }
}

/**
 * Process one frame of pointer phase events, advancing all timers off
 * `now`, and return the new state + continuous values + one-frame event
 * list (D-4). Never mutates its inputs.
 */
export function processGestureFrame(
  phaseQueue: readonly PointerPhaseEvent[],
  pointerMap: ReadonlyMap<number, RecognizerPointer>,
  prevState: RecognizerState,
  now: number,
): GestureFrameResult {
  const ctx: WorkContext = {
    pinch: prevState.pinch,
    gesture: { ...prevState.gesture },
    longPresses: new Map(prevState.longPresses),
    lastTap: prevState.lastTap,
    swipeHistory: cloneSwipeHistory(prevState.swipeHistory),
    events: [],
  };

  for (const ev of phaseQueue) {
    switch (ev.phase) {
      case 'down':
        handleDown(ctx, ev, now);
        break;
      case 'move':
        handleMove(ctx, ev, now);
        break;
      case 'up':
        handleUp(ctx, ev, now);
        break;
      case 'cancel':
        handleCancel(ctx, ev, now);
        break;
    }
  }

  tryLockPair(ctx, pointerMap, now);
  updatePinchContinuous(ctx, pointerMap);
  fireLongPresses(ctx, pointerMap, now);

  const gesture: GestureState = Object.freeze({
    pinchScale: ctx.gesture.pinchScale,
    rotationAngle: ctx.gesture.rotationAngle,
  });
  const newState: RecognizerState = {
    pinch: ctx.pinch,
    gesture,
    longPresses: ctx.longPresses,
    lastTap: ctx.lastTap,
    swipeHistory: ctx.swipeHistory,
  };
  return { newState, gestureState: gesture, gestureEvents: ctx.events };
}

function cloneSwipeHistory(
  src: ReadonlyMap<number, readonly SwipeSample[]>,
): Map<number, SwipeSample[]> {
  const out = new Map<number, SwipeSample[]>();
  for (const [id, samples] of src) out.set(id, [...samples]);
  return out;
}
