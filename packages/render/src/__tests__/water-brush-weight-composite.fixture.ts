export type WaterWeightPassObservation = Readonly<{
  label: string | undefined;
  bytes: readonly number[];
}>;

const endpointBase = [0, 0, 255, 0, 0];
const endpointA = [0.5, 0, 0, 0.5, 0];
const endpointB = [0, 0.5, 0, 0.5, 0];
const firstEndpoints = [255, 0, 255, 255, 0];
const finalEndpoints = [255, 255, 255, 255, 0];

/** Five endpoint controls plus one non-saturated additive witness, in the original 5x3 image. */
export const waterWeightCompositionFixture = Object.freeze({
  baseGrass: [...endpointBase, ...endpointBase, ...endpointBase],
  grassA: [...endpointA, ...endpointA, 0.375, ...endpointA.slice(1)],
  grassB: [...endpointB, ...endpointB, 0.375, ...endpointB.slice(1)],
  grassOpacity: 2,
  additivePixel: 10,
  firstEndpoints: [...firstEndpoints, ...firstEndpoints, ...firstEndpoints],
  finalGrass: [...finalEndpoints, ...finalEndpoints, ...finalEndpoints],
});

function endpointFailures(
  bytes: readonly number[],
  expected: readonly number[],
  label: string,
  additiveWitness: boolean,
) {
  const failures: string[] = [];
  if (bytes.length !== expected.length) failures.push(`${label}: wrong pixel count`);
  for (let pixel = 0; pixel < expected.length; pixel++) {
    if (additiveWitness && pixel === waterWeightCompositionFixture.additivePixel) continue;
    if (bytes[pixel] !== expected[pixel]) failures.push(`${label}: endpoint pixel ${pixel}`);
  }
  return failures;
}

/**
 * Independent acceptance oracle, not a second renderer or a rounding tolerance.
 * WGSL Channel Formats uses byte/255; + and * preserve representable results.
 * The five controls therefore write only clamp endpoints 0 or 1.
 * The extra pixel writes 0.375*2 = 0.75 after A, which must remain non-saturated.
 * Read that real R8 byte back: current > 0.5 makes current + 0.75 > 1.25,
 * hence B must write255. max(current, 0.75) and overwrite0.75 stay below1.
 * No exact intermediate byte, backend-derived expected value or epsilon is used.
 */
export function waterWeightCompositionFailures(
  passes: readonly WaterWeightPassObservation[],
  finalGrass: readonly number[],
): string[] {
  const failures: string[] = [];
  const labels = ['weight:grass:water/a', 'weight:rock:water/a', 'weight:grass:water/b'];
  if (passes.length !== labels.length) failures.push('wrong pass count');
  for (let index = 0; index < labels.length; index++) {
    if (passes[index]?.label !== labels[index]) failures.push(`wrong pass order at ${index}`);
  }
  const first = passes[0]?.bytes ?? [];
  failures.push(
    ...endpointFailures(first, waterWeightCompositionFixture.firstEndpoints, 'A', true),
  );
  const intermediate = first[waterWeightCompositionFixture.additivePixel];
  // This is a semantic non-saturation and sufficient-addition gate, not +/- byte tolerance.
  if (
    intermediate === undefined ||
    !Number.isInteger(intermediate) ||
    intermediate / 255 <= 0.5 ||
    intermediate / 255 >= 1
  )
    failures.push('A: additive witness must be above half weight and below saturation');
  failures.push(...endpointFailures(passes[1]?.bytes ?? [], Array(15).fill(192), 'rock', false));
  failures.push(
    ...endpointFailures(
      passes[2]?.bytes ?? [],
      waterWeightCompositionFixture.finalGrass,
      'B',
      false,
    ),
    ...endpointFailures(finalGrass, waterWeightCompositionFixture.finalGrass, 'readback', false),
  );
  return failures;
}
