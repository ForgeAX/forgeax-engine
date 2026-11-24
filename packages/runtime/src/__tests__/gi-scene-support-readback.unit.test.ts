import { expect, it } from 'vitest';
import { sceneSupportForReceipt } from './gi-scene-support-readback.fixture';

const old = { gather: 'irradiance-field', state: 'ready', generation: 1, submittedFrames: 105 };
const unavailable = async () => {
  throw new Error('Destroyed gathered must never reach native submit');
};

it('does not look up a retired signal when a new generation has not submitted', async () => {
  const value = await sceneSupportForReceipt(
    old,
    { ...old, generation: 2, submittedFrames: 0 },
    2,
    unavailable,
  );
  expect(Array.from(value)).toEqual([0, 0, 0, -1, 0, 0, 0, -1]);
});
it('does not borrow the previous receipt without accepted producer progress', async () => {
  const value = await sceneSupportForReceipt(old, old, 1, unavailable);
  expect(Array.from(value)).toEqual([0, 0, 0, -1]);
});
it('does not treat preparation as an initialized current signal', async () => {
  const value = await sceneSupportForReceipt(
    old,
    { ...old, state: 'preparing', generation: 2, submittedFrames: 1 },
    1,
    unavailable,
  );
  expect(value[3]).toBe(-1);
});
it('keeps current physical black and its positive support unchanged', async () => {
  const black = new Float32Array([0, 0, 0, 1]);
  const value = await sceneSupportForReceipt(
    old,
    { ...old, submittedFrames: 106 },
    1,
    async () => black,
  );
  expect(value).toBe(black);
});
it('reads a genuinely accepted new generation instead of comparing counts across generations', async () => {
  const known = new Float32Array([1, 0.3, 0.7, 1]);
  expect(
    await sceneSupportForReceipt(
      old,
      { ...old, generation: 2, submittedFrames: 1 },
      1,
      async () => known,
    ),
  ).toBe(known);
});
