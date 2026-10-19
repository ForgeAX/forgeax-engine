import { expect, it } from 'vitest';
import { createRecognizerState, processGestureFrame } from '../gesture-recognizer';
import type { PointerPhaseEvent } from '../input-snapshot';

const pointer = { x: 0, y: 0, pointerType: 'touch' as const };
const event = (phase: PointerPhaseEvent['phase'], x = 0): PointerPhaseEvent => ({
  pointerId: 1,
  phase,
  x,
  y: 0,
  pointerType: 'touch',
  pressure: 0.5,
});

it('keeps earlier gesture snapshots usable after a later frame moves or cancels the pointer', () => {
  const pointers = new Map([[1, pointer]]);
  const down = processGestureFrame([event('down')], pointers, createRecognizerState(), 0).newState;
  const moved = processGestureFrame([event('move', 20)], pointers, down, 100).newState;
  const cancelled = processGestureFrame([event('cancel')], new Map(), moved, 200).newState;
  const original = processGestureFrame([], pointers, down, 501);
  expect(original.gestureEvents).toMatchObject([{ kind: 'long-press', pointerId: 1 }]);
  expect(processGestureFrame([], pointers, moved, 501).gestureEvents).toEqual([]);
  expect(processGestureFrame([event('up', 30)], new Map(), cancelled, 210).gestureEvents).toEqual(
    [],
  );
  const swipe = processGestureFrame([event('up', 100)], new Map(), down, 100);
  expect(swipe.gestureEvents).toMatchObject([{ kind: 'swipe', direction: 'right' }]);
});
