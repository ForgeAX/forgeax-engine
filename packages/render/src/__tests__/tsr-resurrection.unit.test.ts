import { expect, it } from 'vitest';
import {
  abortResurrection,
  commitResurrection,
  resurrectionSourceFor,
  resurrectionStoreDue,
  resurrectionStoreSlot,
  TSR_RESURRECTION_INTERVAL,
  TSR_RESURRECTION_MIN_AGE,
  type TsrResurrection,
  type TsrResurrectionSlot,
} from '../tsr/resurrection';

const surface = {} as TsrResurrectionSlot['guide'];
const slot = (): TsrResurrectionSlot => ({
  guide: surface,
  color: surface,
  stability: surface,
  viewProjection: new Float32Array(16),
  storedAt: undefined,
  inputWidth: 0,
  inputHeight: 0,
});
const ring = (): TsrResurrection => ({ slots: [slot(), slot()], frame: 0, pending: undefined });
const input = { width: 64, height: 32 };

/** One accepted frame, publishing a snapshot when the ring asks for one (the graph's store pass). */
function accept(resurrection: TsrResurrection, reset = false): boolean {
  const due = resurrectionStoreDue(resurrection, reset);
  if (due)
    resurrection.pending = {
      slot: resurrectionStoreSlot(resurrection),
      viewProjection: new Float32Array(16).fill(resurrection.frame + 1),
      inputWidth: input.width,
      inputHeight: input.height,
      reset,
    };
  commitResurrection(resurrection);
  return due;
}

it('publishes the first snapshot immediately and one per interval afterwards', () => {
  const resurrection = ring();
  const stores: number[] = [];
  for (let frame = 1; frame <= 3 * TSR_RESURRECTION_INTERVAL; frame++)
    if (accept(resurrection)) stores.push(frame);
  expect(stores).toEqual(
    [
      1,
      1 + TSR_RESURRECTION_INTERVAL,
      1 + 2 * TSR_RESURRECTION_INTERVAL,
      1 + 3 * TSR_RESURRECTION_INTERVAL,
    ].filter((frame) => frame <= 3 * TSR_RESURRECTION_INTERVAL),
  );
});

it('alternates the two slots and resurrects from the oldest snapshot only once it is old enough', () => {
  const resurrection = ring();
  accept(resurrection);
  expect(resurrectionSourceFor(resurrection, input, false)).toBeUndefined();
  for (let i = 0; i < TSR_RESURRECTION_MIN_AGE; i++) accept(resurrection);
  expect(resurrectionSourceFor(resurrection, input, false)).toBe(0);
  while (!resurrectionStoreDue(resurrection, false)) accept(resurrection);
  accept(resurrection);
  // The second snapshot went to the empty slot; the first is still the oldest and the source.
  expect(resurrection.slots.map((s) => s.storedAt !== undefined)).toEqual([true, true]);
  expect(resurrectionSourceFor(resurrection, input, false)).toBe(0);
  while (!resurrectionStoreDue(resurrection, false)) accept(resurrection);
  // The next store overwrites the source slot, so the other becomes the oldest.
  expect(resurrectionStoreSlot(resurrection)).toBe(0);
  accept(resurrection);
  expect(resurrectionSourceFor(resurrection, input, false)).toBe(1);
});

it('never resurrects across a camera cut or a changed input size and drops snapshots on a cut', () => {
  const resurrection = ring();
  for (let i = 0; i < 6; i++) accept(resurrection);
  expect(resurrectionSourceFor(resurrection, input, true)).toBeUndefined();
  expect(resurrectionSourceFor(resurrection, { width: 32, height: 32 }, false)).toBeUndefined();
  expect(accept(resurrection, true)).toBe(true);
  expect(resurrection.slots.filter((s) => s.storedAt !== undefined)).toHaveLength(1);
  expect(resurrectionSourceFor(resurrection, input, false)).toBeUndefined();
});

it('applies a staged store only when its submit is accepted', () => {
  const resurrection = ring();
  resurrection.pending = {
    slot: 0,
    viewProjection: new Float32Array(16).fill(7),
    inputWidth: 8,
    inputHeight: 8,
    reset: false,
  };
  abortResurrection(resurrection);
  commitResurrection(resurrection);
  expect(resurrection.slots[0].storedAt).toBeUndefined();
  expect(resurrection.frame).toBe(1);
});
