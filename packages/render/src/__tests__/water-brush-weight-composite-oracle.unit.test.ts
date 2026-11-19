import { expect, it } from 'vitest';
import {
  waterWeightCompositionFixture as fixture,
  type WaterWeightPassObservation,
  waterWeightCompositionFailures,
} from './water-brush-weight-composite.fixture';

function capture(intermediate: number) {
  const first = [...fixture.firstEndpoints];
  first[fixture.additivePixel] = intermediate;
  const last = { label: 'weight:grass:water/b', bytes: [...fixture.finalGrass] };
  return {
    passes: [
      { label: 'weight:grass:water/a', bytes: first },
      { label: 'weight:rock:water/a', bytes: Array(15).fill(192) as number[] },
      last,
    ],
    last,
    finalGrass: [...fixture.finalGrass],
  };
}

it('accepts endpoint outputs and non-saturated A followed by additive saturation', () => {
  expect(0.375 * fixture.grassOpacity).toBe(0.75);
  for (const intermediate of [191, 192]) {
    const evidence = capture(intermediate);
    expect(intermediate / 255 + 0.75).toBeGreaterThan(1);
    expect(waterWeightCompositionFailures(evidence.passes, evidence.finalGrass)).toEqual([]);
  }
});

it.each([
  'max',
  'overwrite',
  'missing-B',
] as const)('rejects the %s production mutation', (mutation) => {
  const evidence = capture(192);
  const previous = 192 / 255;
  const wrong =
    mutation === 'max' ? Math.max(previous, 0.75) : mutation === 'overwrite' ? 0.75 : previous;
  expect(wrong).toBeLessThan(1);
  // Even the largest R8 integer above these wrong outputs cannot reach the endpoint255.
  const wrongByte = Math.ceil(wrong * 255);
  evidence.last.bytes[fixture.additivePixel] = wrongByte;
  evidence.finalGrass[fixture.additivePixel] = wrongByte;
  expect(waterWeightCompositionFailures(evidence.passes, evidence.finalGrass)).toContain(
    `B: endpoint pixel ${fixture.additivePixel}`,
  );
});

it('rejects missing A, wrong ping-pong input, wrong actor input and wrong pass order', () => {
  const missingA = capture(0);
  expect(
    waterWeightCompositionFailures(missingA.passes, missingA.finalGrass).length,
  ).toBeGreaterThan(0);
  const wrongPingPong = capture(192);
  wrongPingPong.last.bytes[0] = 0;
  wrongPingPong.finalGrass[0] = 0;
  expect(waterWeightCompositionFailures(wrongPingPong.passes, wrongPingPong.finalGrass)).toContain(
    'B: endpoint pixel 0',
  );
  const wrongActor = capture(192);
  wrongActor.last.bytes[1] = 0;
  expect(waterWeightCompositionFailures(wrongActor.passes, wrongActor.finalGrass)).toContain(
    'B: endpoint pixel 1',
  );
  const wrongOrder: WaterWeightPassObservation[] = [...capture(192).passes].reverse();
  expect(waterWeightCompositionFailures(wrongOrder, fixture.finalGrass)).toContain(
    'wrong pass order at 0',
  );
});

it('rejects clear, base, endpoint and missing-evidence mutations without a byte tolerance', () => {
  for (const pixel of [0, 1, 2, 3, 4, fixture.additivePixel]) {
    const evidence = capture(192);
    const replacement = evidence.finalGrass[pixel] === 0 ? 1 : 254;
    evidence.last.bytes[pixel] = replacement;
    evidence.finalGrass[pixel] = replacement;
    expect(
      waterWeightCompositionFailures(evidence.passes, evidence.finalGrass).length,
    ).toBeGreaterThan(0);
  }
  const missing = capture(192);
  missing.passes.pop();
  expect(waterWeightCompositionFailures(missing.passes, missing.finalGrass)).toContain(
    'wrong pass count',
  );
  for (const intermediate of [0, 127, 127.5, 255, Number.NaN]) {
    const evidence = capture(intermediate);
    expect(waterWeightCompositionFailures(evidence.passes, evidence.finalGrass)).toContain(
      'A: additive witness must be above half weight and below saturation',
    );
  }
});
